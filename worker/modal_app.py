# Health verification enabled in the deployment workflow.
# Redeploy marker: refresh Modal containers after R2 secret rotation.
# Redeploy marker: restart worker after recap visual-matching pipeline changes.
# Redeploy to expose complete worker-side processing errors in Modal logs.
"""Modal deployment for AHM Movies.

The HTTP API handles uploads/status requests. Each movie is processed by a separate
Modal function invocation so long-running FFmpeg/transcription work does not depend
on the lifetime of an HTTP response or FastAPI BackgroundTasks.
"""
from pathlib import Path
import asyncio
import modal

WORKER_DIR = Path(__file__).resolve().parent

worker_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "fonts-dejavu-core", "libgomp1", "espeak-ng")
    .pip_install_from_requirements(str(WORKER_DIR / "requirements.txt"))
    .add_local_file(
        str(WORKER_DIR / "movie_api.py"),
        remote_path="/root/movie_api.py",
    )
)

# Keep the API container small and fast to cold-start; heavy movie libraries
# (Whisper, FFmpeg and Edge TTS) are installed only in the processing image.
api_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "fastapi==0.115.14",
        "uvicorn[standard]==0.34.3",
        "boto3==1.38.46",
        "httpx==0.28.1",
        "requests==2.32.4",
        "python-multipart==0.0.20",
    )
    .add_local_file(
        str(WORKER_DIR / "movie_api.py"),
        remote_path="/root/movie_api.py",
    )
)

app = modal.App("ahm-movies-worker")
worker_secrets = [modal.Secret.from_name("ahm-movies-secrets")]


@app.function(
    image=worker_image,
    secrets=worker_secrets,
    cpu=4,
    memory=16384,
    timeout=86400,
    max_containers=1,
)
def process_movie(job_id: str, payload: dict):
    """Run one movie recap independently of the web API container."""
    from movie_api import load_job, process

    # Rehydrate the queued job from R2 into this fresh function container.
    if load_job(job_id) is None:
        raise RuntimeError(f"Queued job {job_id} was not found in persistent storage.")
    asyncio.run(process(job_id, payload))


@app.function(
    image=api_image,
    secrets=worker_secrets,
    cpu=1,
    memory=2048,
    timeout=3600,
    startup_timeout=300,
    scaledown_window=120,
)
@modal.concurrent(max_inputs=20)
@modal.asgi_app()
def fastapi_app():
    # Keep a tiny health responder independent from movie_api imports. The previous
    # health checks hung while the API container initialized, so this dispatcher
    # loads the full routes only when an actual API path is requested.
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse

    health_app = FastAPI(title="AHM Movies Worker Health")

    @health_app.get("/")
    @health_app.get("/health")
    async def health():
        required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "RECAP_WORKER_TOKEN"]
        configured = all(__import__("os").getenv(key, "").strip() for key in required)
        return JSONResponse({
            "ok": configured,
            "service": "ahm-movies-worker",
            "storage_configured": all(__import__("os").getenv(key, "").strip() for key in required[:4]),
            "worker_token_configured": bool(__import__("os").getenv("RECAP_WORKER_TOKEN", "").strip()),
            "llm_configured": bool(__import__("os").getenv("GROQ_API_KEY", "").strip()),
        }, status_code=200 if configured else 503)

    api_holder = {"app": None}

    async def dispatch(scope, receive, send):
        if scope.get("type") == "http" and scope.get("path") in ("/", "/health"):
            await health_app(scope, receive, send)
            return
        if api_holder["app"] is None:
            from movie_api import app as api
            api.state.dispatch_job = lambda job_id, payload: process_movie.spawn(job_id, payload)
            api_holder["app"] = api
            print("AHM_API_LAZY_IMPORT_READY", flush=True)
        await api_holder["app"](scope, receive, send)

    return dispatch
