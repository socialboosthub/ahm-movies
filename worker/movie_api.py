import os,re,json,time,uuid,asyncio,subprocess,tempfile,shutil,traceback
from pathlib import Path
from threading import Lock
from typing import Any
import boto3,httpx,requests,edge_tts
from fastapi import FastAPI,Header,HTTPException
from faster_whisper import WhisperModel

app=FastAPI(title="AHM Movies Recap Worker",version="1.0.0")
JOBS:dict[str,dict[str,Any]]={}
LOCK=Lock()
MODEL=None

def auth(token):
 expected=os.getenv("RECAP_WORKER_TOKEN","")
 if not expected or token!=expected: raise HTTPException(401,"Unauthorized worker request.")
def save_job(job_id, job):
 body=json.dumps(job,ensure_ascii=False).encode("utf-8")
 try:
  store().put_object(Bucket=os.environ["R2_BUCKET"],Key=f"jobs/{job_id}.json",Body=body,ContentType="application/json")
 except Exception as exc:
  print("JOB_STATE_SAVE_FAILED",job_id,type(exc).__name__,str(exc)[:500],flush=True)
  raise RuntimeError(f"Could not save job state to R2: {type(exc).__name__}: {str(exc)[:300]}") from exc
def load_job(job_id,refresh=False):
 if not refresh:
  with LOCK:
   cached=JOBS.get(job_id)
  if cached:return cached
 try:
  obj=store().get_object(Bucket=os.environ["R2_BUCKET"],Key=f"jobs/{job_id}.json")
  job=json.loads(obj["Body"].read().decode("utf-8"))
  with LOCK:JOBS[job_id]=job
  return job
 except Exception as exc:
  print("JOB_STATE_LOAD_FAILED",job_id,type(exc).__name__,str(exc)[:500],flush=True)
  raise RuntimeError(f"Could not load job state from R2: {type(exc).__name__}: {str(exc)[:300]}") from exc
def update(job_id,**values):
 with LOCK:
  if job_id in JOBS:
   JOBS[job_id].update(values)
   snapshot=dict(JOBS[job_id])
  else:snapshot=None
 if snapshot:save_job(job_id,snapshot)
def run(cmd):
 r=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 if r.returncode:raise RuntimeError((r.stderr or r.stdout)[-2200:])
 return r.stdout
def store():
 required=["R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET"]
 missing=[name for name in required if not os.getenv(name) or not os.getenv(name).strip()]
 if missing:
  raise RuntimeError("R2 storage environment is incomplete: "+", ".join(missing))
 # Accept either the bare Cloudflare account ID or its R2 endpoint/hostname.
 # This avoids botocore ValueError when a dashboard URL was pasted into the ID field.
 account=os.environ["R2_ACCOUNT_ID"].strip()
 account=account.removeprefix("https://").removeprefix("http://").strip("/")
 account=account.removesuffix(".r2.cloudflarestorage.com")
 if "/" in account:
  account=account.split("/",1)[0]
 if not re.fullmatch(r"[a-fA-F0-9]{32}",account):
  raise RuntimeError("R2_ACCOUNT_ID must be the 32-character Cloudflare account ID (not an API token or bucket URL).")
 return boto3.client(
  "s3",
  endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
  aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"].strip(),
  aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"].strip(),
  region_name="auto",
 )
def whisper():
 global MODEL
 if MODEL is None:MODEL=WhisperModel(os.getenv("WHISPER_MODEL","small"),device=os.getenv("WHISPER_DEVICE","cpu"),compute_type=os.getenv("WHISPER_COMPUTE_TYPE","int8"))
 return MODEL
def transcribe(path,words=False):
 segments,info=whisper().transcribe(str(path),beam_size=3,vad_filter=True,word_timestamps=words)
 out=[]
 for s in segments:
  row={"start":float(s.start),"end":float(s.end),"text":s.text.strip()}
  if words:row["words"]=[{"word":w.word.strip(),"start":float(w.start),"end":float(w.end)} for w in (s.words or []) if w.word.strip()]
  out.append(row)
 return out,info.language
