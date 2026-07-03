#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${1:-/home/fredz/Documentos/CORE-Analytics/backups/docker-20260608-115824}"
FORCE="${2:-}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-core-analytics}"
DOCKER_BIN="${DOCKER_BIN:-docker}"

if ! command -v "${DOCKER_BIN%% *}" >/dev/null 2>&1; then
  echo "Docker nao encontrado. Instale o Docker e rode este script novamente." >&2
  exit 127
fi

if [ ! -d "$BACKUP_DIR" ]; then
  echo "Pasta de backup nao encontrada: $BACKUP_DIR" >&2
  exit 1
fi

required_files=(
  SHA256SUMS.txt
  postgres_data.tgz
  redis_data.tgz
  opensearch_data.tgz
  minio_data.tgz
)

for file in "${required_files[@]}"; do
  if [ ! -f "$BACKUP_DIR/$file" ]; then
    echo "Arquivo obrigatorio ausente: $BACKUP_DIR/$file" >&2
    exit 1
  fi
done

(
  cd "$BACKUP_DIR"
  sha256sum -c SHA256SUMS.txt
)

restore_volume() {
  local volume="$1"
  local archive="$2"

  $DOCKER_BIN volume create "$volume" >/dev/null

  local existing_count
  existing_count="$($DOCKER_BIN run --rm -v "$volume":/volume alpine sh -c 'find /volume -mindepth 1 -maxdepth 1 | wc -l')"

  if [ "$existing_count" != "0" ]; then
    if [ "$FORCE" != "--force" ]; then
      echo "Volume $volume ja contem dados. Rode novamente com --force para substituir." >&2
      exit 1
    fi
    $DOCKER_BIN run --rm -v "$volume":/volume alpine sh -c 'rm -rf /volume/* /volume/.[!.]* /volume/..?*'
  fi

  $DOCKER_BIN run --rm \
    -v "$volume":/volume \
    -v "$BACKUP_DIR":/backup:ro \
    alpine sh -c "cd /volume && tar -xzf /backup/$archive"
}

restore_volume "${PROJECT_NAME}_postgres_data" postgres_data.tgz
restore_volume "${PROJECT_NAME}_redis_data" redis_data.tgz
restore_volume "${PROJECT_NAME}_opensearch_data" opensearch_data.tgz
restore_volume "${PROJECT_NAME}_minio_data" minio_data.tgz

echo "Backup restaurado nos volumes do projeto Docker Compose: $PROJECT_NAME"
echo "Agora suba com: docker compose -f docker-compose.yml -f docker-compose.app.yml up -d"
