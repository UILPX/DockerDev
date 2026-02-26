#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.ghcr.yaml"
ENV_FILE="$ROOT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy .env.example to .env first."
  exit 1
fi

mkdir -p "$ROOT_DIR/volumes/games" "$ROOT_DIR/volumes/reaction"
touch "$ROOT_DIR/volumes/games/data.db" "$ROOT_DIR/volumes/reaction/data.db"

# Pull latest image tags and recreate containers
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --remove-orphans

# Remove old dangling images and unreferenced layers
docker image prune -af

echo "Deployment update completed."
