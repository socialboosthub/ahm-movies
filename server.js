require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { S3Client, PutObjectCommand, DeleteObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), {
  maxAge:"1h",
  setHeaders(res,filePath) {
    if ([".html",".js",".css"].includes(path.extname(filePath).toLowerCase()))
      res.setHeader("Cache-Control","no-cache, must-revalidate");
  }
}));

const MAX_UPLOAD_BYTES = 4.5 * 1024 * 1024 * 1024;
const allowedTypes = new Set(["video/mp4","video/quicktime","video/x-matroska","video/webm","video/mpeg"]);
const clean = value => String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0,120);

function storageConfig() {
  const required = ["R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET"];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) return { ready:false, missing };
  return { ready:true, missing:[] };
}
function s3() {
  return new S3Client({
    region:"auto",
    endpoint:`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials:{ accessKeyId:process.env.R2_ACCESS_KEY_ID, secretAccessKey:process.env.R2_SECRET_ACCESS_KEY }
  });
}
function workerReady() {
  return Boolean(process.env.RECAP_WORKER_URL && process.env.RECAP_WORKER_TOKEN);
}
async function workerRequest(route, options={}) {
  if (!workerReady()) {
    const error = new Error("The movie-processing worker is not connected yet. Configure RECAP_WORKER_URL and RECAP_WORKER_TOKEN.");
    error.statusCode=503; throw error;
  }
  const response = await fetch(new URL(route, process.env.RECAP_WORKER_URL), {
    ...options,
    headers:{ "content-type":"application/json", "x-ahm-worker-token":process.env.RECAP_WORKER_TOKEN, ...(options.headers||{}) },
    signal:AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) {
    const error = new Error(data.detail || data.error || `Processing service returned ${response.status}`);
    error.statusCode=response.status; throw error;
  }
  return data;
}

app.get("/api/recap/health", async (_req,res) => {
  const storage=storageConfig();
  let worker="not_configured";
  if (workerReady()) {
    try {
      const probe=await workerRequest("/health");
      worker=probe && probe.ok===true ? "connected" : "unhealthy";
    } catch (error) {
      worker="unreachable";
      console.warn("worker health check failed",error.message);
    }
  }
  const missing=[
    ...storage.missing,
    ...(!workerReady()?["RECAP_WORKER_URL","RECAP_WORKER_TOKEN"]:[]),
    ...(workerReady() && worker!=="connected"?["worker_unreachable"]:[])
  ];
  res.json({
    ok:storage.ready && worker==="connected",app:"AHM Movies",version:"2.0.1",
    storage:storage.ready?"ready":"not_configured",
    worker,
    uploadMode:"direct-to-object-storage",
    limits:{maxUploadBytes:MAX_UPLOAD_BYTES},
    missing
  });
});

app.post("/api/recap/browser-test", async (_req,res) => {
  try {
    const storage=storageConfig();
    if (!storage.ready) return res.status(503).json({ok:false,error:"Storage is not configured."});
    const client=s3();
    const objectKey=`diagnostics/browser/${Date.now()}-${crypto.randomUUID()}.mp4`;
    const created=await client.send(new CreateMultipartUploadCommand({
      Bucket:process.env.R2_BUCKET,Key:objectKey,ContentType:"video/mp4"
    }));
    const uploadUrl=await getSignedUrl(client,new UploadPartCommand({
      Bucket:process.env.R2_BUCKET,Key:objectKey,UploadId:created.UploadId,PartNumber:1
    }),{expiresIn:600});
    res.json({ok:true,uploadUrl,objectKey,uploadId:created.UploadId});
  } catch(error) {
    console.error("browser multipart test signing failed",error.name,error.message);
    res.status(500).json({ok:false,error:"Could not prepare browser multipart test."});
  }
});
app.post("/api/recap/browser-test/complete", async (req,res) => {
  const objectKey=String(req.body?.objectKey||"");
  const uploadId=String(req.body?.uploadId||"");
  const etag=String(req.body?.etag||"");
  if (!objectKey.startsWith("diagnostics/browser/") || !objectKey.endsWith(".mp4") ||
      objectKey.includes("..") || !uploadId || !etag)
    return res.status(400).json({ok:false,error:"Invalid browser multipart completion."});
  try {
    await s3().send(new CompleteMultipartUploadCommand({
      Bucket:process.env.R2_BUCKET,Key:objectKey,UploadId:uploadId,
      MultipartUpload:{Parts:[{PartNumber:1,ETag:etag}]}
    }));
    res.json({ok:true});
  } catch(error) {
    console.warn("browser multipart completion failed",error.name,error.message);
    res.status(502).json({ok:false,error:"Browser multipart completion failed."});
  }
});
app.post("/api/recap/browser-test/report", (req,res) => {
  const result=String(req.body?.result||"unknown").slice(0,20);
  const message=String(req.body?.message||"").replace(/[\\r\\n]/g," ").slice(0,240);
  console.info("AHM browser upload check",JSON.stringify({
    result,
    message,
    online:req.body?.online===true,
    userAgent:String(req.body?.userAgent||"").slice(0,180)
  }));
  res.json({ok:true});
});
app.post("/api/recap/browser-test/cleanup", async (req,res) => {
  const objectKey=String(req.body?.objectKey||"");
  if (!objectKey.startsWith("diagnostics/browser/") || !objectKey.endsWith(".mp4") || objectKey.includes("..") || objectKey.includes("\\\\"))
    return res.status(400).json({ok:false,error:"Invalid diagnostic object key."});
  try {
    const uploadId=String(req.body?.uploadId||"");
    if(uploadId) await s3().send(new AbortMultipartUploadCommand({Bucket:process.env.R2_BUCKET,Key:objectKey,UploadId:uploadId})).catch(()=>{});
    await s3().send(new DeleteObjectCommand({Bucket:process.env.R2_BUCKET,Key:objectKey}));
    res.json({ok:true});
  } catch(error) {
    console.warn("browser upload test cleanup failed",error.name,error.message);
    res.status(500).json({ok:false,error:"Diagnostic cleanup failed."});
  }
});

app.post("/api/recap/multipart/create", async (req,res) => {
  try {
    const {filename,contentType,size}=req.body||{};
    const bytes=Number(size);
    if (!filename || typeof filename!=="string" || !allowedTypes.has(contentType))
      return res.status(400).json({ok:false,error:"Choose a supported movie file."});
    if (!Number.isFinite(bytes)||bytes<=0||bytes>MAX_UPLOAD_BYTES)
      return res.status(400).json({ok:false,error:"Movie file must be between 1 byte and 4.5 GB."});
    const storage=storageConfig();
    if (!storage.ready) return res.status(503).json({ok:false,error:"Movie storage is not configured."});
    const key=`incoming/${new Date().toISOString().slice(0,10)}/${crypto.randomUUID()}-${clean(filename)}`;
    const created=await s3().send(new CreateMultipartUploadCommand({
      Bucket:process.env.R2_BUCKET,Key:key,ContentType:contentType
    }));
    if (!created.UploadId) throw new Error("R2 did not return a multipart upload ID.");
    res.json({ok:true,objectKey:key,uploadId:created.UploadId,partSize:16*1024*1024});
  } catch(error) {
    console.error("multipart upload creation failed",error.name,error.message);
    res.status(500).json({ok:false,error:"Could not start the secure multipart upload."});
  }
});
app.post("/api/recap/multipart/part-url", async (req,res) => {
  try {
    const {objectKey,uploadId,partNumber}=req.body||{};
    const number=Number(partNumber);
    if (typeof objectKey!=="string" || !objectKey.startsWith("incoming/") ||
        typeof uploadId!=="string" || uploadId.length<8 || uploadId.length>512 ||
        !Number.isInteger(number) || number<1 || number>10000)
      return res.status(400).json({ok:false,error:"Invalid multipart upload part."});
    const uploadUrl=await getSignedUrl(s3(),new UploadPartCommand({
      Bucket:process.env.R2_BUCKET,Key:objectKey,UploadId:uploadId,PartNumber:number
    }),{expiresIn:3600});
    res.json({ok:true,uploadUrl});
  } catch(error) {
    console.error("multipart part signing failed",error.name,error.message);
    res.status(500).json({ok:false,error:"Could not prepare the next upload part."});
  }
});
app.post("/api/recap/multipart/complete", async (req,res) => {
  try {
    const {objectKey,uploadId,parts}=req.body||{};
    if (typeof objectKey!=="string" || !objectKey.startsWith("incoming/") ||
        typeof uploadId!=="string" || uploadId.length<8 ||
        !Array.isArray(parts) || parts.length<1 || parts.length>10000)
      return res.status(400).json({ok:false,error:"Invalid multipart completion request."});
    const normalized=parts.map(part=>({PartNumber:Number(part.PartNumber),ETag:String(part.ETag||"")}))
      .sort((a,b)=>a.PartNumber-b.PartNumber);
    if (normalized.some((part,index)=>!Number.isInteger(part.PartNumber)||part.PartNumber!==index+1||!part.ETag))
      return res.status(400).json({ok:false,error:"Upload parts are incomplete or out of order."});
    await s3().send(new CompleteMultipartUploadCommand({
      Bucket:process.env.R2_BUCKET,Key:objectKey,UploadId:uploadId,MultipartUpload:{Parts:normalized}
    }));
    res.json({ok:true,objectKey});
  } catch(error) {
    console.error("multipart completion failed",error.name,error.message);
    res.status(502).json({ok:false,error:"R2 could not assemble the uploaded movie parts. Retry the upload."});
  }
});
app.post("/api/recap/multipart/abort", async (req,res) => {
  try {
    const {objectKey,uploadId}=req.body||{};
    if (typeof objectKey!=="string" || !objectKey.startsWith("incoming/") ||
        typeof uploadId!=="string" || uploadId.length<8)
      return res.status(400).json({ok:false,error:"Invalid multipart abort request."});
    await s3().send(new AbortMultipartUploadCommand({Bucket:process.env.R2_BUCKET,Key:objectKey,UploadId:uploadId}));
    res.json({ok:true});
  } catch(error) {
    console.warn("multipart abort failed",error.name,error.message);
    res.status(500).json({ok:false,error:"Could not cancel the multipart upload."});
  }
});

app.post("/api/recap/uploads", async (req,res) => {
  try {
    const {filename,contentType,size}=req.body||{};
    if (!filename || typeof filename!=="string") return res.status(400).json({ok:false,error:"Choose a movie file first."});
    if (!allowedTypes.has(contentType)) return res.status(415).json({ok:false,error:"Use an MP4, MOV, MKV, WebM or MPEG video file."});
    const bytes=Number(size);
    if (!Number.isFinite(bytes)||bytes<=0||bytes>MAX_UPLOAD_BYTES) return res.status(400).json({ok:false,error:"Movie file must be between 1 byte and 4.5 GB."});
    const storage=storageConfig();
    if (!storage.ready) return res.status(503).json({ok:false,error:"Movie storage is not configured yet.",missing:storage.missing});
    const key=`incoming/${new Date().toISOString().slice(0,10)}/${crypto.randomUUID()}-${clean(filename)}`;
    const uploadUrl=await getSignedUrl(s3(),new PutObjectCommand({
      Bucket:process.env.R2_BUCKET,Key:key,ContentType:contentType
    }),{expiresIn:3600});
    res.json({ok:true,uploadUrl,objectKey:key,expiresIn:3600});
  } catch(error) {
    console.error("upload signing failed",error.message);
    res.status(error.statusCode||500).json({ok:false,error:error.message||"Could not prepare movie upload."});
  }
});

app.post("/api/recap/jobs", async (req,res) => {
  try {
    const {objectKey,filename,settings}=req.body||{};
    if (typeof objectKey!=="string"||!objectKey.startsWith("incoming/")) return res.status(400).json({ok:false,error:"Upload the movie before starting its recap."});
    const safeSettings={
      aspectRatio:"3:4",
      targetMinutes:Math.min(6,Math.max(5,Number(settings?.targetMinutes)||5.5)),
      parts:3,
      voice:String(settings?.voice||"en-US-AndrewNeural").slice(0,80),
      pace:Math.min(1.15,Math.max(0.85,Number(settings?.pace)||1)),
      subtitleStyle:"bold-white-all-caps-italic-shadow",
      subtitlePosition:"lower-middle",
      language:String(settings?.language||"English").slice(0,40)
    };
    const job=await workerRequest("/jobs",{method:"POST",body:JSON.stringify({object_key:objectKey,filename:clean(filename),settings:safeSettings})});
    res.status(202).json({ok:true,...job});
  } catch(error) {
    console.error("job start failed",error.message);
    res.status(error.statusCode||503).json({ok:false,error:error.message});
  }
});

app.get("/api/recap/jobs/:id", async (req,res) => {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(req.params.id)) return res.status(400).json({ok:false,error:"Invalid job ID."});
  try {
    const job=await workerRequest(`/jobs/${encodeURIComponent(req.params.id)}`);
    res.json({ok:true,...job});
  } catch(error) {
    res.status(error.statusCode||503).json({ok:false,error:error.message});
  }
});

app.use("/api",(req,res)=>res.status(404).json({ok:false,error:"API route not found."}));
app.get("*",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
if (require.main===module) {
  const port=Number(process.env.PORT||3000);
  app.listen(port,"0.0.0.0",()=>console.log(`AHM Movies API listening on ${port}`));
}
module.exports=app;
