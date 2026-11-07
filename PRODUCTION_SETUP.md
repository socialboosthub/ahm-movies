# AHM Studio production setup

This document is the handoff checklist for enabling real end-to-end generation. No API keys are stored in GitHub, and no paid generation is triggered by the code changes alone.

## 1. Gemini API

Create or use a Google AI Studio API key.

- Vercel: set `GEMINI_API_KEY` for Preview and Production (only Preview is used while this branch is being tested).
- RunPod endpoint: set the same `GEMINI_API_KEY` as a worker secret.
- Director model: `gemini-3.8-flash`, with fallback models `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite`. The planner tries these sequentially with bounded timeouts when Google reports model-specific overload.
- Narration: `gemini-3.8-flash-tts`, fallback `gemini-3.8-flash-lite-tts`.

The text models have free-tier options, subject to Google quotas and availability.

## 2. Real video generation

The worker uses Gemini Omni Flash (`gemini-omni-1.1-flash`) to generate 3–10 second 9:16 clips, then joins the clips into the complete 30–120 second video.

**Billing warning:** Google lists Gemini Omni Flash as paid-tier only, with an effective video-output price of approximately US$0.10 per second at standard 720p pricing. Approximate video-model costs are therefore US$3 for 30 seconds, US$6 for 60 seconds and US$12 for 120 seconds, before other usage or taxes. Do not enable this until the budget is explicitly approved.

## 3. Background music

The worker supports original instrumental tracks from Lyria 3.5. It is disabled by default.

**Billing warning:** Google lists Lyria 3.5 at US$0.08 per generated song and no free tier. Set `LYRIA_ENABLED=true` in both Vercel and the RunPod worker only after approving this cost. When disabled, scene-generated ambience and sound effects are still mixed with the narrator, but there is no separate generated music track.

## 4. RunPod Serverless worker

1. Build and push the image from the `worker/` directory using `worker/Dockerfile`.
2. Create a RunPod Serverless endpoint using that image.
3. Configure the worker secrets:
   - `GEMINI_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_BUCKET=ahm-videos`
   - `GEMINI_VIDEO_MODEL=gemini-omni-1.1-flash`
   - `GEMINI_TTS_MODEL=gemini-3.8-flash-tts`
   - `GEMINI_TTS_FALLBACK_MODEL=gemini-3.8-flash-lite-tts`
   - `GEMINI_TTS_VOICE=Charon`
   - `LYRIA_ENABLED=false` until music billing is approved
4. Set the endpoint execution timeout high enough for multiple scene generations and FFmpeg assembly. A full video can take several minutes.
5. Copy the endpoint ID and API key into Vercel as `RUNPOD_ENDPOINT_ID` and `RUNPOD_API_KEY`. Set `AHM_VIDEO_WORKER_READY=true` in Vercel only after the worker image is deployed, worker secrets are saved and a real end-to-end render has passed.

The worker does not require a ComfyUI GPU model because Gemini Omni generates the clips remotely; the worker handles orchestration, FFmpeg and storage.

## 5. Supabase Storage

Create a Supabase project and use its project URL and service-role key as RunPod secrets. The worker creates a private `ahm-videos` bucket if missing, uploads the final MP4 and returns a seven-day signed URL. Keep the service-role key private and never place it in the browser or Vercel frontend variables.

## 6. API abuse protection

The Node API applies per-IP in-memory limits to Director planning, story planning and video job creation. This is a basic safeguard for preview and single-instance use; serverless instances do not share this memory. Before opening paid generation to the public, add shared persistent rate limiting and user authentication/quotas (for example, Redis-backed limits or Supabase Auth) so visitors cannot spend the owner's generation budget.

## 7. Final verification checklist

- [ ] Director generates a valid plan on the preview deployment.
- [ ] A RunPod job is accepted and reaches the worker.
- [ ] Every scene returns an actual MP4 clip (not a placeholder).
- [ ] Narration WAV is generated and readable.
- [ ] Scene ambience/SFX is present.
- [ ] Optional Lyria music is present only when enabled.
- [ ] Subtitle file is valid and captions are burned into the video.
- [ ] FFmpeg produces a non-empty H.264/AAC MP4.
- [ ] MP4 uploads to private Supabase Storage and signed URL plays.
- [ ] Final duration is 30–120 seconds and portrait 9:16.
- [ ] No social post is made without the user's separate approval.

Until the external credentials and paid video access are configured, code-level tests can verify the pipeline logic but cannot honestly certify a real rendered video.
