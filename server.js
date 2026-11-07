require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { startStoryGeneration, getStoryGeneration, startExplainerGeneration, getExplainerGeneration, isStoryProviderConfigured } = require("./lib/providers/llm");
const { startVideoJob, getVideoJob, isVideoProviderConfigured } = require("./lib/providers/video");
const { generateFreeVoiceover } = require("./lib/providers/voice");

const app = express();
const rateLimitBuckets = new Map();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

function createRateLimiter(name, maxRequests, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const ip = String(req.ip || req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
    const key = name + ":" + ip;
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitBuckets.set(key, bucket);
    }
    if (bucket.count >= maxRequests) {
      const retrySeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.set("Retry-After", String(retrySeconds));
      return res.status(429).json({
        ok: false,
        error: "AHM is receiving too many requests from this connection. Please wait before trying again."
      });
    }
    bucket.count++;
    if (rateLimitBuckets.size > 5000) {
      for (const [bucketKey, value] of rateLimitBuckets) {
        if (now >= value.resetAt) rateLimitBuckets.delete(bucketKey);
      }
    }
    next();
  };
}

const limitExplainerPlans = createRateLimiter("explainer-plan", 8, 15 * 60 * 1000);
const limitVideoJobs = createRateLimiter("video-job", 3, 10 * 60 * 1000);
const limitStoryPlans = createRateLimiter("story-plan", 5, 15 * 60 * 1000);
const limitVoiceover = createRateLimiter("free-voiceover", 5, 10 * 60 * 1000);

app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "AHM Studio",
    version: "9.0.0",
    storyProvider: isStoryProviderConfigured() ? "configured" : "not_configured",
    videoProvider: isVideoProviderConfigured() ? "configured" : "not_configured",
    voiceProvider: isStoryProviderConfigured() ? "configured" : "not_configured",
    musicProvider: process.env.LYRIA_ENABLED === "true" && isVideoProviderConfigured() ? "enabled" : "optional_not_enabled"
  });
});


app.post("/api/free-voiceover", limitVoiceover, async (req, res) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const voice = typeof req.body?.voice === "string" ? req.body.voice : "Kore";
    const style = typeof req.body?.style === "string" ? req.body.style : "";
    if (!text) return res.status(400).json({ ok: false, error: "Add narration before generating a voice-over." });
    if (text.length > 9000) return res.status(400).json({ ok: false, error: "Keep narration under 9,000 characters for this free voice request." });
    const audio = await generateFreeVoiceover({ text, voice, style });
    return res.json({ ok: true, ...audio });
  } catch (error) {
    const status = error.code === "VOICE_PROVIDER_NOT_CONFIGURED" ? 503 : (error.statusCode || 502);
    console.error("AHM free voice-over failed:", error.message);
    return res.status(status).json({ ok: false, error: error.message || "Could not generate the AI voice-over." });
  }
});

app.post("/api/explainer/plan", limitExplainerPlans, async (req, res) => {
  try {
    const topic = typeof req.body?.topic === "string" ? req.body.topic.trim() : "";
    const targetDuration = typeof req.body?.targetDuration === "string"
      ? req.body.targetDuration.slice(0, 40) : "natural";
    if (!topic) return res.status(400).json({ error: "Enter a topic or question for AHM to explain." });
    if (topic.length > 6000) {
      return res.status(400).json({ error: "Please keep your topic under 6,000 characters." });
    }
    const characterReferences = Array.isArray(req.body?.characterReferences)
      ? req.body.characterReferences.slice(0, 8).filter(item =>
          item && typeof item.name === "string" && typeof item.description === "string"
        ).map(item => ({
          name: item.name.trim().slice(0, 80),
          description: item.description.trim().slice(0, 1600)
        })).filter(item => item.name && item.description)
      : [];
    const result = await startExplainerGeneration(topic, targetDuration, characterReferences);
    return res.status(202).json({
      ok: true,
      status: result.status || "in_progress",
      jobId: result.id
    });
  } catch (error) {
    const status = error.code === "STORY_PROVIDER_NOT_CONFIGURED" ? 503 : 502;
    console.error("AHM explainer job start failed:", error.message);
    return res.status(status).json({ error: error.message || "Could not start explainer planning." });
  }
});

