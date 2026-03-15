# ─────────────────────────────────────────────────────────────────────
# launch.ps1 — Start the crypto trading bot (Docker Compose) on Windows
# Called by Task Scheduler on login, or manually.
# ─────────────────────────────────────────────────────────────────────
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$LogDir = Join-Path $ProjectDir "logs"
$LogFile = Join-Path $LogDir "launch.log"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Add-Content -Path $LogFile -Value $line
    Write-Host $line
}

# ── 1. Wait for Docker Desktop ────────────────────────────────────────
Log "Waiting for Docker Desktop..."

$maxWait = 120
$waited = 0
while ($true) {
    try {
        $null = docker info 2>&1
        if ($LASTEXITCODE -eq 0) { break }
    } catch {}

    if ($waited -ge $maxWait) {
        Log "ERROR: Docker Desktop not ready after ${maxWait}s. Attempting to start it..."
        try {
            Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" -ErrorAction SilentlyContinue
        } catch {}
        Start-Sleep -Seconds 20
        try {
            $null = docker info 2>&1
            if ($LASTEXITCODE -eq 0) { break }
        } catch {}
        Log "FATAL: Docker Desktop still not available. Exiting."
        exit 1
    }

    Start-Sleep -Seconds 3
    $waited += 3
}
Log "Docker Desktop is ready (waited ${waited}s)"

# ── 2. Navigate to project ────────────────────────────────────────────
Set-Location $ProjectDir

# ── 3. Ensure .env exists ─────────────────────────────────────────────
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Log "Created .env from .env.example - add your API keys via the dashboard Settings page"
    } else {
        Log "WARNING: No .env or .env.example found"
    }
}

# ── 4. Start infrastructure first ─────────────────────────────────────
Log "Starting infrastructure (Redis + TimescaleDB)..."
docker compose up -d redis timescaledb 2>&1 | Out-Null

# Wait for TimescaleDB
Log "Waiting for TimescaleDB to be ready..."
$waited = 0
while ($true) {
    $result = docker compose exec -T timescaledb pg_isready -U trader -d trading 2>&1
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 2
    $waited += 2
    if ($waited -ge 60) {
        Log "WARNING: TimescaleDB slow to start, proceeding anyway..."
        break
    }
}
Log "TimescaleDB ready (waited ${waited}s)"

# ── 5. Run migrations (idempotent) ───────────────────────────────────
Log "Running database migrations..."
docker compose exec -T timescaledb psql -U trader -d trading -f /migrations/001_initial_schema.sql 2>&1 | Out-Null

# ── 6. Start all services ─────────────────────────────────────────────
Log "Starting all services..."
docker compose up -d 2>&1 | Out-Null

# ── 7. Verify ─────────────────────────────────────────────────────────
Start-Sleep -Seconds 5
$running = (docker compose ps --format "{{.State}}" 2>&1 | Select-String "running").Count
$total = (docker compose ps --format "{{.State}}" 2>&1 | Measure-Object -Line).Lines

Log "Bot started: ${running}/${total} services running"
Log "Dashboard: http://localhost:3000"
Log "API: http://localhost:8000/api/ping"
Log "----------------------------------------------"