async def transcribe_movie(path,duration,job_id):
 key=os.getenv("GROQ_API_KEY","")
 if not key or os.getenv("TRANSCRIBE_PROVIDER","groq").lower()=="local":
  return transcribe(path)
 chunk_seconds=600
 starts=list(range(0,int(duration),chunk_seconds))
 if not starts:starts=[0]
 chunk_dir=path.parent/"groq-audio-chunks";chunk_dir.mkdir(parents=True,exist_ok=True)
 rows=[];detected="unknown"
 url=os.getenv("LLM_BASE_URL","https://api.groq.com/openai/v1").rstrip("/")+"/audio/transcriptions"
 def send_transcription(chunk,data):
  with chunk.open("rb") as audio_file:
   return requests.post(url,headers={"Authorization":f"Bearer {key}"},data=data,files={"file":(chunk.name,audio_file,"audio/mpeg")},timeout=(30,300))
 try:
  for index,start in enumerate(starts):
   chunk=chunk_dir/f"audio_{index:03}.mp3"
   length=min(chunk_seconds,duration-start)
   run(["ffmpeg","-y","-ss",str(start),"-t",str(length),"-i",str(path),"-vn","-ac","1","-ar","16000","-b:a","48k",str(chunk)])
   data=[("model","whisper-large-v3-turbo"),("response_format","verbose_json"),("timestamp_granularities[]","segment"),("temperature","0")]
   for attempt in range(6):
    response=await asyncio.to_thread(send_transcription,chunk,data)
    if response.status_code in (429,500,502,503,504) and attempt<5:
     retry=response.headers.get("retry-after")
     try:delay=max(1,min(60,float(retry))) if retry else min(30,2**attempt*2)
     except ValueError:delay=min(30,2**attempt*2)
     await asyncio.sleep(delay)
     continue
    response.raise_for_status()
    result=response.json()
    detected=result.get("language",detected)
    for segment in result.get("segments",[]):
     text_value=str(segment.get("text","")).strip()
     if not text_value:continue
     a=max(0.0,start+float(segment.get("start",0)))
     b=min(duration,start+float(segment.get("end",0)))
     if b>a:rows.append({"start":a,"end":b,"text":text_value})
    break
   else:raise RuntimeError("Groq transcription retry limit reached.")
   update(job_id,stage=f"Transcribing full movie · audio section {index+1}/{len(starts)}",progress=12+int((index+1)/len(starts)*20))
  if len(rows)>=5:
   rows.sort(key=lambda item:item["start"])
   return rows,detected
  raise RuntimeError("Groq returned too little movie dialogue.")
 except Exception as error:
  update(job_id,stage="Remote transcription unavailable · using local Whisper",progress=12)
  print("GROQ_TRANSCRIPTION_FALLBACK",job_id,type(error).__name__,str(error)[:1200],flush=True)
  traceback.print_exc()
  update(job_id,stage="Using local Whisper transcription",progress=12)
  return transcribe(path)