app.post("/api/explainer/video", limitVideoJobs, async (req, res) => {
  try {
    const story = req.body?.story;
    if (!story || !Array.isArray(story.scenes) || !story.scenes.length) {
      return res.status(400).json({ ok: false, error: "Generate a complete AI Director plan before creating the video." });
    }
    const hasSpokenContent = Boolean(String(story.narration || "").trim()) ||
      story.scenes.some(scene =>
        Boolean(String(scene.narration || "").trim()) ||
        (Array.isArray(scene.dialogue) && scene.dialogue.some(line =>
          line && typeof line === "object" && String(line.line || line.text || "").trim()
        ))
      );
    if (!story.title || !hasSpokenContent) {
      return res.status(400).json({ ok: false, error: "The AI Director plan needs a title and at least one narration or dialogue line." });
    }
    const allowedVoices = new Set(["Charon", "Kore", "Puck", "Aoede", "Fenrir", "Zephyr", "Leda", "Orus"]);
    const voice = typeof req.body?.voice === "string" ? req.body.voice : "Charon";
    if (!allowedVoices.has(voice)) {
      return res.status(400).json({ ok: false, error: "Choose a supported AHM narrator voice." });
    }
    const musicEnabled = req.body?.musicEnabled === true;
    if (musicEnabled && process.env.LYRIA_ENABLED !== "true") {
      return res.status(503).json({
        ok: false,
        error: "Original background music is selected, but Lyria is not enabled for this deployment. It is a paid music service and must be explicitly configured first."
      });
    }
    const requestedMusicVolume = Number(req.body?.musicVolume ?? 12);
    const musicVolume = Number.isFinite(requestedMusicVolume)
      ? Math.min(35, Math.max(0, requestedMusicVolume)) / 100
      : 0.12;
    const productionStory = {
      ...story,
      productionSettings: { voice, musicEnabled, musicVolume }
    };
    const jobId = crypto.randomUUID();
    const job = await startVideoJob({ jobId, story: productionStory });
    return res.status(202).json({ ok: true, jobId: job.id, status: job.status });
  } catch (error) {
    const status = error.code === "VIDEO_PROVIDER_NOT_CONFIGURED" ? 503 : 502;
    console.error("AHM video job start failed:", error.message);
    return res.status(status).json({ ok: false, error: error.message || "Could not start cinematic video generation." });
  }
});

app.get("/api/explainer/video/:jobId", async (req, res) => {
  try {
    const jobId = String(req.params.jobId || "");
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(jobId)) {
      return res.status(400).json({ ok: false, error: "Invalid video job ID." });
    }
    const result = await getVideoJob(jobId);
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error("AHM video job status failed:", error.message);
    return res.status(502).json({ ok: false, error: error.message || "Could not check video generation status." });
  }
});

app.get("/api/explainer/plan/:jobId", async (req, res) => {
  try {
    const result = await getExplainerGeneration(req.params.jobId);
    if (result.status !== "completed") return res.json({ ok: true, status: result.status });
    return res.json({
      ok: true,
      status: "completed",
      story: result.story,
      video: isVideoProviderConfigured()
        ? { status: "ready", message: "The production worker is connected. You can generate the complete cinematic MP4." }
        : { status: "not_configured", message: "The AI plan is ready, but the RunPod video worker and storage must be configured before rendering." }
    });
  } catch (error) {
    console.error("AHM explainer job check failed:", error.message);
    return res.status(502).json({ error: error.message || "Could not check explainer generation." });
  }
});

app.post("/api/story/plan", limitStoryPlans, async (req, res) => {
  try {
    const idea = typeof req.body?.idea === "string" ? req.body.idea.trim() : "";
    const targetDuration = typeof req.body?.targetDuration === "string"
      ? req.body.targetDuration.slice(0, 40) : "natural";
    if (idea.length > 6000) {
      return res.status(400).json({ error: "Please keep your story idea under 6,000 characters." });
    }
    const job = await startStoryGeneration(idea, targetDuration);
    return res.status(202).json({ ok: true, jobId: job.id, status: job.status });
  } catch (error) {
    const status = error.code === "STORY_PROVIDER_NOT_CONFIGURED" ? 503 : 502;
    console.error("AHM story job start failed:", error.message);
    return res.status(status).json({ error: error.message || "Could not start story planning." });
  }
});

app.get("/api/story/plan/:jobId", async (req, res) => {
  try {
    const result = await getStoryGeneration(req.params.jobId);
    if (result.status !== "completed") return res.json({ ok: true, status: result.status });
    return res.json({
      ok: true,
      status: "completed",
      story: result.story,
      video: isVideoProviderConfigured()
        ? { status: "ready", message: "The production worker is connected. You can generate the complete cinematic MP4." }
        : { status: "not_configured", message: "The story plan is ready, but the RunPod video worker and storage must be configured before rendering." }
    });
  } catch (error) {
    console.error("AHM story job check failed:", error.message);
    return res.status(502).json({ error: error.message || "Could not check story generation." });
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found." });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, "0.0.0.0", () => console.log(`AHM Studio running on port ${port}`));
}

module.exports = app;
