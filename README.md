# AHM Movies

Movie-to-recap editor using only footage from the uploaded original movie.

## Processing workflow
1. The browser requests a short-lived Cloudflare R2 upload URL from Vercel.
2. The browser uploads the original movie directly to the private R2 bucket.
3. Vercel starts a job on the separate AHM processing worker.
4. The worker downloads the movie, extracts the complete audio with FFmpeg, and transcribes the movie using Groq Whisper (with local faster-whisper as a fallback).
5. The transcript is analysed chronologically with Groq to create a recap that covers the actual ending.
6. Edge TTS creates narration; word timestamps drive subtitle timing.
7. FFmpeg uses only footage from the original movie, crops to 3:4, adds subtitles, and renders three MP4 episodes.
8. The three exports are stored in R2 and returned as temporary download links.

## Recommended free worker: Kaggle GPU

The repository includes `kaggle/AHM_Movies_Kaggle_Worker.ipynb`.

1. Open the notebook in Kaggle and turn **Internet ON**.
2. Select a GPU accelerator in Notebook Settings (P100/T4 availability depends on Kaggle's current quota).
3. Run the notebook from the first cell in order.
4. Enter the existing R2 and Groq credentials only in the private prompts.
5. Copy the generated worker token and temporary tunnel URL into the Vercel **Preview** environment for branch `feature/kaggle-worker`:
   - `RECAP_WORKER_URL` = printed trycloudflare URL, without a trailing slash
   - `RECAP_WORKER_TOKEN` = generated token
6. Keep the Kaggle session running while a movie is processing.

The notebook stops if no GPU is detected; it will not silently run a long movie job on CPU. Kaggle's free GPU quota, internet availability, and session duration are controlled by Kaggle and are not guaranteed. A stopped/restarted session interrupts jobs and creates a new temporary tunnel URL/token. Test the Preview deployment with a short clip before attempting a full movie. Do not switch Production until the complete three-part workflow has been verified.

## Cloudflare R2

Keep the bucket private and use a scoped read/write key. Vercel needs:
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`

For browser uploads, configure R2 CORS to allow the exact AHM Vercel origin, `PUT`, request header `Content-Type`, and expose response header `ETag`.

## Vercel

Keep the existing Vercel app and R2 environment variables. Set `RECAP_WORKER_URL` and `RECAP_WORKER_TOKEN` for the Kaggle Preview branch first. The worker URL and token are session-specific; update them after starting a new Kaggle session.

## Operational limitations

- Kaggle GPU availability and session limits are not guaranteed on the free tier.
- Worker job state is held in process memory; a worker restart loses active job status.
- Export download links expire after seven days.
- Only process movies you have permission to use.
