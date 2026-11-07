const crypto = require("crypto");

const { generateStoryPackage } = require("./providers/llm");
const { generateVideo } = require("./providers/video");
const { generateVoice } = require("./providers/voice");
const { publishTikTok, publishYouTube } = require("./providers/publisher");

const jobs = new Map();
const scriptBank = new Map();

/*
  AHM Studio V8.1
  Script Bank:
  - Users add story ideas in batches.
  - AHM selects an unused idea.
  - The LLM writes the complete final script.
  - The item is marked used only after the story is successfully written.
  - Failed jobs release the reserved idea.

  IMPORTANT:
  The fallback Map is NOT persistent on Vercel. For production unattended
  automation, connect SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and move
  long-term jobs/video storage to persistent storage.
*/

function normalizeText(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

function fingerprint(text) {
  return crypto.createHash("sha256").update(normalizeText(text).toLowerCase()).digest("hex");
}

function createBankItem(text) {
  return {
    id: `idea_${crypto.randomUUID()}`,
    text: normalizeText(text),
    fingerprint: fingerprint(text),
    status: "unused",
    createdAt: new Date().toISOString(),
    usedAt: null,
    jobId: null
  };
}

async function getScriptBank() {
  const items = [...scriptBank.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return {
    items,
    available: items.filter(x => x.status === "unused").length,
    used: items.filter(x => x.status === "used").length,
    reserved: items.filter(x => x.status === "reserved").length,
    total: items.length,
    persistent: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  };
}

async function addScriptBankItems(items) {
  const existing = new Set([...scriptBank.values()].map(x => x.fingerprint));
  let added = 0;

  for (const raw of items) {
    const text = normalizeText(raw);
    if (!text) continue;
    const fp = fingerprint(text);
    if (existing.has(fp)) continue;

    const item = createBankItem(text);
    scriptBank.set(item.id, item);
    existing.add(fp);
    added++;
  }

  return {
    added,
    skippedDuplicates: items.length - added,
    ...(await getScriptBank())
  };
}

async function deleteScriptBankItem(id) {
  const item = scriptBank.get(id);
  if (!item) throw new Error("Story idea not found.");
  if (item.status !== "unused") throw new Error("Only unused ideas can be deleted.");
  scriptBank.delete(id);
  return { ok: true, ...(await getScriptBank()) };
}

function reserveNextIdea(jobId) {
  const item = [...scriptBank.values()]
    .filter(x => x.status === "unused")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];

  if (!item) return null;

  item.status = "reserved";
  item.jobId = jobId;
  return item;
}

function markIdeaUsed(item, jobId) {
  if (!item) return;
  item.status = "used";
  item.usedAt = new Date().toISOString();
  item.jobId = jobId;
}

function releaseIdea(item) {
  if (!item) return;
  item.status = "unused";
  item.jobId = null;
}

function createJob(input) {
  const id = crypto.randomUUID();
  const job = {
    id,
    createdAt: new Date().toISOString(),
    status: "queued",
    progress: 0,
    stage: "Starting",
    input: { ...input },
    story: null,
    assets: null,
    video: null,
    voice: null,
    publishing: { tiktok: null, youtube: null },
    logs: []
  };

  if (input.source === "bank") {
    const item = reserveNextIdea(id);
    if (!item) {
      throw new Error("Your Story Bank is empty. Add more ideas or choose AI creates a fresh idea.");
    }
    job.input.bankItemId = item.id;
    job.input.bankItemText = item.text;
  }

  jobs.set(id, job);
  return job;
}

function update(job, patch) {
  Object.assign(job, patch);
}

function log(job, message) {
  job.logs.push({ at: new Date().toISOString(), message });
}

function getJob(id) {
  return jobs.get(id) || null;
}

function getHistory() {
  return [...jobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function previousStoryContext(currentJobId) {
  return getHistory()
    .filter(j => j.id !== currentJobId && j.story)
    .slice(0, 20)
    .map(j => ({
      title: j.story.title,
      idea: j.input?.bankItemText || j.input?.idea || "",
      kicker: j.story.kicker || ""
    }));
}

async function runPipeline(id) {
  const job = getJob(id);
  if (!job) throw new Error("Job not found");

  const bankItem = job.input.bankItemId ? scriptBank.get(job.input.bankItemId) : null;

  try {
    update(job, { status: "running", progress: 8, stage: "Writing the story" });

    let idea = job.input.idea;
    if (job.input.source === "bank") idea = job.input.bankItemText;
    if (job.input.source === "ai") idea = "";

    log(job, idea
      ? `AI is turning this idea into a complete short: "${idea}"`
      : "AI is inventing a fresh story concept because no bank idea was selected.");

    const story = await generateStoryPackage(
      idea,
      job.input.targetDuration,
      previousStoryContext(job.id)
    );

    if (!story || !story.narration) throw new Error("Story AI returned an incomplete story.");

    if (bankItem) markIdeaUsed(bankItem, job.id);

    update(job, { story, progress: 25, stage: "Planning visuals" });
    log(job, `Story duration selected: ${story.durationSec}s.`);
    log(job, `Planned ${story.scenes.length} scenes with recurring assets locked.`);

    const assets = buildAssetManifest(story);
    update(job, { assets, progress: 38, stage: "Generating 3D video" });

    const video = await generateVideo({ jobId: job.id, story });
    update(job, { video, progress: 68, stage: "Creating your voice narration" });

    const voice = await generateVoice({ jobId: job.id, script: story.narration });
    update(job, { voice, progress: 82, stage: "Editing subtitles, music and SFX" });

    const finalVideo = await finalize(job, video, voice, story);

    update(job, {
      video: finalVideo,
      progress: 100,
      stage: "Ready for review",
      status: "completed",
      publishing: {
        tiktok: { status: "awaiting_review" },
        youtube: { status: "awaiting_review" }
      }
    });

    log(job, "Video generation finished. Waiting for review before publishing.");
    return job;

  } catch (err) {
    releaseIdea(bankItem);
    update(job, { status: "failed", stage: "Error", error: err.message });
    log(job, `ERROR: ${err.message}`);
    return job;
  }
}

function buildAssetManifest(story) {
  return {
    style: "stylized-realistic cinematic 3D short-form storytelling",
    aspectRatio: "9:16",
    characters: story.characters || [],
    environments: story.environments || [],
    props: story.props || [],
    continuity: "Every recurring asset is reference-driven across scenes."
  };
}

async function finalize(job, video, voice, story) {
  if (String(process.env.DEMO_MODE).toLowerCase() === "true") {
    return {
      mode: "demo",
      finalVideoUrl: null,
      note: "Demo mode: generation/edit/publishing providers are not connected yet.",
      editPlan: {
        aspectRatio: "9:16",
        durationSec: story.durationSec,
        subtitles: true,
        music: true,
        sfx: true,
        zoomIns: (story.beats || []).filter(b => b.effect === "zoom"),
        screenShakes: (story.beats || []).filter(b => b.effect === "shake")
      }
    };
  }

  if (!video || !video.finalVideoUrl) {
    throw new Error("Video worker did not return a finalVideoUrl.");
  }

  return { ...video, voice };
}

async function runPublishing(id) {
  const job = getJob(id);
  if (!job) throw new Error("Job not found");
  if (job.status !== "completed") throw new Error("Video is not ready for publishing.");

  const publishing = {};
  publishing.tiktok = await publishTikTok(job.video, job.story);
  publishing.youtube = await publishYouTube(job.video, job.story);

  update(job, { publishing, stage: "Posted / posting status saved" });
  log(job, "Publishing action completed.");
  return job;
}

module.exports = {
  createJob,
  getJob,
  getHistory,
  runPipeline,
  runPublishing,
  getScriptBank,
  addScriptBankItems,
  deleteScriptBankItem
};
