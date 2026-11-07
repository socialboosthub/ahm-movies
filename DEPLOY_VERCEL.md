# AHM Studio V8.0.1 — Vercel preview fix

This build fixes the Vercel crash caused by the Express server trying to call `app.listen()` inside a Vercel serverless function.

## Deploy
1. Upload/push this project to GitHub.
2. Import the repository into Vercel.
3. Framework preset: Other.
4. Build command: leave empty.
5. Output directory: leave empty.
6. Deploy.
7. Open `/api/health` on the deployed domain. It should return JSON with `ok: true`.

## Important
This fixes the Vercel preview/API architecture. It does **not** make long-running GPU generation or permanent video storage suitable for Vercel. Those will run on the dedicated backend/RunPod/storage architecture in the next stage.
