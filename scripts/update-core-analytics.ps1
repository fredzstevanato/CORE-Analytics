param(
  [string]$Branch = "main",
  [switch]$SkipGitPull,
  [switch]$NoCache,
  [switch]$SkipBackup,
  [int]$HealthTimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

function Import-DotEnv {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return
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

function Invoke-Git {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  if (Get-Command git -ErrorAction SilentlyContinue) {
    & git @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "git command failed with exit code $LASTEXITCODE"
    }
    return
  }

  Write-Host "Host git not found. Using git from container alpine/git:2.47.2"
  $rootPath = $root.Path
  $dockerArgs = @(
    "run", "--rm",
    "-v", "${rootPath}:/workspace",
    "-w", "/workspace",
    "alpine/git:2.47.2",
    "git", "-c", "safe.directory=/workspace"
  ) + $Arguments

  & docker @dockerArgs
  if ($LASTEXITCODE -ne 0) {
    throw "dockerized git command failed with exit code $LASTEXITCODE"
  }
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

Import-DotEnv -Path (Join-Path $root ".env")

Invoke-Step "Checking Docker" {
  docker version | Out-Null
  docker compose version | Out-Null
}

if (-not $SkipGitPull) {
  if (-not (Test-Path ".git")) {
    throw "This folder is not a Git repository yet. Run this from a cloned GitHub repository, or use -SkipGitPull."
  }

  Invoke-Step "Fetching latest code from origin/$Branch" {
    Invoke-Git fetch origin $Branch
  }

  Invoke-Step "Updating local branch with fast-forward only" {
    Invoke-Git pull --ff-only origin $Branch
  }
}

$composeFiles = @(
  "-f", "docker-compose.yml",
  "-f", "docker-compose.app.yml"
)

Invoke-Step "Validating Docker Compose configuration" {
  docker compose @composeFiles config --quiet
}

if (-not $SkipBackup) {
  Invoke-Step "Preparing PostgreSQL for backup" {
    docker compose -f docker-compose.yml up -d postgres
    Wait-ContainerHealthy -ContainerName "core-postgres" -TimeoutSeconds $HealthTimeoutSeconds
  }

  Invoke-Step "Creating PostgreSQL backup before local update" {
    $backupDir = if ([string]::IsNullOrWhiteSpace($env:CORE_BACKUP_DIR)) {
      Join-Path $root "backups"
    } else {
      $env:CORE_BACKUP_DIR
    }

    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupFile = Join-Path $backupDir "core-postgres-prelocalbuild-$timestamp.dump"
    $tmpFile = "/tmp/core-postgres-prelocalbuild-$timestamp.dump"

    docker compose -f docker-compose.yml exec -T postgres sh -c "pg_dump -U `"`$POSTGRES_USER`" -d `"`$POSTGRES_DB`" -F c -f $tmpFile"
    docker cp "core-postgres:$tmpFile" $backupFile
    docker compose -f docker-compose.yml exec -T postgres rm -f $tmpFile

    if (-not (Test-Path $backupFile) -or ((Get-Item $backupFile).Length -le 0)) {
      throw "Backup file was not created correctly: $backupFile"
    }

    Write-Host "Backup saved to $backupFile"
  }
}

$buildArgs = @()
if ($NoCache) {
  $buildArgs += "--no-cache"
}

Invoke-Step "Building application image inside Docker" {
  docker compose @composeFiles build @buildArgs web
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
