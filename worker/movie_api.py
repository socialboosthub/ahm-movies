import os,re,json,time,uuid,asyncio,subprocess,tempfile,shutil
from pathlib import Path
from threading import Lock
from typing import Any
import boto3,httpx,edge_tts
from fastapi import FastAPI,Header,HTTPException,BackgroundTasks
from faster_whisper import WhisperModel

app=FastAPI(title="AHM Movies Recap Worker",version="1.0.0")
JOBS:dict[str,dict[str,Any]]={}
LOCK=Lock()
MODEL=None

def auth(token):
 expected=os.getenv("RECAP_WORKER_TOKEN","")
 if not expected or token!=expected: raise HTTPException(401,"Unauthorized worker request.")
def update(job_id,**values):
 with LOCK:
  if job_id in JOBS:JOBS[job_id].update(values)
def run(cmd):
 r=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 if r.returncode:raise RuntimeError((r.stderr or r.stdout)[-2200:])
 return r.stdout
def store():
 required=["R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET"]
 if any(not os.getenv(x) for x in required):raise RuntimeError("R2 storage environment is incomplete.")
 return boto3.client("s3",endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],region_name="auto")
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
async def ask(prompt,system="You are a faithful movie-story analyst. Never invent events."):
 key=os.getenv("GROQ_API_KEY")
 if not key:raise RuntimeError("GROQ_API_KEY is missing from the worker environment.")
 url=os.getenv("LLM_BASE_URL","https://api.groq.com/openai/v1").rstrip("/")+"/chat/completions"
 async with httpx.AsyncClient(timeout=180) as client:
  r=await client.post(url,headers={"Authorization":f"Bearer {key}"},json={"model":os.getenv("LLM_MODEL","llama-3.3-70b-versatile"),"temperature":0.2,"response_format":{"type":"json_object"},"messages":[{"role":"system","content":system},{"role":"user","content":prompt}]})
  r.raise_for_status()
  raw=r.json()["choices"][0]["message"]["content"]
  return json.loads(re.sub(r"^\s*```(?:json)?|\`\`\`\s*$","",raw.strip(),flags=re.I))
async def plan_recap(rows,duration,settings):
 chunks=[];buf=[];size=0
 for row in rows:
  line=f"[{row['start']:.1f}-{row['end']:.1f}] {row['text']}"
  if size+len(line)>9500 and buf:chunks.append("\n".join(buf));buf=[];size=0
  buf.append(line);size+=len(line)
 if buf:chunks.append("\n".join(buf))
 evidence=[]
 for i,chunk in enumerate(chunks):
  data=await ask(f"Summarize this chronological part {i+1}/{len(chunks)} of a {duration/60:.1f}-minute movie. Keep all character names, causes, motives, reveals and ending clues. Do not invent. Return JSON {{\"summary\":\"...\",\"events\":[{{\"time\":0,\"event\":\"...\",\"characters\":[...]}}]}}.\n{chunk}")
  evidence.append(data)
 prompt=f"""Create a faithful complete movie recap from this evidence covering the WHOLE movie through its actual ending. Target {settings.get('targetMinutes',5.5)} minutes, about 700-850 spoken words, 24-30 narration segments. Return JSON {{"title":"...","segments":[{{"part":1,"narration":"2-3 natural sentences","source_start":10,"source_end":24,"visual":"specific visible action","event":"plot event"}}]}}. Part 1 is setup and hook; part 2 escalation and turning point; part 3 climax and complete ending. Do not withhold the ending for suspense. All source times must be grounded in event timestamps, within 0..{duration:.1f}, and windows 5-25 seconds. Each visual must describe footage likely visible at that time. Language: {settings.get('language','English')}. Evidence: {json.dumps(evidence,ensure_ascii=False)}"""
 result=await ask(prompt,"You are an expert movie recap editor. Preserve plot truth and include the entire ending.")
 segments=result.get("segments",[])
 valid=[]
 for x in segments:
  try:p=int(x.get("part",1));a=float(x["source_start"]);b=float(x["source_end"])
  except Exception:continue
  if p in (1,2,3) and 0<=a<duration and a<b:
   x["part"]=p;x["source_start"]=a;x["source_end"]=min(duration,b);valid.append(x)
 if len(valid)<12:raise RuntimeError("The recap model did not return enough valid source-timestamped scenes. Retry the job.")
 valid.sort(key=lambda x:(x["part"],x["source_start"]))
 if not any(x["part"]==3 for x in valid):valid[-1]["part"]=3
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
def render(movie,audio,srt,start,end,out):
 vf="scale=1080:1440:force_original_aspect_ratio=increase,crop=1080:1440,fps=30,tpad=stop_mode=clone:stop_duration=90,subtitles="+str(srt).replace(":","\\:")+":force_style='FontName=DejaVu Sans,FontSize=46,Bold=1,Italic=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=4,Shadow=2,Alignment=2,MarginV=170'"
 run(["ffmpeg","-y","-ss",str(start),"-i",str(movie),"-i",str(audio),"-vf",vf,"-map","0:v:0","-map","1:a:0","-c:v","libx264","-preset",os.getenv("FFMPEG_PRESET","veryfast"),"-crf","23","-c:a","aac","-b:a","160k","-shortest","-movflags","+faststart",str(out)])