async def ask(prompt,system="You are a faithful movie-story analyst. Never invent events.",schema_name="movie_section",schema=None):
 key=os.getenv("GROQ_API_KEY")
 if not key:raise RuntimeError("GROQ_API_KEY is missing from the worker environment.")
 url=os.getenv("LLM_BASE_URL","https://api.groq.com/openai/v1").rstrip("/")+"/chat/completions"
 model=os.getenv("LLM_MODEL","openai/gpt-oss-20b")
 # Use JSON Object Mode instead of Groq schema validation. This avoids the
 # recurring json_validate_failed 400 while keeping strict local validation.
 json_prompt=prompt+"\n\nOUTPUT REQUIREMENT: Return exactly one valid JSON object. Do not use markdown fences, comments, or text before or after the JSON."
 payload={"model":model,"temperature":0.2,"max_completion_tokens":8192,"response_format":{"type":"json_object"},"reasoning_format":"hidden","messages":[{"role":"system","content":system+" Respond only with one valid JSON object. Do not include markdown."},{"role":"user","content":json_prompt}]}
 if model.startswith("openai/gpt-oss/") or model.startswith("openai/gpt-oss-"):
  payload["reasoning_effort"]=os.getenv("LLM_REASONING_EFFORT","medium")
 async with httpx.AsyncClient(timeout=240) as client:
  last_error=None
  for attempt in range(3):
   try:
    r=await client.post(url,headers={"Authorization":f"Bearer {key}"},json=payload)
    if r.status_code == 400:
     detail=r.text[:1600]
     print("GROQ_CHAT_COMPLETION_BAD_REQUEST",model,detail,flush=True)
     raise RuntimeError(f"Groq rejected the JSON-mode recap request (HTTP 400): {detail}")
    if r.status_code in (429,500,502,503,504) and attempt<2:
     retry=r.headers.get("retry-after")
     try:delay=max(1,min(60,float(retry))) if retry else min(30,2**attempt*2)
     except ValueError:delay=min(30,2**attempt*2)
     await asyncio.sleep(delay)
     continue
    r.raise_for_status()
    message=r.json()["choices"][0]["message"]
    raw=(message.get("content") or "").strip()
    if raw.startswith("```"):raw="\n".join(line for line in raw.splitlines() if not line.strip().startswith("```"))
    if not raw:raise ValueError("Groq returned an empty JSON response.")
    parsed=json.loads(raw)
    if not isinstance(parsed,dict):raise ValueError("Groq JSON response was not an object.")
    return parsed
   except (json.JSONDecodeError,ValueError) as exc:
    last_error=exc
    print("GROQ_JSON_PARSE_RETRY",schema_name,attempt+1,str(exc)[:500],flush=True)
    payload["messages"][1]["content"]=json_prompt+"\n\nYour previous response was invalid. Return a complete JSON object with the required keys. No extra text."
   except httpx.RequestError:
    if attempt>=2:raise
    await asyncio.sleep(min(30,2**attempt*2))
  raise RuntimeError(f"Groq did not return valid JSON after 3 attempts: {last_error}")
