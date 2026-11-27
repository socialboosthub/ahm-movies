(() => {
"use strict";
const $=id=>document.getElementById(id);
const state={file:null,objectKey:null,jobId:null,uploading:false,polling:false,previewUrl:null,uploadTestFailed:false,multipartSession:null};
const allowed=new Set(["video/mp4","video/quicktime","video/x-matroska","video/webm","video/mpeg"]);
const bytes=n=>n<1024**3?(n/1024**2).toFixed(1)+" MB":(n/1024**3).toFixed(2)+" GB";
function status(message,type=""){$("jobStatus").textContent=message;$("jobStatus").className="job-status "+type;}
function setConnection(label,ok){$("connection").textContent=label;$("connection").className="status-pill "+(ok?"online":"offline");}
async function api(url,options={}){const r=await fetch(url,options);const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed ("+r.status+")");return d;}
async function browserUploadCheck(){
 const signed=await api("/api/recap/browser-test",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
 const report=(result,message="")=>api("/api/recap/browser-test/report",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({result,message,online:navigator.onLine,userAgent:navigator.userAgent})}).catch(()=>{});
 try{
  const xhr=await xhrPut(signed.uploadUrl,new Blob([new Uint8Array(32*1024)],{type:"video/mp4"}),"video/mp4",null,45000);
  const etag=xhr.getResponseHeader("ETag");
  if(!etag)throw new Error("R2 did not expose the ETag needed to finish multipart uploads.");
  await api("/api/recap/browser-test/complete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({objectKey:signed.objectKey,uploadId:signed.uploadId,etag})});
  await report("passed");
 } catch(e) {
  await report("failed",e.message);
  throw e;
 } finally {
  await api("/api/recap/browser-test/cleanup",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({objectKey:signed.objectKey,uploadId:signed.uploadId})}).catch(()=>{});
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
   // Do not run a tiny diagnostic PUT from the mobile browser on page load.
   // Android browsers/network filters can block that test (XHR status 0) even
   // though the signed multipart upload flow may still work. Let the real upload
   // attempt determine connectivity and use its retry/reporting logic.
   state.uploadTestFailed=false;
   $("serviceNote").textContent="Storage and processing worker are connected. Browser upload will be verified during the real upload.";
   updateStart();
  }
 }catch(e){setConnection("API unavailable",false);$("serviceNote").textContent=e.message;$("startBtn").disabled=true;}
}
function updateStart(){$("startBtn").disabled=!state.file||state.uploading||state.polling;if(state.uploadTestFailed&&!state.uploading&&!state.polling){$("startBtn").textContent="Try upload anyway →";}}
function selectFile(file){
 if(!file)return;
 if(!allowed.has(file.type)){status("Unsupported file type. Choose MP4, MOV, MKV, WebM or MPEG.","error");return;}
 if(file.size>4.5*1024**3){status("This file is over the current 4.5 GB upload limit.","error");return;}
 state.file=file;$("fileTitle").textContent=file.name;$("fileMeta").textContent=bytes(file.size)+" · "+file.type;
 if(state.previewUrl)URL.revokeObjectURL(state.previewUrl);
 state.previewUrl=URL.createObjectURL(file);const preview=$("moviePreview");preview.src=state.previewUrl;preview.preload="metadata";preview.hidden=false;preview.load();preview.onerror=()=>{status("Movie selected, but this browser cannot preview its video codec. Upload can still continue.","");};preview.onloadedmetadata=()=>{if(Number.isFinite(preview.duration))$("fileMeta").textContent=bytes(file.size)+" · "+Math.round(preview.duration/60)+" min · "+file.type;};
 status("Movie selected. It will upload directly to storage when you start.","success");updateStart();
}
$("movieFile").addEventListener("change",e=>selectFile(e.target.files[0]));
$("dropzone").addEventListener("dragover",e=>{e.preventDefault();$("dropzone").classList.add("drag");});
$("dropzone").addEventListener("dragleave",()=>$("dropzone").classList.remove("drag"));
$("dropzone").addEventListener("drop",e=>{e.preventDefault();$("dropzone").classList.remove("drag");selectFile(e.dataTransfer.files[0]);});
$("pace").addEventListener("input",e=>{$("paceValue").textContent=Number(e.target.value)===1?"Normal":Number(e.target.value)<1?"Slower":"Faster";});
function xhrPut(url,blob,contentType,onProgress,timeout=15*60*1000){
 return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();
  xhr.open("PUT",url);
  xhr.withCredentials=false;
  xhr.timeout=timeout;
  if(contentType)xhr.setRequestHeader("Content-Type",contentType);
  xhr.upload.onprogress=onProgress||null;
  xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve(xhr):reject(new Error("R2 upload returned HTTP "+xhr.status+". "+String(xhr.responseText||"").slice(0,220)));
  xhr.onerror=()=>reject(new Error("Browser-to-R2 connection interrupted (status "+xhr.status+")."));
  xhr.ontimeout=()=>reject(new Error("R2 upload timed out."));
  xhr.onabort=()=>reject(new Error("R2 upload was cancelled."));
  xhr.send(blob);
 });
}
async function multipartReport(data){
 return api("/api/recap/multipart/report",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...data,online:navigator.onLine,userAgent:navigator.userAgent})}).catch(()=>{});
}
async function multipartUpload(file){
 let session=state.multipartSession;
 if(!session||session.file!==file){
  const created=await api("/api/recap/multipart/create",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({filename:file.name,contentType:file.type,size:file.size})});
  session={file,objectKey:created.objectKey,uploadId:created.uploadId,partSize:Number(created.partSize)||5*1024*1024,parts:[],uploadedBytes:0};
  state.multipartSession=session;
 }
 const {objectKey,uploadId,partSize,parts}=session;
 const count=Math.ceil(file.size/partSize);
 try{
  for(let partNumber=1;partNumber<=count;partNumber++){
   if(parts.some(p=>p.PartNumber===partNumber))continue;
   const begin=(partNumber-1)*partSize,end=Math.min(file.size,begin+partSize),blob=file.slice(begin,end);
   let result=null,lastError=null;
   for(let attempt=1;attempt<=6&&!result;attempt++){
    const attemptStarted=Date.now();
    try{
     await multipartReport({stage:"part-start",part:partNumber,total:count,attempt,size:blob.size});
     const signed=await api("/api/recap/multipart/part-url",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({objectKey,uploadId,partNumber})});
     result=await xhrPut(signed.uploadUrl,blob,file.type,e=>{
      if(e.lengthComputable){
       const bytesDone=session.uploadedBytes+e.loaded;
       const pct=Math.round(bytesDone/file.size*100);
       $("uploadBar").style.width=pct+"%";
       $("uploadLabel").textContent="Uploading movie · part "+partNumber+"/"+count+" · "+pct+"%";
      }
     },120*1000);
     await multipartReport({stage:"part-success",part:partNumber,total:count,attempt,size:blob.size,elapsedMs:Date.now()-attemptStarted});
    }catch(error){
     lastError=error;
     await multipartReport({stage:"part-failed",part:partNumber,total:count,attempt,size:blob.size,elapsedMs:Date.now()-attemptStarted,message:error.message});
     if(attempt<6){
      const delay=Math.min(8000,1500*(attempt));
      $("uploadLabel").textContent="Part "+partNumber+" failed · retry "+attempt+"/6 in "+Math.ceil(delay/1000)+"s · saved chunks kept";
      await new Promise(resolve=>setTimeout(resolve,delay));
     }
    }
   }
   if(!result)throw lastError||new Error("Part "+partNumber+" failed after 6 attempts. Completed parts are saved in this upload session—tap Upload & create recap to resume.");
   const etag=result.getResponseHeader("ETag");
   if(!etag)throw new Error("R2 did not expose the ETag for upload part "+partNumber+".");
   parts.push({PartNumber:partNumber,ETag:etag});
   session.uploadedBytes+=blob.size;
   $("uploadBar").style.width=Math.round(session.uploadedBytes/file.size*100)+"%";
   $("uploadLabel").textContent="Uploaded part "+partNumber+"/"+count+" · saved";
  }
  await api("/api/recap/multipart/complete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({objectKey,uploadId,parts})});
  state.objectKey=objectKey;
  state.multipartSession=null;
 }catch(error){
  // Keep the R2 multipart upload and completed parts alive so the next user retry
  // can resume from the first missing part instead of re-uploading the whole movie.
  throw error;
}
}
async function upload(){
 const file=state.file;
 $("uploadProgress").hidden=false;
 if(file.size>=100*1024*1024){
  $("uploadLabel").textContent="Preparing resumable secure upload…";
  await multipartUpload(file);
  $("uploadLabel").textContent="Upload complete · starting movie analysis";
  return;
 }
 const signed=await api("/api/recap/uploads",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({filename:file.name,contentType:file.type,size:file.size})});
 let completed=false,lastError=null;
 for(let attempt=1;attempt<=2&&!completed;attempt++){
  $("uploadBar").style.width="0%";
  $("uploadLabel").textContent=attempt===1?"Uploading movie securely…":"Connection interrupted · retrying upload (2/2)…";
  try{
   await xhrPut(signed.uploadUrl,file,file.type,e=>{
    if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);$("uploadBar").style.width=p+"%";$("uploadLabel").textContent="Uploading movie… "+p+"%";}
   },45*60*1000);
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
 const downloads=[];
 items.forEach((ep,i)=>{
  const card=document.createElement("article");card.className="episode";
  const title=document.createElement("h3");title.textContent=ep.title||"Part "+(i+1);
  const meta=document.createElement("p");meta.textContent=ep.duration||"MP4 · 3:4";
  const filename=(ep.title||"AHM_Movies_Part_"+(i+1)).replace(/[^a-z0-9_-]/gi,"_")+".mp4";
  const link=document.createElement("a");link.href=ep.download_url;link.textContent="Download MP4";link.className="download";link.rel="noopener";link.setAttribute("download",filename);
  link.addEventListener("click",e=>{e.preventDefault();startDownload(ep.download_url,filename);});
  downloads.push({url:ep.download_url,filename});
  card.append(title,meta,link);$("episodeList").append(card);
 });
 status("Your three-part recap is ready. Starting your MP4 downloads…","success");
 // Start the downloads automatically when the finished episodes arrive.
 // Keep the per-episode links as a fallback if the browser blocks multiple files.
 downloads.forEach((item,index)=>setTimeout(()=>startDownload(item.url,item.filename),900+index*1800));
}
function startDownload(url,filename){
 const link=document.createElement("a");link.href=url;link.download=filename;link.rel="noopener";link.style.display="none";
 document.body.appendChild(link);link.click();link.remove();
}
$("startBtn").addEventListener("click",startJob);
checkHealth();
})();