# AHM Movies

Movie-to-recap editor using only footage from the uploaded original movie.

## Implemented workflow
1. Browser requests a short-lived Cloudflare R2 upload URL from Vercel.
2. Browser uploads the full movie directly to R2, bypassing Vercel request-size limits.
3. Vercel starts a background job on the separate processing worker.
4. Worker downloads the full movie, extracts its audio with FFmpeg, and transcribes the entire film using faster-whisper.
5. Transcript is summarized in chronological windows and sent to an OpenAI-compatible LLM (default Groq) to create timestamped recap beats that include the actual ending.
6. Edge TTS generates narration; faster-whisper word timestamps from the generated narration drive subtitle phrase timing.
7. FFmpeg selects only original movie footage by source timestamps, crops to 3:4, burns bold white uppercase italic subtitles, and creates three MP4 files.
8. Exports are stored in R2 and returned as temporary download links.

## Deployment configuration

### Cloudflare R2
Create a private bucket and scoped read/write key. Configure on both Vercel and Render: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.

### Render worker
Deploy `render.yaml` as a Blueprint. Set `RECAP_WORKER_TOKEN` to a long random secret, add `GROQ_API_KEY`, and configure the R2 values. The worker uses CPU faster-whisper (`small`, `int8`) by default; long movies may take significant time and need a persistent service with sufficient RAM/CPU.

### Vercel
Set `RECAP_WORKER_URL` to the Render service URL, plus the same `RECAP_WORKER_TOKEN` and R2 variables. Deploy the `feature/movie-recap-rebuild` branch as a Preview and test a movie before promoting to production.

## Operational limitations
- No paid service is activated by this repository. Groq/Render/R2 usage may incur charges according to the selected plans.
- Worker job state is currently held in process memory; a worker restart during processing loses that job status.
- Subtitle phrases use word-level timestamps from the generated voice audio.
- Only process movies you have permission to use.
