(() => {
"use strict";
const $=id=>document.getElementById(id);
const state={file:null,objectKey:null,jobId:null,uploading:false,polling:false,previewUrl:null};
const allowed=new Set(["video/mp4","video/quicktime","video/x-matroska","video/webm","video/mpeg"]);
const bytes=n=>n<1024**3?(n/1024**2).toFixed(1)+" MB":(n/1024**3).toFixed(2)+" GB";
function status(message,type=""){$("jobStatus").textContent=message;$("jobStatus").className="job-status "+type;}
function setConnection(label,ok){$("connection").textContent=label;$("connection").className="status-pill "+(ok?"online":"offline");}
async function api(url,options={}){const r=await fetch(url,options);const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed ("+r.status+")");return d;}
async function checkHealth(){
 try{
  const h=await api("/api/recap/health");
  const storage=h.storage==="ready",worker=h.worker==="connected";
  setConnection(storage&&worker?"Services connected":"Setup required",storage&&worker);
  $("serviceNote").textContent=storage&&worker?"Storage and the movie-processing worker are connected. You can start a real recap job.":"Backend routes are installed, but production services are not configured yet. Storage: "+h.storage+". Processing worker: "+h.worker+".";
  if(!storage||!worker){$("startBtn").disabled=true;status("Backend is online. Complete the storage and worker setup before processing a full movie.","warning");}
  else updateStart();
 }catch(e){setConnection("API unavailable",false);$("serviceNote").textContent=e.message;$("startBtn").disabled=true;}
}
function updateStart(){$("startBtn").disabled=!state.file||state.uploading||state.polling;}
function selectFile(file){
 if(!file)return;
 if(!allowed.has(file.type)){status("Unsupported file type. Choose MP4, MOV, MKV, WebM or MPEG.","error");return;}
 if(file.size>4.5*1024**3){status("This file is over the current 4.5 GB upload limit.","error");return;}
 state.file=file;$("fileTitle").textContent=file.name;$("fileMeta").textContent=bytes(file.size)+" · "+file.type;
 if(state.previewUrl)URL.revokeObjectURL(state.previewUrl);
 state.previewUrl=URL.createObjectURL(file);$("moviePreview").src=state.previewUrl;$("moviePreview").hidden=false;
 status("Movie selected. It will upload directly to storage when you start.","success");updateStart();
}
$("movieFile").addEventListener("change",e=>selectFile(e.target.files[0]));
$("dropzone").addEventListener("dragover",e=>{e.preventDefault();$("dropzone").classList.add("drag");});
$("dropzone").addEventListener("dragleave",()=>$("dropzone").classList.remove("drag"));
$("dropzone").addEventListener("drop",e=>{e.preventDefault();$("dropzone").classList.remove("drag");selectFile(e.dataTransfer.files[0]);});
$("pace").addEventListener("input",e=>{$("paceValue").textContent=Number(e.target.value)===1?"Normal":Number(e.target.value)<1?"Slower":"Faster";});
async function upload(){
 const file=state.file;
 const signed=await api("/api/recap/uploads",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({filename:file.name,contentType:file.type,size:file.size})});
 $("uploadProgress").hidden=false;$("uploadBar").style.width="0%";$("uploadLabel").textContent="Uploading movie securely…";
 await new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();xhr.open("PUT",signed.uploadUrl);xhr.setRequestHeader("Content-Type",file.type);
  xhr.upload.onprogress=e=>{if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);$("uploadBar").style.width=p+"%";$("uploadLabel").textContent="Uploading movie… "+p+"%";}};
  xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve():reject(new Error("Storage upload failed ("+xhr.status+"). Please retry."));
  xhr.onerror=()=>reject(new Error("Network/CORS error during movie upload. Check that this AHM Movies site is allowed in the R2 bucket CORS settings for PUT and Content-Type, then retry."));
  xhr.onabort=()=>reject(new Error("Movie upload was cancelled."));xhr.send(file);
 });
 state.objectKey=signed.objectKey;$("uploadLabel").textContent="Upload complete · starting movie analysis";
}
async function startJob(){
 if(!state.file||state.uploading||state.polling)return;
 state.uploading=true;updateStart();$("startBtn").textContent="Uploading movie…";
 try{
  status("Preparing secure upload…");await upload();
  const settings={targetMinutes:Number($("length").value),language:$("language").value,voice:$("voice").value,pace:Number($("pace").value)};
  const job=await api("/api/recap/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({objectKey:state.objectKey,filename:state.file.name,settings})});
  state.jobId=job.id||job.job_id;state.uploading=false;state.polling=true;updateStart();
  status("Movie accepted. Full-film analysis has started.","success");$("startBtn").textContent="Recap processing…";await poll();
 }catch(e){state.uploading=false;$("startBtn").textContent="Upload & create recap →";status(e.message,"error");updateStart();}
}
async function poll(){
 if(!state.jobId)return;
 try{
  const d=await api("/api/recap/jobs/"+encodeURIComponent(state.jobId));
  const pct=Number(d.progress||0),stage=d.stage||d.status||"Processing";
  status(stage+(pct?" · "+pct+"%":""),"working");
  if(d.status==="completed"){state.polling=false;$("startBtn").textContent="Recap completed";renderEpisodes(d.episodes||[]);return;}
  if(d.status==="failed"){state.polling=false;$("startBtn").textContent="Retry recap";status(d.error||"The recap job failed.","error");updateStart();return;}
  setTimeout(poll,5000);
 }catch(e){state.polling=false;$("startBtn").textContent="Check job again";status("Could not check job status: "+e.message,"error");updateStart();}
}
function renderEpisodes(items){
 $("results").hidden=false;$("episodeList").innerHTML="";
 if(!items.length){$("episodeList").textContent="The worker reported completion but did not return episode files. Check worker logs.";return;}
 items.forEach((ep,i)=>{
  const card=document.createElement("article");card.className="episode";
  const title=document.createElement("h3");title.textContent=ep.title||"Part "+(i+1);
  const meta=document.createElement("p");meta.textContent=ep.duration||"MP4 · 3:4";
  const link=document.createElement("a");link.href=ep.download_url;link.textContent="Download MP4";link.className="download";link.rel="noopener";
  card.append(title,meta,link);$("episodeList").append(card);
 });
 status("Your three-part recap is ready.","success");
}
$("startBtn").addEventListener("click",startJob);
checkHealth();
})();