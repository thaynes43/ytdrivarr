# ytdrivarr Peloton worker (M3) — hardened Selenium/Chromium scraper.
# Build context is the REPO ROOT (mirrors publish.yml): `docker build -f worker/Dockerfile .`
# Image: ghcr.io/thaynes43/ytdrivarr-peloton-worker
FROM python:3.13-slim

ARG VERSION=0.1.0
LABEL org.opencontainers.image.title="ytdrivarr-peloton-worker" \
      org.opencontainers.image.description="Hardened out-of-process Peloton discovery/refresh worker for ytdrivarr (M3)." \
      org.opencontainers.image.source="https://github.com/thaynes43/ytdrivarr" \
      org.opencontainers.image.version="${VERSION}"

# The donor's proven image lineage: python:3.13-slim + chromium + chromium-driver + ffmpeg.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        chromium-driver \
        ffmpeg \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    CHROMIUM_BINARY=/usr/bin/chromium \
    CHROMEDRIVER_PATH=/usr/bin/chromedriver \
    WORKER_HEADLESS=true

WORKDIR /app

# Install the package (src layout). Copy only what the build needs so a source
# edit doesn't bust the apt layer.
COPY worker/pyproject.toml worker/README.md ./
COPY worker/src ./src
RUN pip install --no-cache-dir .

# Non-root runtime user; Chromium needs a writable HOME for its profile dir.
RUN useradd --create-home --uid 10001 worker \
    && mkdir -p /home/worker /tmp/pelo-out \
    && chown -R worker:worker /home/worker /tmp/pelo-out
USER worker
ENV HOME=/home/worker

# Default: the long-poll worker loop. Override CMD for the validation dry-run:
#   docker run ... python -m ytdrivarr_peloton_worker.validate --activities Cycling --scratch /tmp/pelo-out
ENTRYPOINT ["python", "-m"]
CMD ["ytdrivarr_peloton_worker"]
