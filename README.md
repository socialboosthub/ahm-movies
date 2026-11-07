# AHM Studio

AHM Studio is a mobile-first, AI-directed short-form explainer and cinematic video production app.

## Production workflow

1. Gemini creates a fact-aware explainer plan, narration script, scene timings and continuity bible.
2. The RunPod Serverless worker generates a vertical 9:16 cinematic clip for every scene with Gemini Omni Flash.
3. Gemini 3.8 Flash TTS generates narration scene-by-scene, fits each voice segment to its scene timing, and automatically assigns character voices for dialogue (up to two speakers per scene).
4. Reference frames from earlier clips anchor recurring character appearances in later scenes. Each video clip contributes its own environmental sound and sound effects.
5. Captions use exact short phrases and are timed to measured speech duration; the final mix combines narration/dialogue, scene ambience, optional generated background music and burns subtitles into the MP4.
5. Optional Lyria 3.5 creates an original instrumental background score.
6. FFmpeg normalizes and joins the clips, mixes narration / scene audio / music, burns timed subtitles and exports an MP4.
7. The finished MP4 is uploaded to a private Supabase Storage bucket and returned as a signed download link.

The application does not claim a storyboard or placeholder render is a finished AI video.

The browser includes a reusable character library with create, edit, delete and include-in-future-plans controls. Character references are stored locally in IndexedDB and passed to the Director as visual-continuity data.

## Local development

1. Copy `.env.example` to `.env`.
2. Install Node dependencies: `npm install`.
3. Run the app: `npm start`.
4. Open the local URL shown by Node.

Run Node tests with `npm test`. Run worker tests with `python -m unittest discover -s test -p "test_worker.py"`.

## Provider setup

Read [PRODUCTION_SETUP.md](./PRODUCTION_SETUP.md) before connecting production credentials.

The Director requires `GEMINI_API_KEY`. The explainer planner tries the preferred model and then four alternate Flash models with bounded request timeouts when Google reports temporary overload.

The complete video workflow additionally requires:
- A RunPod Serverless endpoint built from `worker/Dockerfile`.
- `RUNPOD_ENDPOINT_ID` and `RUNPOD_API_KEY` in the Vercel project.
- `GEMINI_API_KEY`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the RunPod worker environment.
- A private Supabase Storage bucket. The worker creates it if it does not exist.
- Gemini API video-generation access and billing enabled for Gemini Omni Flash.

Optional background music requires `LYRIA_ENABLED=true` and Lyria API access. It is deliberately disabled by default to prevent unexpected charges.

## Environment variables

See `.env.example` for the complete list and which runtime receives each value. Never put API keys in browser JavaScript, HTML, public GitHub files or user-visible logs.

## Safety and publishing

AHM generates a downloadable video but does not automatically publish it to social accounts. Publishing should remain a separate explicit user action after review.

## Deployment boundaries

Development work is on `feature/ahm-autonomous-generation-foundation`. Production `main` is not modified or promoted automatically.
