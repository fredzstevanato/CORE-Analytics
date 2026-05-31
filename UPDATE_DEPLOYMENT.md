# Core Analytics update deployment

This project already builds the application inside Docker through the root
`Dockerfile`. The recommended production update flow for multiple machines is:

1. Put this project in a Git repository.
2. Let GitHub Actions build and publish the Docker image to GHCR.
3. Keep each machine's local `.env` with its own secrets and ports.
4. Run the image deployment script on each production machine.

The database is preserved because the deployment never runs `docker compose down
-v` and never removes Docker volumes. Before updating, the deployment script
creates a PostgreSQL `pg_dump` backup on the host. Prisma migrations are applied
by the application entrypoint with `prisma migrate deploy` when the `web`
container starts.

## GitHub image publishing

The workflow in `.github/workflows/docker-image.yml` publishes images to:

```text
ghcr.io/YOUR_USER_OR_ORG/YOUR_REPO:latest
ghcr.io/YOUR_USER_OR_ORG/YOUR_REPO:sha-<commit>
ghcr.io/YOUR_USER_OR_ORG/YOUR_REPO:v1.0.0
```

It runs on pushes to `main`, version tags like `v1.0.0`, and manual
`workflow_dispatch` runs.

## First install on each production machine

```powershell
git clone https://github.com/YOUR_USER/YOUR_REPO.git CORE-Analytics
cd CORE-Analytics
copy .env.example .env
notepad .env
```

Set the image in `.env`:

```env
CORE_IMAGE=ghcr.io/YOUR_USER_OR_ORG/YOUR_REPO:latest
CORE_BACKUP_DIR=./backups
SESSION_SECRET=replace-with-a-long-random-secret
SETTINGS_ENCRYPTION_KEY=replace-with-a-long-random-secret
UFDR_SOURCE_ROOT=/mnt/evidencias
```

Then start:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-core-analytics-image.ps1
```

The base `docker-compose.yml` starts Postgres, Redis, OpenSearch, and MinIO.
The new `docker-compose.app.yml` adds the web app and workers.

## UFDR folder on Linux

Set `UFDR_SOURCE_ROOT` in `.env` to the Linux host folder that contains UFDR
files or extracted UFDR folders:

```env
UFDR_SOURCE_ROOT=/mnt/evidencias
```

The folder is mounted read-only inside `web` and `worker-ingest` as:

```text
/mnt/ufdr
```

When importing through the application, use the container path, for example:

```text
/mnt/ufdr/caso-001/evidencia.ufdr
/mnt/ufdr/caso-001/extracao-descompactada
```

The worker copies the UFDR into the application storage volume before
processing, so the original evidence folder can remain read-only.

## Updating from the published image

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-core-analytics-image.ps1
```

On Linux, without Git and without PowerShell:

```bash
sh scripts/deploy-core-analytics-image.sh
```

What the script does:

- checks that Docker and Docker Compose are available;
- starts PostgreSQL if needed and waits until it is healthy;
- writes a timestamped PostgreSQL backup to `CORE_BACKUP_DIR`;
- pulls the application image configured by `CORE_IMAGE`;
- validates the Docker Compose configuration;
- starts infrastructure plus `web`;
- lets the `web` container run Prisma migrations with `migrate deploy`;
- waits for the `web` healthcheck;
- starts workers only after the app is healthy.

Useful options:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-core-analytics-image.ps1 -SkipPull
powershell -ExecutionPolicy Bypass -File scripts/deploy-core-analytics-image.ps1 -SkipBackup
powershell -ExecutionPolicy Bypass -File scripts/deploy-core-analytics-image.ps1 -HealthTimeoutSeconds 600
```

Linux equivalents:

```bash
sh scripts/deploy-core-analytics-image.sh --skip-pull
sh scripts/deploy-core-analytics-image.sh --skip-backup
sh scripts/deploy-core-analytics-image.sh --health-timeout-seconds 600
```

To deploy a specific version:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-core-analytics-image.ps1 -Image ghcr.io/YOUR_USER_OR_ORG/YOUR_REPO:v1.0.0
```

For Linux, edit `CORE_IMAGE` in `.env` to the desired tag and run:

```bash
sh scripts/deploy-core-analytics-image.sh
```

## Automatic Docker-only updates

If you want the Linux machine to update itself from Docker, start Watchtower
with the application stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.app.yml -f docker-compose.watchtower.yml up -d
```

Watchtower checks the registry periodically and updates only containers labeled
for CORE Analytics. It does not remove database volumes. When `web` restarts,
the application entrypoint runs Prisma `migrate deploy` against the existing
database.

For production machines with valuable case data, prefer the manual deployment
script above. Watchtower is convenient, but it bypasses the explicit pre-update
backup step.

Optional interval in `.env`:

```env
WATCHTOWER_INTERVAL_SECONDS=300
```

## Emergency local build

If the registry is unavailable, you can still build locally from the checked-out
source:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/update-core-analytics.ps1 -Branch main
```

This local-build path uses the same safety sequence: Compose validation,
PostgreSQL backup, `web` startup/migrations, healthcheck, then workers. Use
`-SkipBackup` only for disposable test environments.

## Rollback

To roll back the application image, set `CORE_IMAGE` to the previous version tag
and run the deployment script again:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-core-analytics-image.ps1 -Image ghcr.io/YOUR_USER_OR_ORG/YOUR_REPO:v1.0.0
```

If a migration changed data or schema in a way that must be reversed, stop the
app containers and restore the backup created before the update:

```powershell
docker compose -f docker-compose.yml -f docker-compose.app.yml stop web worker-ingest worker-ai
docker cp .\backups\core-postgres-predeploy-YYYYMMDD-HHMMSS.dump core-postgres:/tmp/restore.dump
docker compose -f docker-compose.yml exec -T postgres sh -c "dropdb -U \"$POSTGRES_USER\" \"$POSTGRES_DB\" && createdb -U \"$POSTGRES_USER\" \"$POSTGRES_DB\" && pg_restore -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" /tmp/restore.dump"
docker compose -f docker-compose.yml -f docker-compose.app.yml up -d
```

Avoid destructive Prisma migrations in a single release. Prefer expand/contract
changes: add new structures first, migrate application usage, then remove old
structures in a later version after backups and validation.

## Automating on Windows

After the repository is cloned and `.env` is configured, create a Windows Task
Scheduler job that runs this command every night or at login:

```powershell
powershell.exe -ExecutionPolicy Bypass -File C:\path\to\CORE-Analytics\scripts\deploy-core-analytics-image.ps1
```
