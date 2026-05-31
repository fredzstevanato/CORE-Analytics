# CORE Analytics Docker deploy on Linux

Copy these files to a folder on the Linux machine, configure `.env`, and start
the stack with Docker Compose.

## First run

```bash
cp .env.example .env
nano .env
docker login ghcr.io
docker compose -f docker-compose.yml -f docker-compose.app.yml up -d
```

Use `docker login ghcr.io` only if the image is private.

## Manual update

```bash
sh scripts/deploy-core-analytics-image.sh
```

This starts PostgreSQL if needed, creates a timestamped `pg_dump` backup in
`CORE_BACKUP_DIR` or `./backups`, pulls `CORE_IMAGE`, applies Prisma migrations
through the `web` container, waits for the app healthcheck, and starts workers
only after the app is healthy. It does not delete Docker volumes.

Useful options:

```bash
sh scripts/deploy-core-analytics-image.sh --image ghcr.io/YOUR_USER_OR_ORG/YOUR_REPO:v1.0.0
sh scripts/deploy-core-analytics-image.sh --skip-pull
sh scripts/deploy-core-analytics-image.sh --skip-backup
sh scripts/deploy-core-analytics-image.sh --health-timeout-seconds 600
```

## Automatic update

```bash
docker compose -f docker-compose.yml -f docker-compose.app.yml -f docker-compose.watchtower.yml up -d
```

Watchtower checks the registry and updates labeled CORE Analytics containers.
Use it only when automatic updates are acceptable, because it bypasses the
manual script's explicit pre-update backup step.

## UFDR folder

Set the host evidence folder in `.env`:

```env
UFDR_SOURCE_ROOT=/mnt/evidencias
```

Inside the application, import UFDRs using:

```text
/mnt/ufdr/path/to/evidence.ufdr
```

The source folder is mounted read-only, and the worker copies UFDR files into
the internal application storage before processing.

## Database safety

Do not run:

```bash
docker compose down -v
```

The normal update flow preserves the Postgres volume. Prisma migrations run
automatically when the `web` container starts.

Before every manual update, the deployment script creates a PostgreSQL backup.
To restore one, stop the app containers, copy the dump into `core-postgres`, and
run `pg_restore`:

```bash
docker compose -f docker-compose.yml -f docker-compose.app.yml stop web worker-ingest worker-ai
docker cp ./backups/core-postgres-predeploy-YYYYMMDD-HHMMSS.dump core-postgres:/tmp/restore.dump
docker compose -f docker-compose.yml exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB" && pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" /tmp/restore.dump'
docker compose -f docker-compose.yml -f docker-compose.app.yml up -d
```
