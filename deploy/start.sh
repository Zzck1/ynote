#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker compose build
docker compose run --rm web python /app/deploy/verify_platform.py
docker compose up -d