async def plan_recap(rows,duration,settings):
 chunks=[];buf=[];size=0
 for row in rows:
  line=f"[{row['start']:.1f}-{row['end']:.1f}] {row['text']}"
  if size+len(line)>9500 and buf:chunks.append("\n".join(buf));buf=[];size=0
  buf.append(line);size+=len(line)
 if buf:chunks.append("\n".join(buf))
 evidence=[]
 for i,chunk in enumerate(chunks):
  section_schema={"type":"object","properties":{"summary":{"type":"string"},"events":{"type":"array","items":{"type":"object","properties":{"timestamp":{"type":"number"},"event":{"type":"string"},"characters":{"type":"array","items":{"type":"string"}}},"required":["timestamp","event","characters"],"additionalProperties":False}}},"required":["summary","events"],"additionalProperties":False}
  data=await ask(f"Summarize chronological section {i+1}/{len(chunks)} of this {duration/60:.1f}-minute movie. Preserve names, causes, motives, reveals and ending clues. Do not invent. Return the summary and timestamped events with character names.\n{chunk}",schema_name="movie_section",schema=section_schema)
  evidence.append(data)
 ending_rows=rows[-max(12,min(40,len(rows))):]
 ending_text="\n".join(f"[{x['start']:.1f}-{x['end']:.1f}] {x['text']}" for x in ending_rows)
 prompt=f"""Create a faithful complete movie recap from this evidence covering the WHOLE movie through its actual ending. Target {settings.get('targetMinutes',5.5)} minutes, about 700-850 spoken words, 24-30 narration segments. Return JSON {{"title":"...","segments":[{{"part":1,"narration":"2-3 natural sentences","source_start":10,"source_end":24,"visual":"specific visible action","event":"plot event"}}]}}. Part 1 is setup and hook; part 2 escalation and turning point; part 3 climax, resolution and complete ending. Divide the story into three naturally balanced episodes, about one third of the narration per part, with meaningful cliffhangers at the end of parts 1 and 2. Do not withhold the ending for suspense. The LAST TWO segments must cover the actual resolution using the final-movie evidence below; the final segment must select footage from the actual final dialogue or ending sequence, not unrelated end credits. All source times must be grounded in event timestamps, within 0..{duration:.1f}, and windows 5-25 seconds. Each visual must describe footage likely visible at that time. Language: {settings.get('language','English')}. Evidence: {json.dumps(evidence,ensure_ascii=False)}. FINAL MOVIE EVIDENCE (must guide the ending): {ending_text}"""
 recap_schema={"type":"object","properties":{"title":{"type":"string"},"segments":{"type":"array","items":{"type":"object","properties":{"part":{"type":"integer","enum":[1,2,3]},"narration":{"type":"string"},"source_start":{"type":"number"},"source_end":{"type":"number"},"visual":{"type":"string"},"event":{"type":"string"}},"required":["part","narration","source_start","source_end","visual","event"],"additionalProperties":False}}},"required":["title","segments"],"additionalProperties":False}
 result=await ask(prompt,"You are an expert movie recap editor. Preserve plot truth, maintain chronological continuity and include the entire ending. Return only the requested structured data.",schema_name="movie_recap",schema=recap_schema)
 segments=result.get("segments",[])
 valid=[]
 for x in segments:
  try:p=int(x.get("part",1));a=float(x["source_start"]);b=float(x["source_end"])
  except Exception:continue
  if p in (1,2,3) and 0<=a<duration and a<b:
   x["part"]=p;x["source_start"]=a;x["source_end"]=min(duration,max(a+min(5,duration-a),min(b,a+25)));valid.append(x)
 if len(valid)<12:raise RuntimeError("The recap model did not return enough valid source-timestamped scenes. Retry the job.")
 valid.sort(key=lambda x:(x["part"],x["source_start"]))
 counts={p:sum(1 for x in valid if x["part"]==p) for p in (1,2,3)}
 if any(counts[p]<3 for p in (1,2,3)):
  raise RuntimeError("The recap plan did not create three complete story parts. Retry the job.")
 # Anchor the final shot to the last spoken story evidence, avoiding unrelated end credits.
 ending=max((x for x in valid if x["part"]==3),key=lambda x:x["source_start"])
 ending_anchor=float(rows[-1]["start"]) if rows else duration
 if ending["source_start"] < max(0,duration-180):
  ending_start=max(0,min(duration-5,ending_anchor-12))
  ending["source_start"]=ending_start
  ending["source_end"]=min(duration,ending_start+25)
 return {"title":result.get("title","Movie Recap"),"segments":valid}

def stamp(t):
 ms=max(0,int(t*1000));h=ms//3600000;ms%=3600000;m=ms//60000;ms%=60000;s=ms//1000;ms%=1000
 return f"{h:02}:{m:02}:{s:02},{ms:03}"
async def tts(text,voice,pace,path):
 rate=f"{int((pace-1)*100):+d}%"
 await edge_tts.Communicate(text,voice=voice,rate=rate).save(str(path))
