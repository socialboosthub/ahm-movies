(() => {
"use strict";
const $=id=>document.getElementById(id);
const state={file:null,objectKey:null,jobId:null,uploading:false,polling:false,previewUrl:null};
const allowed=new Set(["video/mp4","video/quicktime","video/x-matroska","video/webm","video/mpeg"]);
const bytes=n=>n<1024**3?(n/1024**2).toFixed(1)+" MB":(n/1024**3).toFixed(2)+" GB";
function status(message,type=""){$("jobStatus").textContent=message;$("jobStatus").className="job-status "+type;}
function setConnection(label,ok){$("connection").textContent=label;$("connection").className="status-pill "+(ok?"online":"offline");}
async function api(url,options={}){const r=await fetch(url,options);const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed ("+r.status+")");return d;}
async function browserUploadCheck(){
 const signed=await api("/api/recap/browser-test",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
 try{
  await new Promise((resolve,reject)=>{
   const xhr=new XMLHttpRequest();
   xhr.open("PUT",signed.uploadUrl);
   xhr.withCredentials=false;
   xhr.timeout=20000;
   xhr.setRequestHeader("Content-Type","video/mp4");
   xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve():reject(new Error("R2 browser test returned HTTP "+xhr.status+"."));
   xhr.onerror=()=>reject(new Error("This browser could not complete a tiny upload to R2 (network/CORS, status "+xhr.status+")."));
   xhr.ontimeout=()=>reject(new Error("The browser-to-R2 test timed out."));
   xhr.onabort=()=>reject(new Error("The browser-to-R2 test was cancelled."));
   xhr.send(new Blob([new Uint8Array([65,72,77,45,82,50])],{type:"video/mp4"}));
  });
 } finally {
  await api("/api/recap/browser-test/cleanup",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({objectKey:signed.objectKey})}).catch(()=>{});
 }
}
async function checkHealth(){
 try{
  const h=await api("/api/recap/health");
  const storage=h.storage==="ready",worker=h.worker==="connected";
  setConnection(storage&&worker?"Services connected":"Setup required",storage&&worker);
  $("serviceNote").textContent=storage&&worker?"Storage and the movie-processing worker are connected. You can start a real recap job.":"Backend routes are installed, but production services are not configured yet. Storage: "+h.storage+". Processing worker: "+h.worker+".";
  if(!storage||!worker){$("startBtn").disabled=true;status("Backend is online. Complete the storage and worker setup before processing a full movie.","warning");}
  else {
   $("startBtn").disabled=true;
   $("serviceNote").textContent="Checking the upload connection from this browser…";
   try {
    await browserUploadCheck();
    $("serviceNote").textContent="Storage, processing worker and this browser's upload connection are verified.";
    updateStart();
   } catch(e) {
    setConnection("Upload check failed",false);
    $("serviceNote").textContent=e.message;
    $("startBtn").disabled=true;
    status("Browser upload connection could not be verified.","error");
   }
  }
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
 $("uploadProgress").hidden=false;
 let completed=false,lastError=null;
 for(let attempt=1;attempt<=2&&!completed;attempt++){
  $("uploadBar").style.width="0%";
  $("uploadLabel").textContent=attempt===1?"Uploading movie securely…":"Connection interrupted · retrying upload (2/2)…";
  try{
   await new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open("PUT",signed.uploadUrl);
    xhr.withCredentials=false;
    xhr.timeout=45*60*1000;
    xhr.setRequestHeader("Content-Type",file.type);
    xhr.upload.onprogress=e=>{if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);$("uploadBar").style.width=p+"%";$("uploadLabel").textContent="Uploading movie… "+p+"%";}};
    xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve():reject(new Error("R2 rejected the upload (HTTP "+xhr.status+"). "+String(xhr.responseText||"").slice(0,240)));
    xhr.onerror=()=>reject(new Error("Browser-to-R2 connection failed (status "+xhr.status+"). The small browser upload check passed, so this may be a network interruption during the large movie transfer."));
    xhr.ontimeout=()=>reject(new Error("Movie upload timed out. The signed upload link is valid for one hour; retry when the connection is stable."));
    xhr.onabort=()=>reject(new Error("Movie upload was cancelled."));
    xhr.send(file);
   });
   completed=true;
  }catch(e){
   lastError=e;
   if(attempt===1&&navigator.onLine){
    $("uploadLabel").textContent="Upload interrupted · retrying once…";
    await new Promise(resolve=>setTimeout(resolve,1500));
   }
  }
 }
 if(!completed)throw lastError||new Error("Movie upload failed. Please retry.");
 state.objectKey=signed.objectKey;
 $("uploadLabel").textContent="Upload complete · starting movie analysis";
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