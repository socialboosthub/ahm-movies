const https = require("https");
const huggingFaceSpace = require("./huggingface-space");

function request(url, method, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);

    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers
        }
      },
      (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          let parsed;

          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = { raw: data };
          }

          if (res.statusCode >= 400) {
            const detail = typeof parsed.error === "string"
            ? parsed.error
            : parsed.error?.message || parsed.output?.error || parsed.message || parsed.raw;
          reject(new Error(detail || `RunPod HTTP ${res.statusCode}`));
            return;
          }

          resolve(parsed);
        });
      }
    );

    req.on("error", reject);

    if (body !== null) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}


/*
=========================================================
RUNPOD STATUS
=========================================================
*/

async function getRunPodStatus(jobId) {
  const url =
    `https://api.runpod.ai/v2/` +
    `${process.env.RUNPOD_ENDPOINT_ID}/status/${jobId}`;

  return request(
    url,
    "GET",
    {
      Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`
    }
  );
}


/*
=========================================================
WAIT FOR RUNPOD
=========================================================
*/

async function waitForRunPod(jobId) {
  const maxWaitMs = 30 * 60 * 1000;
  const pollMs = 5000;

  const started = Date.now();

  while (Date.now() - started < maxWaitMs) {
    const status = await getRunPodStatus(jobId);

    console.log(
      `[AHM V8] RunPod ${jobId}: ${status.status}`
    );

    if (status.status === "COMPLETED") {
      return status;
    }

    if (
      status.status === "FAILED" ||
      status.status === "CANCELLED"
    ) {
      const error =
        status.error ||
        status.output?.error ||
        `RunPod job ${status.status}`;

      throw new Error(error);
    }

    await new Promise((resolve) =>
      setTimeout(resolve, pollMs)
    );
  }

  throw new Error(
    "RunPod video generation timed out after 30 minutes."
  );
}


/*
=========================================================
EXTRACT VIDEO URL
=========================================================
*/

function extractVideoUrl(output) {
  if (!output) return null;

  if (typeof output === "string") {
    if (
      output.startsWith("http://") ||
      output.startsWith("https://")
    ) {
      return output;
    }

    return null;
  }

  const possibleUrls = [
    output.finalVideoUrl,
    output.final_video_url,
    output.videoUrl,
    output.video_url,
    output.url,
    output.video?.url,
    output.result?.finalVideoUrl,
    output.result?.final_video_url,
    output.result?.videoUrl,
    output.result?.video_url,
    output.result?.url
  ];

  for (const value of possibleUrls) {
    if (
      typeof value === "string" &&
      (
        value.startsWith("http://") ||
        value.startsWith("https://")
      )
    ) {
      return value;
    }
  }

  return null;
}


/*
=========================================================
REAL VIDEO GENERATION
=========================================================
*/

async function generateVideo({ jobId, story }) {

  /*
  -------------------------------------------------------
  DEMO MODE
  -------------------------------------------------------
  */

  if (
    process.env.DEMO_MODE === "true" ||
    !process.env.RUNPOD_ENDPOINT_ID ||
    !process.env.RUNPOD_API_KEY
  ) {
    return {
      mode: "demo",
      finalVideoUrl: null,
      workerJobId: null,
      note:
        "Demo mode is enabled. Connect RunPod API credentials and a production worker."
    };
  }


  /*
  -------------------------------------------------------
  RUNPOD REQUEST
  -------------------------------------------------------
  */

  const url =
    `https://api.runpod.ai/v2/` +
    `${process.env.RUNPOD_ENDPOINT_ID}/run`;


  /*
  Keep AHM's production rules inside the job payload.
  */

  const input = {
    job_type: "ahm_v8_video",

    job_id: jobId,

    aspect_ratio: "9:16",

    duration_sec: Math.min(
      120,
      Math.max(
        30,
        Number(story.durationSec || 30)
      )
    ),

    story,

    style: {
      visual:
        "stylized-realistic cinematic 3D",

      format:
        "vertical short-form cinematic storytelling",

      pacing:
        "fast-paced with strong visual changes",

      hook:
        "strong curiosity hook in the first 1-2 seconds",

      storytelling:
        "hook, problem or mechanism, escalation, twist, payoff, curiosity kicker",

      annotations: {
        reveal: "neon green",
        danger: "red"
      },

      subtitles: true,

      subtitle_style:
        "large readable white subtitles near the lower center",

      no_on_screen_generated_text: true,

      characters_do_not_talk: true,

      narration:
        "continuous external narration",

      camera:
        [
          "wide cinematic shots",
          "medium character shots",
          "close-ups",
          "macro detail shots",
          "dramatic push-ins",
          "fast cuts"
        ],

      effects:
        [
          "punch zooms",
          "screen shakes on impact",
          "dramatic camera movement",
          "cinematic depth of field"
        ],

      character_consistency: true,

      reference_driven: true,

      avoid_generic_ai_video: true
    }
  };


  console.log(
    `[AHM V8] Sending ${jobId} to RunPod...`
  );


  const result = await request(
    url,
    "POST",
    {
      Authorization:
        `Bearer ${process.env.RUNPOD_API_KEY}`
    },
    {
      input
    }
  );


  if (!result.id) {
    throw new Error(
      "RunPod did not return a job ID."
    );
  }


  console.log(
    `[AHM V8] RunPod job created: ${result.id}`
  );


  /*
  -------------------------------------------------------
  WAIT FOR GPU GENERATION
  -------------------------------------------------------
  */

  const completed =
    await waitForRunPod(result.id);


  /*
  -------------------------------------------------------
  GET FINAL VIDEO
  -------------------------------------------------------
  */

  const finalVideoUrl =
    extractVideoUrl(
      completed.output
    );


  if (!finalVideoUrl) {

    console.log(
      "[AHM V8] RunPod completed but returned:",
      JSON.stringify(
        completed.output,
        null,
        2
      )
    );

    throw new Error(
      "RunPod completed the job but did not return a final video URL."
    );
  }


  console.log(
    `[AHM V8] Final video received: ${finalVideoUrl}`
  );


  return {
    mode: "runpod",

    workerJobId:
      result.id,

    finalVideoUrl,

    output:
      completed.output
  };
}


async function startVideoJob({ jobId, story }) {
  // The Hugging Face Space adapter creates one short silent clip. It is not the
  // complete AHM pipeline (scene continuity, narration, subtitles, final MP4).
  // Never let its presence masquerade as a full production worker.
  if (!isVideoProviderConfigured()) {
    const error = new Error(huggingFaceSpace.isConfigured()
      ? "The Hugging Face Space is connected for short silent clip experiments only. AHM's complete story renderer still needs the RunPod worker and its Gemini/storage configuration."
      : "The cinematic worker is not marked ready. Configure RunPod, Gemini and Supabase worker secrets, then set AHM_VIDEO_WORKER_READY=true in Vercel.");
    error.code = "VIDEO_PROVIDER_NOT_CONFIGURED";
    throw error;
  }
  if (!process.env.GEMINI_API_KEY) {
    const error = new Error("The video worker needs GEMINI_API_KEY in its RunPod environment.");
    error.code = "VIDEO_PROVIDER_NOT_CONFIGURED";
    throw error;
  }
  const result = await request(
    `https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}/run`,
    "POST",
    { Authorization: `Bearer ${process.env.RUNPOD_API_KEY}` },
    { input: { job_id: jobId, story, job_type: "ahm_complete_video" } }
  );
  if (!result.id) throw new Error("RunPod did not return a video job ID.");
  return { id: result.id, status: result.status || "IN_QUEUE" };
}

async function getVideoJob(jobId) {
  if (String(jobId || "").startsWith("hfspace_")) {
    return huggingFaceSpace.status(jobId);
  }
  if (!isVideoProviderConfigured()) {
    const error = new Error("The cinematic video worker is not marked ready. Complete worker and storage setup first.");
    error.code = "VIDEO_PROVIDER_NOT_CONFIGURED";
    throw error;
  }
  const result = await request(
    `https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}/status/${encodeURIComponent(jobId)}`,
    "GET",
    { Authorization: `Bearer ${process.env.RUNPOD_API_KEY}` }
  );
  if (result.status === "COMPLETED" && result.output?.status === "failed") {
    return { status: "failed", error: result.output.error || "The video worker failed." };
  }
  if (result.status === "COMPLETED") {
    const finalVideoUrl = extractVideoUrl(result.output);
    if (!finalVideoUrl) throw new Error("The worker completed without a final downloadable MP4 URL.");
    return {
      status: "completed",
      video: {
        finalVideoUrl,
        durationSec: result.output?.durationSec || null,
        sceneCount: result.output?.sceneCount || null,
        audio: result.output?.audio || null,
        format: result.output?.format || "mp4",
      },
    };
  }
  if (result.status === "FAILED" || result.status === "CANCELLED") {
    return {
      status: "failed",
      error: result.error || result.output?.error || `Video worker ${result.status.toLowerCase()}.`,
    };
  }
  return { status: String(result.status || "IN_QUEUE").toLowerCase() };
}

function isVideoProviderConfigured() {
  // "Configured" means the complete scene-by-scene worker is ready, not merely
  // that a single-clip Hugging Face Space has credentials.
  return Boolean(
    process.env.AHM_VIDEO_WORKER_READY === "true" &&
    process.env.RUNPOD_ENDPOINT_ID &&
    process.env.RUNPOD_API_KEY &&
    process.env.GEMINI_API_KEY
  );
}

module.exports = {
  generateVideo,
  startVideoJob,
  getVideoJob,
  isVideoProviderConfigured
};
