#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.ghcr.yaml"

mkdir -p "$ROOT_DIR/volumes/games" "$ROOT_DIR/volumes/reaction" "/volume1/docker/gallery/db" "/volume1/docker/gallery/state"
touch "$ROOT_DIR/volumes/games/data.db" "$ROOT_DIR/volumes/reaction/data.db"

# Pull latest image tags and recreate containers
docker compose -f "$COMPOSE_FILE" pull
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

# Remove old dangling images and unreferenced layers
docker image prune -af

echo "Deployment update completed."