def download_url(s3,key):
 return s3.generate_presigned_url("get_object",Params={"Bucket":os.environ["R2_BUCKET"],"Key":key},ExpiresIn=604800)
async def process(job_id,payload):
 tmp=Path(tempfile.mkdtemp(prefix="ahm-recap-"))
 try:
  s3=store();settings=payload.get("settings",{});movie=tmp/"movie"
  update(job_id,status="running",stage="Downloading original movie",progress=2)
  s3.download_file(os.environ["R2_BUCKET"],payload["object_key"],str(movie))
  probe=json.loads(run(["ffprobe","-v","error","-show_entries","format=duration","-of","json",str(movie)]));duration=float(probe["format"]["duration"])
  if duration<60:raise RuntimeError("The uploaded file is too short to be a full movie.")
  if duration>14400:raise RuntimeError("The current maximum movie length is four hours.")
  audio=tmp/"full_audio.wav";update(job_id,stage="Extracting complete movie audio",progress=7)
  run(["ffmpeg","-y","-i",str(movie),"-vn","-ac","1","-ar","16000","-c:a","pcm_s16le",str(audio)])
  update(job_id,stage="Transcribing the entire movie",progress=12)
  transcript,detected=transcribe(audio)
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
   render(movie,audio_file,srt,float(scene["source_start"]),float(scene["source_end"]),clip)
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
   s3.upload_file(str(out),os.environ["R2_BUCKET"],key,ExtraArgs={"ContentType":"video/mp4"})
   seconds=int(durations[part]);episodes.append({"title":f"Part {part}","part":part,"duration":f"{seconds//60}:{seconds%60:02}","download_url":download_url(s3,key)})
  update(job_id,status="completed",stage="Three recap episodes ready",progress=100,episodes=episodes,recap_script=recap)
 except Exception as exc:update(job_id,status="failed",stage="Processing failed",error=str(exc)[:1200])
 finally:shutil.rmtree(tmp,ignore_errors=True)
@app.get("/health")
def health():
 return {"ok":True,"service":"ahm-movies-worker","storage_configured":all(os.getenv(x) for x in ["R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET"]),"llm_configured":bool(os.getenv("GROQ_API_KEY"))}
@app.post("/jobs")
async def create(payload:dict,background:BackgroundTasks,x_ahm_worker_token:str|None=Header(default=None)):
 auth(x_ahm_worker_token)
 if not str(payload.get("object_key","")).startswith("incoming/"):raise HTTPException(400,"Invalid movie object key.")
 jid=uuid.uuid4().hex
 with LOCK:JOBS[jid]={"id":jid,"status":"queued","stage":"Waiting for worker","progress":0,"created_at":time.time()}
 background.add_task(process,jid,payload)
 return {"id":jid,"status":"queued","stage":"Waiting for worker","progress":0}
@app.get("/jobs/{job_id}")
def get_job(job_id:str,x_ahm_worker_token:str|None=Header(default=None)):
 auth(x_ahm_worker_token)
 with LOCK:job=JOBS.get(job_id)
 if not job:raise HTTPException(404,"Job not found. The worker may have restarted.")
 return job