def subtitles(audio,text,path):
 rows,_=transcribe(audio,True);words=[w for s in rows for w in s.get("words",[])]
 if not words:
  tokens=text.split();dur=float(run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",str(audio)]).strip())
  words=[{"word":w,"start":i*dur/max(1,len(tokens)),"end":(i+1)*dur/max(1,len(tokens))} for i,w in enumerate(tokens)]
 blocks=[]
 for i in range(0,len(words),4):
  group=words[i:i+4];phrase=" ".join(w["word"] for w in group).upper()
  blocks.append(f"{len(blocks)+1}\n{stamp(group[0]['start'])} --> {stamp(max(group[0]['start']+.2,group[-1]['end']))}\n{phrase}\n")
 path.write_text("\n".join(blocks),encoding="utf-8")
def render(movie,audio,srt,start,end,out,has_source_audio=True):
 clip_duration=max(1.0,end-start)
 vf="scale=1080:1440:force_original_aspect_ratio=increase,crop=1080:1440,fps=30,tpad=stop_mode=clone:stop_duration=90,subtitles="+str(srt).replace(":","\\:")+":force_style='FontName=DejaVu Sans,FontSize=46,Bold=1,Italic=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=4,Shadow=2,Alignment=2,MarginV=170,WrapStyle=2,Spacing=1'"
 cmd=["ffmpeg","-y","-ss",str(start),"-t",str(clip_duration),"-i",str(movie),"-i",str(audio),"-vf",vf]
 if has_source_audio:
  mix="[0:a:0]volume=0.12,aresample=48000[film];[1:a:0]volume=1.0,aresample=48000[voice];[voice][film]amix=inputs=2:duration=first:dropout_transition=1,loudnorm=I=-16:TP=-1.5[aout]"
  cmd += ["-filter_complex",mix,"-map","0:v:0","-map","[aout]"]
 else:
  cmd += ["-map","0:v:0","-map","1:a:0"]
 cmd += ["-c:v","libx264","-preset",os.getenv("FFMPEG_PRESET","veryfast"),"-crf","22","-pix_fmt","yuv420p","-r","30","-c:a","aac","-b:a","192k","-shortest","-movflags","+faststart",str(out)]
 run(cmd)

def download_url(s3,key):
 return s3.generate_presigned_url("get_object",Params={"Bucket":os.environ["R2_BUCKET"],"Key":key},ExpiresIn=604800)
async def process(job_id,payload):
 tmp=Path(tempfile.mkdtemp(prefix="ahm-recap-"))
 try:
  s3=store();settings=payload.get("settings",{});movie=tmp/"movie"
  update(job_id,status="running",stage="Downloading original movie",progress=2)
  s3.download_file(os.environ["R2_BUCKET"],payload["object_key"],str(movie))
  probe=json.loads(run(["ffprobe","-v","error","-show_entries","format=duration:stream=codec_type","-of","json",str(movie)]));duration=float(probe["format"]["duration"])
  has_source_audio=any(stream.get("codec_type")=="audio" for stream in probe.get("streams",[]))
  if duration<60:raise RuntimeError("The uploaded file is too short to be a full movie.")
  if duration>14400:raise RuntimeError("The current maximum movie length is four hours.")
  audio=tmp/"full_audio.wav";update(job_id,stage="Extracting complete movie audio",progress=7)
  run(["ffmpeg","-y","-i",str(movie),"-vn","-ac","1","-ar","16000","-c:a","pcm_s16le",str(audio)])
  update(job_id,stage="Transcribing the entire movie",progress=12)
  transcript,detected=await transcribe_movie(audio,duration,job_id)
  if len(transcript)<5:raise RuntimeError("Not enough dialogue was detected to analyse the movie.")
  update(job_id,stage="Analysing characters, twists and the ending",progress=36,transcript_segments=len(transcript),detected_language=detected)
  recap=await plan_recap(transcript,duration,settings)
  (tmp/"recap_script.json").write_text(json.dumps(recap,ensure_ascii=False,indent=2),encoding="utf-8")
  clips={1:[],2:[],3:[]};durations={1:0,2:0,3:0};total=len(recap["segments"])
  for i,scene in enumerate(recap["segments"]):
   narration=str(scene.get("narration","")).strip()
   if not narration:continue
   voice=settings.get("voice","en-US-AndrewNeural")
   if settings.get("language")=="Kiswahili" and not voice.startswith("sw-"):voice="sw-KE-RafikiNeural"
   audio_file=tmp/f"voice_{i:03}.mp3";srt=tmp/f"subs_{i:03}.srt";clip=tmp/f"clip_{i:03}.mp4"
   await tts(narration,voice,float(settings.get("pace",1)),audio_file)
   subtitles(audio_file,narration,srt)
   voice_seconds=float(run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",str(audio_file)]).strip())
   clip_start=float(scene["source_start"]);clip_end=float(scene["source_end"])
   needed=voice_seconds+0.25
   if clip_end-clip_start<needed:
    clip_end=min(duration,clip_start+needed)
    if clip_end-clip_start<needed:clip_start=max(0,clip_end-needed)
   render(movie,audio_file,srt,clip_start,clip_end,clip,has_source_audio)
   part=int(scene["part"]);clips[part].append(clip)
   durations[part]+=float(run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",str(clip)]).strip())
   update(job_id,stage=f"Editing original footage · scene {i+1}/{total}",progress=45+int((i+1)/total*48))
  episodes=[]
  for part in (1,2,3):
   if not clips[part]:raise RuntimeError(f"Episode {part} has no footage.")
   listing=tmp/f"concat_{part}.txt"
   listing.write_text("".join("file '"+str(p)+"'\n" for p in clips[part]),encoding="utf-8")
   out=tmp/f"AHM_Movies_Part_{part}.mp4"
   run(["ffmpeg","-y","-f","concat","-safe","0","-i",str(listing),"-c","copy","-movflags","+faststart",str(out)])
   key=f"exports/{job_id}/AHM_Movies_Part_{part}.mp4"
   qc=json.loads(run(["ffprobe","-v","error","-show_entries","format=duration:stream=codec_type,width,height","-of","json",str(out)]))
   video_stream=next((x for x in qc.get("streams",[]) if x.get("codec_type")=="video"),None)
   audio_stream=next((x for x in qc.get("streams",[]) if x.get("codec_type")=="audio"),None)
   if not video_stream or not audio_stream or video_stream.get("width")!=1080 or video_stream.get("height")!=1440:
    raise RuntimeError(f"Part {part} failed final video/audio/resolution quality checks.")
   seconds=int(float(qc["format"]["duration"]))
   if seconds<20:raise RuntimeError(f"Part {part} is unexpectedly short; refusing to export an incomplete episode.")
   s3.upload_file(str(out),os.environ["R2_BUCKET"],key,ExtraArgs={"ContentType":"video/mp4"})
   episodes.append({"title":f"Part {part}","part":part,"duration":f"{seconds//60}:{seconds%60:02}","download_url":download_url(s3,key)})
  update(job_id,status="completed",stage="Three recap episodes ready",progress=100,episodes=episodes,recap_script=recap)
 except Exception as exc:
  print("AHM_JOB_PROCESSING_FAILED",job_id,type(exc).__name__,str(exc)[:1200],flush=True)
  traceback.print_exc()
  try:
   update(job_id,status="failed",stage="Processing failed",error=f"{type(exc).__name__}: {str(exc)}"[:1200])
  except Exception as state_exc:
   print("AHM_JOB_FAILURE_STATE_SAVE_FAILED",job_id,type(state_exc).__name__,str(state_exc)[:1200],flush=True)
   traceback.print_exc()
 finally:
  shutil.rmtree(tmp,ignore_errors=True)
@app.get("/health")
def health():
 return {"ok":True,"service":"ahm-movies-worker","storage_configured":all(os.getenv(x) for x in ["R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET"]),"llm_configured":bool(os.getenv("GROQ_API_KEY"))}
@app.post("/jobs")
async def create(payload:dict,x_ahm_worker_token:str|None=Header(default=None)):
 auth(x_ahm_worker_token)
 if not str(payload.get("object_key","")).startswith("incoming/"):raise HTTPException(400,"Invalid movie object key.")
 jid=uuid.uuid4().hex
 job={"id":jid,"status":"queued","stage":"Waiting for worker","progress":0,"created_at":time.time()}
 with LOCK:JOBS[jid]=job
 save_job(jid,job)
 dispatcher=getattr(app.state,"dispatch_job",None)
 if dispatcher is not None:
  try:dispatcher(jid,payload)
  except Exception as exc:
   update(jid,status="failed",stage="Could not queue processing job",error=str(exc)[:800])
   raise HTTPException(503,"The movie processing queue is temporarily unavailable.")
 else:
  # Local-development fallback only. Modal deployments always use a separate durable function.
  asyncio.create_task(process(jid,payload))
 return {"id":jid,"status":"queued","stage":"Waiting for worker","progress":0}
@app.get("/jobs/{job_id}")
def get_job(job_id:str,x_ahm_worker_token:str|None=Header(default=None)):
 auth(x_ahm_worker_token)
 job=load_job(job_id,refresh=True)
 if not job:raise HTTPException(404,"Job not found.")
 return job
