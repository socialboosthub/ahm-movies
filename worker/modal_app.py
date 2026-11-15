"""Modal deployment for the AHM Movies recap worker.

The worker API stays in worker/movie_api.py. Modal supplies the container runtime,
public HTTPS endpoint, long-running request timeout, and private environment secrets.
"""
from pathlib import Path

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


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("ahm-movies-secrets")],
    cpu=4,
    memory=16384,
    ephemeral_disk=102400,
    timeout=86400,
    max_containers=1,
    scaledown_window=120,
)
@modal.asgi_app()
def fastapi_app():
    from movie_api import app as api

    return api
