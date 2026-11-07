# AHM Studio production worker

This is the real long-running video production worker used by AHM Studio's RunPod Serverless endpoint.

## What it does

1. Receives an AI Director story package from the Node API.
2. Expands long story scenes into supported 3–10 second video-generation segments.
3. Calls Gemini Omni Flash to create real vertical 9:16 cinematic video clips with scene ambience and sound effects.
4. Calls Gemini 3.8 Flash TTS to create scene-by-scene narration and character dialogue WAVs, preserving the selected narrator voice and character voice assignments.
5. Optionally calls Lyria 3.5 for an original instrumental background score when `LYRIA_ENABLED=true`.
6. Uses FFmpeg to normalize/concatenate the clips, mix narration and scene sound, mix optional Lyria music at the selected volume, burn in timed subtitles and export H.264/AAC MP4.
7. Uploads the final MP4 to private Supabase Storage and returns a signed download URL.

There is no placeholder-video fallback. If a required provider or storage service fails, the job returns a clear failed status instead of a fake completed video.

## Build and deploy

Build this directory as the Docker build context:

```sh
docker build -t ahm-studio-worker .
```

Push the image to your container registry and create a RunPod Serverless endpoint from it. The container entrypoint starts `runpod.serverless.start(handler)`.

## Worker secrets

Configure these in the RunPod endpoint environment:

- `GEMINI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUCKET=ahm-videos`
- `GEMINI_VIDEO_MODEL=gemini-omni-1.1-flash`
- `GEMINI_TTS_MODEL=gemini-3.8-flash-tts`
- `GEMINI_TTS_FALLBACK_MODEL=gemini-3.8-flash-lite-tts`
- `GEMINI_TTS_VOICE=Charon`
- `LYRIA_ENABLED=false` by default; set to `true` only after explicitly approving the paid Lyria music-generation cost

The worker needs enough execution time for the number of generated scenes and final FFmpeg render. The actual video model runs remotely through Gemini; the worker itself only orchestrates requests and performs CPU-based media assembly.
