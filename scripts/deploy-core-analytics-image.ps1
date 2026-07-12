param(
  [string]$Image = $env:CORE_IMAGE,
  [switch]$SkipPull,
  [switch]$SkipBackup,
  [int]$HealthTimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

$envPath = Join-Path $root ".env"
$composeDir = if ($env:COMPOSE_WORKDIR -and (Test-Path "/host/compose")) {
  Write-Host "==> Running in container mode. Compose workdir: $env:COMPOSE_WORKDIR (mounted at /host/compose)"
  "/host/compose"
} else {
  $root.Path
}

function Import-DotEnv {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    throw "Missing .env file in $composeDir."
  }

  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#") -or -not $line.Contains("=")) {
      return
    }

    $parts = $line.Split("=", 2)
    $name = $parts[0].Trim()
    $value = $parts[1].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    if (-not [string]::IsNullOrWhiteSpace($name) -and [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, "Process"))) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}

function Invoke-Step {
  param(
    [string]$Title,
    [scriptblock]$Action
  )

  Write-Host ""
  Write-Host "==> $Title"
  & $Action
}

function Wait-ContainerHealthy {
  param(
    [string]$ContainerName,
    [int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $state = docker inspect -f "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" $ContainerName 2>$null
    if ($LASTEXITCODE -eq 0) {
      $state = ($state | Select-Object -First 1).Trim()
      if ($state -eq "healthy" -or $state -eq "running") {
        return
      }
      if ($state -eq "unhealthy" -or $state -eq "exited" -or $state -eq "dead") {
        throw "$ContainerName is $state."
      }
    }

    Start-Sleep -Seconds 5
  }

  throw "Timed out waiting for $ContainerName to become healthy after $TimeoutSeconds seconds."
}

Import-DotEnv -Path (Join-Path $composeDir ".env")

if ([string]::IsNullOrWhiteSpace($Image)) {
  $Image = $env:CORE_IMAGE
}

if ([string]::IsNullOrWhiteSpace($Image)) {
  throw "Set CORE_IMAGE in .env or pass -Image ghcr.io/owner/repo:tag."
}

foreach ($name in @("SESSION_SECRET", "SETTINGS_ENCRYPTION_KEY")) {
  $value = [Environment]::GetEnvironmentVariable($name, "Process")
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Set $name in .env before deploying."
  }
}

Invoke-Step "Checking Docker" {
  docker version | Out-Null
  docker compose version | Out-Null
}

$env:CORE_IMAGE = $Image

$composeFiles = @(
  "--project-directory", $composeDir,
  "-f", (Join-Path $composeDir "docker-compose.yml"),
  "-f", (Join-Path $composeDir "docker-compose.app.yml")
)

Invoke-Step "Validating Docker Compose configuration" {
  docker compose @composeFiles config --quiet
}

if (-not $SkipBackup) {
  Invoke-Step "Preparing PostgreSQL for backup" {
    docker compose --project-directory $composeDir -f (Join-Path $composeDir "docker-compose.yml") up -d postgres
    Wait-ContainerHealthy -ContainerName "core-postgres" -TimeoutSeconds $HealthTimeoutSeconds
  }

  Invoke-Step "Creating PostgreSQL backup before update" {
    $storageRoot = $env:STORAGE_ROOT
    if ([string]::IsNullOrWhiteSpace($storageRoot)) {
      $storageRoot = "/data/storage"
    }

    $backupDir = if ([string]::IsNullOrWhiteSpace($env:CORE_BACKUP_DIR)) {
      Join-Path $storageRoot "backups"
    } else {
      $env:CORE_BACKUP_DIR
    }

    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupFile = Join-Path $backupDir "core-postgres-predeploy-$timestamp.dump"
    $tmpFile = "/tmp/core-postgres-predeploy-$timestamp.dump"

    docker compose --project-directory $composeDir -f (Join-Path $composeDir "docker-compose.yml") exec -T postgres sh -c "pg_dump -U `"`$POSTGRES_USER`" -d `"`$POSTGRES_DB`" -F c -f $tmpFile"
    docker cp "core-postgres:$tmpFile" $backupFile
    docker compose --project-directory $composeDir -f (Join-Path $composeDir "docker-compose.yml") exec -T postgres rm -f $tmpFile

    if (-not (Test-Path $backupFile) -or ((Get-Item $backupFile).Length -le 0)) {
      throw "Backup file was not created correctly: $backupFile"
    }

    Write-Host "Backup saved to $backupFile"
  }
}

if (-not $SkipPull) {
  Invoke-Step "Pulling application image $Image" {
    docker compose @composeFiles pull web worker-ingest worker-ai
  }
}

Invoke-Step "Starting infrastructure and web container" {
  docker compose @composeFiles up -d --remove-orphans postgres redis opensearch minio web
}

Invoke-Step "Waiting for web healthcheck after migrations" {
  Wait-ContainerHealthy -ContainerName "core-web" -TimeoutSeconds $HealthTimeoutSeconds
}

Invoke-Step "Starting workers after web is healthy" {
  docker compose @composeFiles up -d --remove-orphans worker-ingest worker-ai
}

Invoke-Step "Current status" {
  docker compose @composeFiles ps
}
