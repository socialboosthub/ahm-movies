"""Modal deployment for AHM Movies.

The HTTP API handles uploads/status requests. Each movie is processed by a separate
Modal function invocation so long-running FFmpeg/transcription work does not depend
on the lifetime of an HTTP response or FastAPI BackgroundTasks.
"""
from pathlib import Path
import asyncio
import modal

WORKER_DIR = Path(__file__).resolve().parent

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "fonts-dejavu-core", "libgomp1")
    .pip_install_from_requirements(str(WORKER_DIR / "requirements.txt"))
    .add_local_file(
        str(WORKER_DIR / "movie_api.py"),
        remote_path="/root/movie_api.py",
    )
)

app = modal.App("ahm-movies-worker")
worker_secrets = [modal.Secret.from_name("ahm-movies-secrets")]


@app.function(
    image=image,
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
    image=image,
    secrets=worker_secrets,
    cpu=1,
    memory=2048,
    timeout=3600,
    scaledown_window=120,
)
@modal.asgi_app()
def fastapi_app():
    from movie_api import app as api

    # Modal's .spawn() creates an independent function call for every movie.
    api.state.dispatch_job = process_movie.spawn
    return api
