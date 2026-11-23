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
async def ask(prompt,system="You are a faithful movie-story analyst. Never invent events.",schema_name="movie_section",schema=None,max_completion_tokens=2048):
 key=os.getenv("GROQ_API_KEY")
 if not key:raise RuntimeError("GROQ_API_KEY is missing from the worker environment.")
 url=os.getenv("LLM_BASE_URL","https://api.groq.com/openai/v1").rstrip("/")+"/chat/completions"
 primary=os.getenv("LLM_MODEL","openai/gpt-oss-20b").strip()
 if not schema:raise RuntimeError("A strict JSON schema is required for recap generation.")
 # GPT-OSS is the primary model. If Groq returns its opaque JSON validation
 # failure, retry the same request once with Groq's other documented strict
 # structured-output family rather than failing the entire movie job.
 models=[primary]
 fallback=os.getenv("LLM_FALLBACK_MODEL","qwen/qwen3.8-27b").strip()
 if fallback and fallback not in models:models.append(fallback)
 last_error=None
 async with httpx.AsyncClient(timeout=300) as client:
  for model_index,model in enumerate(models):
   payload={"model":model,"temperature":0.2,"max_completion_tokens":max(512,min(4096,int(max_completion_tokens))),"response_format":{"type":"json_schema","json_schema":{"name":schema_name,"strict":True,"schema":schema}},"reasoning_format":"hidden","messages":[{"role":"system","content":system+" Follow the supplied JSON schema exactly. Do not add commentary."},{"role":"user","content":prompt}]}
   if model.startswith("openai/gpt-oss-") or model.startswith("openai/gpt-oss/"):
    payload["reasoning_effort"]=os.getenv("LLM_REASONING_EFFORT","medium")
   elif model.startswith("qwen/"):
    payload["reasoning_effort"]=os.getenv("LLM_FALLBACK_REASONING_EFFORT","none")
   for attempt in range(4):
    try:
     r=await client.post(url,headers={"Authorization":f"Bearer {key}"},json=payload)
     if r.status_code == 400:
      detail=r.text[:1600]
      print("GROQ_STRUCTURED_OUTPUT_BAD_REQUEST",model,schema_name,"attempt",attempt+1,detail,flush=True)
      last_error=RuntimeError(f"Groq rejected structured recap generation with {model} (HTTP 400): {detail}")
      # A 400 is not transient. Move to the alternate supported model.
      break
     if r.status_code in (429,500,502,503,504) and attempt<3:
      retry=r.headers.get("retry-after")
      try:delay=max(1,min(60,float(retry))) if retry else min(30,2**attempt*2)
      except ValueError:delay=min(30,2**attempt*2)
      await asyncio.sleep(delay)
      continue
     r.raise_for_status()
     message=r.json()["choices"][0]["message"]
     raw=(message.get("content") or "").strip()
     if not raw:raise RuntimeError(f"Groq returned an empty structured recap from {model}.")
     parsed=json.loads(raw)
     if not isinstance(parsed,dict):raise ValueError("Groq structured response was not a JSON object.")
     print("GROQ_STRUCTURED_OUTPUT_SUCCESS",model,schema_name,flush=True)
     return parsed
    except httpx.RequestError as exc:
     if attempt>=3:
      last_error=exc
      break
     await asyncio.sleep(min(30,2**attempt*2))
   if model_index+1<len(models):
    print("GROQ_SWITCHING_STRUCTURED_OUTPUT_MODEL",model,"to",models[model_index+1],schema_name,flush=True)
 if last_error:raise last_error
 raise RuntimeError("Groq is temporarily unavailable after structured-output retries.")

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
  data=await ask(f"Summarize chronological section {i+1}/{len(chunks)} of this {duration/60:.1f}-minute movie. Preserve names, causes, motives, reveals and ending clues. Do not invent. Keep the summary under 70 words and return no more than 3 important timestamped events with character names.\n{chunk}",schema_name="movie_section",schema=section_schema,max_completion_tokens=1100)
  # Keep the final synthesis request compact even for feature-length movies.
  compact_events=[]
  for event in data.get("events",[])[:3]:
   compact_events.append({"timestamp":event.get("timestamp"),"event":str(event.get("event",""))[:160],"characters":event.get("characters",[])[:5]})
  evidence.append({"summary":str(data.get("summary",""))[:420],"events":compact_events})
 ending_rows=rows[-max(10,min(16,len(rows))):]
 ending_text="\n".join(f"[{x['start']:.1f}-{x['end']:.1f}] {x['text']}" for x in ending_rows)
 prompt=f"""Create a faithful complete movie recap from this evidence covering the WHOLE movie through its actual ending. Target {settings.get('targetMinutes',5.5)} minutes, about 650-800 spoken words, 18-21 narration segments. Return the title FIRST, then the segments, in this exact JSON shape: {{"title":"Movie title","segments":[{{"part":1,"narration":"2 concise natural sentences","source_start":10,"source_end":24,"visual":"short specific visible action","event":"short plot event"}}]}}. Keep visual and event fields brief (under 12 words each); do not repeat narration in them. Part 1 is setup and hook; part 2 escalation and turning point; part 3 climax, resolution and complete ending. Divide the story into three naturally balanced episodes, about one third of the narration per part, with meaningful cliffhangers at the end of parts 1 and 2. Do not withhold the ending for suspense. The LAST TWO segments must cover the actual resolution using the final-movie evidence below; the final segment must select footage from the actual final dialogue or ending sequence, not unrelated end credits. CRITICAL SYNCHRONIZATION RULES: Every segment must be placed at the exact chronological point where its narrated event happens. Use the timestamped transcript events as anchors. The selected source_start/source_end must contain dialogue or evidence for THAT narrated event, not a scene from earlier or later in the story. Do not reuse an earlier timestamp just because it has similar dialogue. Keep segments chronological within each part. If an event's timestamp is uncertain, choose the closest supported transcript timestamp and keep narration general rather than inventing a visual. All source times must be grounded in event timestamps, within 0..{duration:.1f}, and windows 5-25 seconds. Each visual must describe footage likely visible at that time. Language: {settings.get('language','English')}. Evidence: {json.dumps(evidence,ensure_ascii=False)}. FINAL MOVIE EVIDENCE (must guide the ending): {ending_text}"""
 recap_schema={"type":"object","properties":{"title":{"type":"string"},"segments":{"type":"array","items":{"type":"object","properties":{"part":{"type":"integer","enum":[1,2,3]},"narration":{"type":"string"},"source_start":{"type":"number"},"source_end":{"type":"number"},"visual":{"type":"string"},"event":{"type":"string"}},"required":["part","narration","source_start","source_end","visual","event"],"additionalProperties":False}}},"required":["title","segments"],"additionalProperties":False}
 def collect_valid(items):
  accepted=[]
  for item in items:
   try:
    part=int(item.get("part",1));start=float(item["source_start"]);end=float(item["source_end"])
   except (KeyError,TypeError,ValueError):
    continue
   if part in (1,2,3) and 0<=start<duration and start<end:
    item["part"]=part
    item["source_start"]=start
    item["source_end"]=min(duration,max(start+min(5,duration-start),min(end,start+25)))
    accepted.append(item)
  return accepted

 result=await ask(prompt,"You are an expert movie recap editor. Preserve plot truth, maintain chronological continuity and include the entire ending. Return only the requested structured data.",schema_name="movie_recap",schema=recap_schema,max_completion_tokens=4096)
 segments=result.get("segments",[])
 valid=collect_valid(segments)
 if len(valid)<12:
  print("AHM_RECAP_TIMESTAMP_REPAIR","initial_segments",len(segments),"valid_segments",len(valid),flush=True)
  repair_prompt=prompt+f"""

REPAIR REQUIREMENT: The previous attempt did not provide enough usable source timestamps. Return EXACTLY 15 complete scenes, five for each part. Copy source_start values from numeric timestamps in the supplied timestamped evidence; do not invent timestamps or use timestamps outside 0..{duration:.1f}. For every scene set source_end later than source_start, 5-25 seconds after it, and no later than {duration:.1f}. Keep all 15 scenes in chronological story order. Keep narration concise enough to fit the response limit. Include every required JSON field."""
  repaired=await ask(repair_prompt,"You are an expert movie recap editor. Return complete valid source-timestamped scenes. Preserve plot truth, chronological continuity and the actual ending. Return only structured JSON.",schema_name="movie_recap",schema=recap_schema,max_completion_tokens=4096)
  segments=repaired.get("segments",[])
  valid=collect_valid(segments)
  print("AHM_RECAP_TIMESTAMP_REPAIR_RESULT","returned_segments",len(segments),"valid_segments",len(valid),flush=True)
 if len(valid)<12:
  raise RuntimeError(f"The recap model returned only {len(valid)} usable timestamped scenes from {len(segments)} scenes, but at least 12 are required. The movie was not rendered; retry the recap.")
 # Put every recap scene in original-film time order before rendering. This prevents
 # a later plot event from being narrated over footage from an earlier scene.
 valid.sort(key=lambda x:x["source_start"])
 # Rebuild the three episode boundaries from that chronological sequence so
 # the exported parts cannot jump backwards in the movie timeline.
 for index,scene in enumerate(valid):
  scene["part"]=min(3,(index*3)//len(valid)+1)
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
 # Keep one selected narrator voice for every scene and every episode.
 # Retry that exact voice only; never silently switch to another voice.
 rate=f"{int((pace-1)*100):+d}%"
 requested=voice or "en-US-AndrewNeural"
 errors=[]
 for attempt in range(5):
  try:
   if path.exists():path.unlink()
   await edge_tts.Communicate(text,voice=requested,rate=rate).save(str(path))
   if path.exists() and path.stat().st_size>1024:
    print("AHM_TTS_SUCCESS",requested,"attempt",attempt+1,flush=True)
    return
   raise RuntimeError("Edge TTS returned an empty or incomplete audio file.")
  except Exception as exc:
   errors.append(f"{requested} attempt {attempt+1}: {type(exc).__name__}: {str(exc)[:240]}")
   print("AHM_TTS_RETRY_SAME_VOICE",requested,attempt+1,type(exc).__name__,str(exc)[:300],flush=True)
   if path.exists():path.unlink()
   if attempt<4:await asyncio.sleep(2*(attempt+1))
 raise RuntimeError("The selected narrator voice could not be rendered. No alternate voice was substituted. "+" | ".join(errors[-5:]))
def subtitles(audio,text,path):
 rows,_=transcribe(audio,True);words=[w for seg in rows for w in seg.get("words",[])]
 if not words:
  tokens=text.split();dur=float(run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",str(audio)]).strip())
  words=[{"word":w,"start":i*dur/max(1,len(tokens)),"end":(i+1)*dur/max(1,len(tokens))} for i,w in enumerate(tokens)]
 def ass_time(seconds):
  cs=max(0,int(round(float(seconds)*100)))
  return f"{cs//360000:01}:{(cs//6000)%60:02}:{(cs//100)%60:02}.{cs%100:02}"
 header="""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1440
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,19,&H00FFFFFF,&H0000D7FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,60,60,115,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
 lines=[]
 # Three-word phrases keep captions compact; karaoke fill highlights each spoken word.
 for i in range(0,len(words),3):
  group=words[i:i+3]
  start=float(group[0]["start"]);end=max(start+0.18,float(group[-1]["end"]))
  pieces=[]
  for w in group:
   duration=max(8,int((float(w["end"])-float(w["start"]))*100))
   token=str(w["word"]).replace("{","(").replace("}",")").upper()
   pieces.append("{\\kf"+str(duration)+"}"+token)
  lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{{\\an2\\bord3\\shad1}}"+ " ".join(pieces))
 path.write_text(header+"\n".join(lines)+"\n",encoding="utf-8")
def render(movie,audio,srt,start,end,out,has_source_audio=True):
 clip_duration=max(1.0,end-start)
 vf="scale=1080:1440:force_original_aspect_ratio=increase,crop=1080:1440,fps=30,tpad=stop_mode=clone:stop_duration=90,subtitles="+str(srt).replace(":","\\:")
 cmd=["ffmpeg","-y","-ss",str(start),"-t",str(clip_duration),"-i",str(movie),"-i",str(audio),"-vf",vf]
 if has_source_audio:
  mix="[0:a:0]volume=0.12,aresample=48000[film];[1:a:0]volume=1.0,aresample=48000[voice];[voice][film]amix=inputs=2:duration=first:dropout_transition=1,loudnorm=I=-16:TP=-1.5[aout]"
  cmd += ["-filter_complex",mix,"-map","0:v:0","-map","[aout]"]
 else:
  cmd += ["-map","0:v:0","-map","1:a:0"]
 cmd += ["-c:v","libx264","-preset",os.getenv("FFMPEG_PRESET","veryfast"),"-crf","22","-pix_fmt","yuv420p","-r","30","-c:a","aac","-b:a","192k","-shortest","-movflags","+faststart",str(out)]
 run(cmd)

def choose_music_track(scenes):
 text_value=" ".join(str(scene.get("event",""))+" "+str(scene.get("narration","")) for scene in scenes).lower()
 moods=[
  (("fight","battle","attack","chase","escape","weapon","explosion","race","revenge"),"overdrive-signal-lost.mp3"),
  (("death","danger","murder","secret","mystery","fear","dark","threat","betray","disappear"),"ash.mp3"),
  (("hope","victory","save","rescue","love","reunite","freedom","success","together"),"horizon-monolith.mp3"),
  (("memory","past","childhood","remember","family","goodbye","loss","sad","letter"),"old-photos-outlands.mp3"),
  (("quiet","peace","calm","journey","travel","discover","beautiful"),"afterglow-vast.mp3"),
 ]
 for words,track in moods:
  if any(word in text_value for word in words):return track
 return "beneath.mp3"
def download_music(track,directory):
 directory.mkdir(parents=True,exist_ok=True)
 path=directory/track
 if path.exists() and path.stat().st_size>10000:return path
 url="https://raw.githubusercontent.com/farmmer938-lgtm/aeris-cc0-music/main/tracks/"+track
 response=requests.get(url,timeout=(15,60))
 response.raise_for_status()
 if len(response.content)<10000:raise RuntimeError("Free background music download was incomplete.")
 path.write_bytes(response.content)
 return path
def download_url(s3,key):
 filename=Path(key).name.replace('"', "")
 return s3.generate_presigned_url("get_object",Params={"Bucket":os.environ["R2_BUCKET"],"Key":key,"ResponseContentType":"application/octet-stream","ResponseContentDisposition":f'attachment; filename="{filename}"'},ExpiresIn=604800)
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
  clips={1:[],2:[],3:[]};clip_durations={1:[],2:[],3:[]};durations={1:0,2:0,3:0};total=len(recap["segments"])
  for i,scene in enumerate(recap["segments"]):
   narration=str(scene.get("narration","")).strip()
   if not narration:continue
   voice=settings.get("voice","en-US-AndrewNeural")
   if settings.get("language")=="Kiswahili" and not voice.startswith("sw-"):voice="sw-KE-RafikiNeural"
   audio_file=tmp/f"voice_{i:03}.mp3";srt=tmp/f"subs_{i:03}.ass";clip=tmp/f"clip_{i:03}.mp4"
   await tts(narration,voice,float(settings.get("pace",1)),audio_file)
   subtitles(audio_file,narration,srt)
   voice_seconds=float(run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",str(audio_file)]).strip())
   clip_start=float(scene["source_start"]);clip_end=float(scene["source_end"])
   needed=voice_seconds+0.25
   if clip_end-clip_start<needed:
    clip_end=min(duration,clip_start+needed)
    if clip_end-clip_start<needed:clip_start=max(0,clip_end-needed)
   render(movie,audio_file,srt,clip_start,clip_end,clip,False)
   part=int(scene["part"]);clips[part].append(clip)
   clip_seconds=float(run(["ffprobe","-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",str(clip)]).strip())
   clip_durations[part].append(clip_seconds)
   durations[part]+=clip_seconds
   update(job_id,stage=f"Editing original footage · scene {i+1}/{total}",progress=45+int((i+1)/total*48))
  episodes=[]
  for part in (1,2,3):
   if not clips[part]:raise RuntimeError(f"Episode {part} has no footage.")
   out=tmp/f"AHM_Movies_Part_{part}.mp4"
   # Blend picture cuts with a short cinematic dissolve. Keep narration in a
   # straight chronological audio concat so words never overlap across scenes.
   fade=min(0.25,max(0.15,min(clip_durations[part])/8))
   inputs=[]
   filters=[]
   for index,clip_path in enumerate(clips[part]):
    inputs += ["-i",str(clip_path)]
    filters.append(f"[{index}:v:0]format=yuv420p[v{index}]")
    filters.append(f"[{index}:a:0]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a{index}]")
   if len(clips[part])==1:
    filters += ["[v0]null[vout]","[a0]anull[aout]"]
   else:
    previous="v0"
    elapsed=clip_durations[part][0]
    for index in range(1,len(clips[part])):
     output=f"vx{index}"
     offset=max(0.0,elapsed-fade*index)
     filters.append(f"[{previous}][v{index}]xfade=transition=fade:duration={fade:.3f}:offset={offset:.3f}[{output}]")
     previous=output
     elapsed+=clip_durations[part][index]
    filters.append(f"[{previous}]null[vout]")
    audio_previous="a0"
    for index in range(1,len(clips[part])):
     audio_output=f"ax{index}"
     filters.append(f"[{audio_previous}][a{index}]acrossfade=d={fade:.3f}:c1=tri:c2=tri[{audio_output}]")
     audio_previous=audio_output
    filters.append(f"[{audio_previous}]anull[aout]")
   # Add a quiet, automatically selected CC0 instrumental bed. The source film
   # soundtrack remains muted; only narration and licensed background music are exported.
   part_scenes=[scene for scene in recap["segments"] if int(scene.get("part",1))==part]
   music_track=choose_music_track(part_scenes)
   music_path=None
   try:
    music_path=download_music(music_track,tmp/"music")
    music_duration=max(1.0,sum(clip_durations[part])-fade*(len(clip_durations[part])-1))
    music_index=len(clips[part])
    inputs += ["-stream_loop","-1","-i",str(music_path)]
    fade_out=max(0.0,music_duration-2.0)
    filters.append(f"[{music_index}:a:0]aresample=48000,volume=0.13,atrim=0:{music_duration:.3f},afade=t=in:st=0:d=1,afade=t=out:st={fade_out:.3f}:d={min(2.0,music_duration):.3f}[music]")
    filters.append("[aout][music]amix=inputs=2:duration=first:dropout_transition=1:normalize=0,alimiter=limit=0.95[finalaudio]")
    audio_map="[finalaudio]"
    print("AHM_FREE_BACKGROUND_MUSIC",part,music_track,flush=True)
   except Exception as music_error:
    audio_map="[aout]"
    print("AHM_FREE_BACKGROUND_MUSIC_UNAVAILABLE",part,type(music_error).__name__,str(music_error)[:300],flush=True)
   run(["ffmpeg","-y",*inputs,"-filter_complex",";".join(filters),"-map","[vout]","-map",audio_map,"-c:v","libx264","-preset",os.getenv("FFMPEG_PRESET","veryfast"),"-crf","21","-pix_fmt","yuv420p","-r","30","-c:a","aac","-b:a","192k","-ar","48000","-movflags","+faststart",str(out)])
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
@app.get("/", include_in_schema=False)
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
