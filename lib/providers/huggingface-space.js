"use strict";

const JOB_PREFIX = "hfspace_";

function isConfigured() {
  return Boolean(
    process.env.HF_VIDEO_TOKEN &&
    process.env.HF_VIDEO_SPACE_URL &&
    process.env.HF_VIDEO_API_NAME &&
    process.env.HF_VIDEO_INPUTS_JSON
  );
}

function config() {
  if (!isConfigured()) {
    const error = new Error(
      "Hugging Face video generation is not connected yet. Add HF_VIDEO_TOKEN, HF_VIDEO_SPACE_URL, HF_VIDEO_API_NAME and HF_VIDEO_INPUTS_JSON in Vercel."
    );
    error.code = "VIDEO_PROVIDER_NOT_CONFIGURED";
    throw error;
  }
  const base = String(process.env.HF_VIDEO_SPACE_URL).replace(/\/+$/, "");
  const apiName = String(process.env.HF_VIDEO_API_NAME).startsWith("/")
    ? String(process.env.HF_VIDEO_API_NAME)
    : "/" + process.env.HF_VIDEO_API_NAME;
  let template;
  try { template = JSON.parse(process.env.HF_VIDEO_INPUTS_JSON); }
  catch {
    const error = new Error("HF_VIDEO_INPUTS_JSON must be a valid JSON array matching the selected Hugging Face Space API.");
    error.code = "VIDEO_PROVIDER_CONFIGURATION_INVALID";
    throw error;
  }
  if (!Array.isArray(template)) {
    const error = new Error("HF_VIDEO_INPUTS_JSON must be a JSON array.");
    error.code = "VIDEO_PROVIDER_CONFIGURATION_INVALID";
    throw error;
  }
  return { base, apiName, template, token: process.env.HF_VIDEO_TOKEN };
}

function replaceTokens(value, values) {
  if (Array.isArray(value)) return value.map(item => replaceTokens(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTokens(item, values)]));
  }
  if (typeof value !== "string") return value;
  const exactToken = value.match(/^\\{\\{(PROMPT|NEGATIVE_PROMPT|DURATION|SEED|WIDTH|HEIGHT|TITLE)\\}\\}$/);
  if (exactToken) {
    const key = exactToken[1];
    return ["DURATION", "SEED", "WIDTH", "HEIGHT"].includes(key)
      ? Number(values[key] ?? 0)
      : String(values[key] ?? "");
  }
  return value.replace(/\\{\\{(PROMPT|NEGATIVE_PROMPT|DURATION|SEED|WIDTH|HEIGHT|TITLE)\\}\\}/g,
    (_match, key) => String(values[key] ?? ""));
}
function encodeJob(payload) {
  return JOB_PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeJob(jobId) {
  if (!String(jobId || "").startsWith(JOB_PREFIX)) return null;
  try {
    const value = JSON.parse(Buffer.from(String(jobId).slice(JOB_PREFIX.length), "base64url").toString("utf8"));
    if (!value.base || !value.apiName || !value.eventId) return null;
    return value;
  } catch { return null; }
}

async function hfRequest(url, options, token, timeoutMs = 25000) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: "Bearer " + token
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error || parsed.message || text;
    } catch {}
    throw new Error("Hugging Face Space returned HTTP " + response.status + ": " + String(detail).slice(0, 500));
  }
  return text;
}

function extractVideo(value, base) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractVideo(item, base);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value) && /\.(mp4|webm|mov)(\?|$)/i.test(value)) return value;
    if (/\.(mp4|webm|mov)$/i.test(value)) return base + "/gradio_api/file=" + encodeURIComponent(value);
    return null;
  }
  if (typeof value !== "object") return null;
  const candidates = [value.url, value.video, value.path, value.name, value.value, value.data];
  for (const candidate of candidates) {
    const found = extractVideo(candidate, base);
    if (found) return found;
  }
  return null;
}

async function start({ story }) {
  const cfg = config();
  const duration = Math.max(30, Math.min(120, Number(story.durationSec) || 30));
  const values = {
    PROMPT: [
      "Create a vertical 9:16 glossy stylized-realistic 3D animated documentary short.",
      "No text, captions, logos or watermarks. Characters emote and gesture; they do not speak.",
      "Strong readable physical action, expressive character acting, cinematic warm lighting, detailed PBR materials, dramatic camera motion.",
      "Story title: " + String(story.title || "AHM short"),
      "Narration context: " + String(story.narration || "").slice(0, 1400),
      "Visual direction: " + String(story.visualApproach || ""),
      "Maintain the same character identity: " + JSON.stringify(story.characters || []).slice(0, 1400)
    ].join("\n"),
    NEGATIVE_PROMPT: "static image, slideshow, still character, text, subtitles, watermark, logo, deformed anatomy, extra limbs, low detail, flicker, inconsistent character",
    DURATION: Math.min(5, Math.max(2, Number(process.env.HF_VIDEO_CLIP_SECONDS) || 4)),
    SEED: Math.floor(Math.random() * 2147483647),
    WIDTH: 480,
    HEIGHT: 832,
    TITLE: String(story.title || "AHM short")
  };
  const data = replaceTokens(cfg.template, values);
  const responseText = await hfRequest(
    cfg.base + "/gradio_api/call" + cfg.apiName,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) },
    cfg.token
  );
  let response;
  try { response = JSON.parse(responseText); }
  catch { throw new Error("Hugging Face Space returned an invalid job response."); }
  if (!response.event_id) throw new Error(response.error || "Hugging Face Space did not return a queued job ID.");
  return {
    id: encodeJob({ base: cfg.base, apiName: cfg.apiName, eventId: response.event_id }),
    status: "IN_QUEUE",
    provider: "huggingface-space"
  };
}

async function status(jobId) {
  const job = decodeJob(jobId);
  if (!job) throw new Error("Invalid Hugging Face video job ID.");
  const token = process.env.HF_VIDEO_TOKEN;
  if (!token) throw new Error("HF_VIDEO_TOKEN is missing from this deployment.");
  const url = job.base + "/gradio_api/call" + job.apiName + "/" + encodeURIComponent(job.eventId);
  let stream;
  try {
    // Gradio holds this request open during queued GPU inference. Keep each
    // check short enough for serverless functions; the browser polls again.
    stream = await hfRequest(url, { method: "GET", headers: { Accept: "text/event-stream" } }, token, 8000);
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return { status: "in_progress" };
    throw error;
  }
  const events = stream.split(/\r?\n\r?\n/).filter(Boolean);
  let completedData = null;
  for (const block of events) {
    const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const dataLine = block.split(/\r?\n/).find(line => line.startsWith("data:"));
    if (event === "error") {
      const message = dataLine ? dataLine.slice(5).trim() : "Hugging Face video generation failed.";
      throw new Error(message.slice(0, 700));
    }
    if (event === "complete" && dataLine) {
      try { completedData = JSON.parse(dataLine.slice(5).trim()); }
      catch { throw new Error("Hugging Face returned an unreadable completed video result."); }
    }
  }
  if (completedData === null) return { status: "in_progress" };
  const finalVideoUrl = extractVideo(completedData, job.base);
  if (!finalVideoUrl) {
    throw new Error("Hugging Face finished, but its Space did not return a downloadable video file. Check the Space output type and API mapping.");
  }
  return {
    status: "completed",
    video: { finalVideoUrl, format: "mp4", provider: "huggingface-space" }
  };
}

module.exports = { isConfigured, start, status, decodeJob };
