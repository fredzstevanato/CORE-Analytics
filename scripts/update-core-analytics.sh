#!/usr/bin/env sh
set -eu

BRANCH="main"
SKIP_GIT_PULL=0
NO_CACHE=0
SKIP_BACKUP=0
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-300}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --skip-git-pull)
      SKIP_GIT_PULL=1
      shift
      ;;
    --no-cache)
      NO_CACHE=1
      shift
      ;;
    --skip-backup)
      SKIP_BACKUP=1
      shift
      ;;
    --health-timeout-seconds)
      HEALTH_TIMEOUT_SECONDS="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

# When running inside a Docker container, COMPOSE_WORKDIR points to the
# host directory that holds the compose files (mounted at /host/compose).
# Use it as the working directory for all docker compose commands so the
# correct project context is used even from inside the container.
if [ -n "${COMPOSE_WORKDIR:-}" ] && [ -d "/host/compose" ]; then
  COMPOSE_DIR="/host/compose"
  echo "==> Running in container mode. Compose workdir: $COMPOSE_WORKDIR (mounted at $COMPOSE_DIR)"
else
  COMPOSE_DIR="$ROOT_DIR"
fi

cd "$ROOT_DIR"

if [ ! -f "$COMPOSE_DIR/.env" ]; then
  echo "Missing .env file in $COMPOSE_DIR" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Install Docker first." >&2
  exit 127
fi

dockerized_git() {
  docker run --rm \
    -v "$COMPOSE_DIR:/workspace" \
    -w /workspace \
    alpine/git:2.47.2 \
    git -c safe.directory=/workspace "$@"
}

run_git() {
  if command -v git >/dev/null 2>&1; then
    (cd "$COMPOSE_DIR" && git "$@")
    return
  fi

  echo "Host git not found. Using git from container alpine/git:2.47.2"
  dockerized_git "$@"
}

echo ""
echo "==> Checking Docker"
docker version >/dev/null
docker compose version >/dev/null

if [ "$SKIP_GIT_PULL" -eq 0 ]; then
  if [ ! -d "$COMPOSE_DIR/.git" ]; then
    echo "This folder is not a Git repository yet. Run this from a cloned GitHub repository, or pass --skip-git-pull." >&2
    exit 1
  fi

  echo ""
  echo "==> Fetching latest code from origin/$BRANCH"
  run_git fetch origin "$BRANCH"

  echo ""
  echo "==> Updating local branch with fast-forward only"
  run_git pull --ff-only origin "$BRANCH"
fi

COMPOSE_FILES="--project-directory $COMPOSE_DIR -f $COMPOSE_DIR/docker-compose.yml -f $COMPOSE_DIR/docker-compose.app.yml"

wait_container_healthy() {
  container_name="$1"
  timeout_seconds="$2"
  start_time="$(date +%s)"

  while :; do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_name" 2>/dev/null || true)"
    case "$state" in
      healthy|running)
        return 0
        ;;
      unhealthy|exited|dead)
        echo "$container_name is $state." >&2
        return 1
        ;;
    esac

    now="$(date +%s)"
    if [ $((now - start_time)) -ge "$timeout_seconds" ]; then
      echo "Timed out waiting for $container_name to become healthy after $timeout_seconds seconds." >&2
      return 1
    fi

    sleep 5
  done
}

echo ""
echo "==> Validating Docker Compose configuration"
docker compose $COMPOSE_FILES config --quiet

if [ "$SKIP_BACKUP" -eq 0 ]; then
  echo ""
  echo "==> Preparing PostgreSQL for backup"
  docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/docker-compose.yml" up -d postgres
  wait_container_healthy core-postgres "$HEALTH_TIMEOUT_SECONDS"

  echo ""
  echo "==> Creating PostgreSQL backup before local update"
  BACKUP_DIR="$(sed -n 's/^CORE_BACKUP_DIR=//p' "$COMPOSE_DIR/.env" | tail -n 1 | tr -d '\r')"
  if [ -z "$BACKUP_DIR" ]; then
    BACKUP_DIR="$COMPOSE_DIR/backups"
  fi
  mkdir -p "$BACKUP_DIR"
  TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
  BACKUP_FILE="$BACKUP_DIR/core-postgres-prelocalbuild-$TIMESTAMP.dump"
  TMP_FILE="/tmp/core-postgres-prelocalbuild-$TIMESTAMP.dump"

  docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/docker-compose.yml" exec -T postgres sh -c "pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -F c -f '$TMP_FILE'"
  docker cp "core-postgres:$TMP_FILE" "$BACKUP_FILE"
  docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/docker-compose.yml" exec -T postgres rm -f "$TMP_FILE"

  if [ ! -s "$BACKUP_FILE" ]; then
    echo "Backup file was not created correctly: $BACKUP_FILE" >&2
    exit 1
  fi

  echo "Backup saved to $BACKUP_FILE"
fi

echo ""
echo "==> Building application image inside Docker"
if [ "$NO_CACHE" -eq 1 ]; then
  docker compose $COMPOSE_FILES build --no-cache web
else
  docker compose $COMPOSE_FILES build web
fi

echo ""
echo "==> Starting infrastructure and web container"
docker compose $COMPOSE_FILES up -d --remove-orphans postgres redis opensearch minio web

echo ""
echo "==> Waiting for web healthcheck after migrations"
wait_container_healthy core-web "$HEALTH_TIMEOUT_SECONDS"

echo ""
echo "==> Starting workers after web is healthy"
docker compose $COMPOSE_FILES up -d --remove-orphans worker-ingest worker-ai

echo ""
echo "==> Current status"
docker compose $COMPOSE_FILES ps