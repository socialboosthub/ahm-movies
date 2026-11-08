require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

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

app.get("/api/recap/health", (_req,res) => {
  const storage=storageConfig();
  res.json({
    ok:true,app:"AHM Movies",version:"2.0.0",
    storage:storage.ready?"ready":"not_configured",
    worker:workerReady()?"connected":"not_configured",
    uploadMode:"direct-to-object-storage",
    limits:{maxUploadBytes:MAX_UPLOAD_BYTES},
    missing:[...storage.missing, ...(!workerReady()?["RECAP_WORKER_URL","RECAP_WORKER_TOKEN"]:[])]
  });
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
      Bucket:process.env.R2_BUCKET,Key:key,ContentType:contentType,
      Metadata:{originalname:clean(filename)}
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
