FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    YNOTE_CLOUD_DATA=/data \
    YNOTE_PLATFORM_PRICE_FILE=/app/backend/platform-price.json

# Debian distributes ffprobe in this package. The gateway validates MP3 only;
# cloud media/transcoding routes are disabled by cloud_entry.py.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home ynote \
    && mkdir /data \
    && chown ynote:ynote /data

WORKDIR /app
COPY requirements-cloud.txt /app/requirements-cloud.txt
RUN pip install --no-cache-dir --disable-pip-version-check -r /app/requirements-cloud.txt

# Explicit source allowlist: no COPY ., preview data, keystores, or .env.
COPY cloud_entry.py /app/cloud_entry.py
COPY deploy/ /app/deploy/
COPY backend/*.py /app/backend/
COPY backend/platform-price.json /app/backend/platform-price.json
COPY frontend/dist/ /app/frontend/dist/

USER 10001:10001
EXPOSE 8792
VOLUME ["/data"]
CMD ["python", "-m", "uvicorn", "cloud_entry:app_factory", "--factory", "--host", "0.0.0.0", "--port", "8792", "--workers", "1", "--limit-concurrency", "32", "--timeout-keep-alive", "5", "--no-access-log"]
