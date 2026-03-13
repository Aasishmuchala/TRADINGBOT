# Sthyra Quant OS — Windows stack management script
# Equivalent of scripts/stack.sh for Windows PowerShell
param([Parameter(Position=0)][string]$Command = "help")

$ErrorActionPreference = "Stop"

$RootDir    = Resolve-Path (Join-Path $PSScriptRoot "..")
$StateDir   = Join-Path $RootDir ".sthyra"
$AppDataDir = Join-Path $env:APPDATA "Sthyra"
$RuntimeEnv = Join-Path $AppDataDir "runtime-env.bat"
$SupervisorPidFile  = Join-Path $StateDir "supervisor.pid"
$SupervisorLockFile = Join-Path $StateDir "supervisor.lock"
$SupervisorLog      = Join-Path $StateDir "supervisor.log"
$DesktopLog         = Join-Path $StateDir "desktop.log"
$SupervisorBinary   = Join-Path $RootDir "target\debug\sthyra-supervisor.exe"
$ExportDir          = Join-Path $StateDir "exports"

# ─── Defaults (PS5-compatible, no ??= operator) ───────────────────────────────
if (-not $env:STHYRA_DESKTOP_PORT)                 { $env:STHYRA_DESKTOP_PORT                 = "4174" }
if (-not $env:STHYRA_BINANCE_USE_TESTNET)          { $env:STHYRA_BINANCE_USE_TESTNET          = "1" }
if (-not $env:STHYRA_ENABLE_BINANCE_HTTP)          { $env:STHYRA_ENABLE_BINANCE_HTTP          = "0" }
if (-not $env:STHYRA_ENABLE_BINANCE_STREAM)        { $env:STHYRA_ENABLE_BINANCE_STREAM        = "0" }
if (-not $env:STHYRA_ENABLE_BINANCE_TRADING)       { $env:STHYRA_ENABLE_BINANCE_TRADING       = "0" }
if (-not $env:STHYRA_CANCEL_AFTER_SUBMIT)          { $env:STHYRA_CANCEL_AFTER_SUBMIT          = "0" }
if (-not $env:STHYRA_SUPERVISOR_INTERVAL_MS)       { $env:STHYRA_SUPERVISOR_INTERVAL_MS       = "500" }
if (-not $env:STHYRA_RESEARCH_REFRESH_INTERVAL_MS) { $env:STHYRA_RESEARCH_REFRESH_INTERVAL_MS = "1800000" }
if (-not $env:STHYRA_INDICATOR_PRUNE_MIN_FITNESS)  { $env:STHYRA_INDICATOR_PRUNE_MIN_FITNESS  = "0.05" }
if (-not $env:STHYRA_INDICATOR_RETENTION_LIMIT)    { $env:STHYRA_INDICATOR_RETENTION_LIMIT    = "6" }

New-Item -ItemType Directory -Force -Path $StateDir  | Out-Null
New-Item -ItemType Directory -Force -Path $AppDataDir | Out-Null

# ─── Load runtime env ─────────────────────────────────────────────────────────
function Load-RuntimeEnv {
    if (Test-Path $RuntimeEnv) {
        Get-Content $RuntimeEnv | ForEach-Object {
            if ($_ -match '^set\s+([A-Z0-9_]+)=(.+)$') {
                [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])
            }
        }
    }
}

# ─── Load Binance credentials from Windows Credential Manager ─────────────────
function Load-BinanceCredentials {
    try {
        $apiKey = (& powershell -NoProfile -NonInteractive -Command `
            "try { (Get-StoredCredential -Target 'sthyra.binance/api-key').GetNetworkCredential().Password } catch { '' }").Trim()
        $apiSecret = (& powershell -NoProfile -NonInteractive -Command `
            "try { (Get-StoredCredential -Target 'sthyra.binance/api-secret').GetNetworkCredential().Password } catch { '' }").Trim()

        if ($apiKey)    { $env:STHYRA_BINANCE_API_KEY    = $apiKey }
        if ($apiSecret) { $env:STHYRA_BINANCE_API_SECRET = $apiSecret }
    } catch {
        Write-Host "Warning: Could not load Binance credentials from Credential Manager"
    }
}

# ─── PID helpers ──────────────────────────────────────────────────────────────
function Get-SupervisorPid {
    if (Test-Path $SupervisorPidFile) {
        $pid = (Get-Content $SupervisorPidFile -Raw).Trim()
        if ($pid -match '^\d+$') { return [int]$pid }
    }
    return $null
}

function Test-ProcessRunning([int]$ProcessId) {
    if (-not $ProcessId) { return $false }
    try {
        $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        return ($null -ne $p -and -not $p.HasExited)
    } catch { return $false }
}

# ─── Ensure binary is built ───────────────────────────────────────────────────
function Ensure-SupervisorBinary {
    if (-not (Test-Path $SupervisorBinary)) {
        Write-Host "Building supervisor binary..."
        Push-Location $RootDir
        & cargo build -p sthyra-supervisor
        if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
        Pop-Location
    }
}

# ─── Commands ─────────────────────────────────────────────────────────────────
function Start-Supervisor {
    Load-RuntimeEnv
    $existingPid = Get-SupervisorPid
    if (Test-ProcessRunning $existingPid) {
        Write-Host "Supervisor already running on PID $existingPid"
        return
    }

    Remove-Item -Force -ErrorAction SilentlyContinue $SupervisorPidFile, $SupervisorLockFile
    Ensure-SupervisorBinary
    Load-BinanceCredentials

    Write-Host "Starting supervisor..."

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName  = $SupervisorBinary
    $psi.WorkingDirectory = $RootDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow  = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true

    foreach ($kv in @{
        STHYRA_SUPERVISOR_CYCLES               = "0"
        STHYRA_SUPERVISOR_INTERVAL_MS          = $env:STHYRA_SUPERVISOR_INTERVAL_MS
        STHYRA_RESEARCH_REFRESH_INTERVAL_MS    = $env:STHYRA_RESEARCH_REFRESH_INTERVAL_MS
        STHYRA_INDICATOR_PRUNE_MIN_FITNESS     = $env:STHYRA_INDICATOR_PRUNE_MIN_FITNESS
        STHYRA_INDICATOR_RETENTION_LIMIT       = $env:STHYRA_INDICATOR_RETENTION_LIMIT
        STHYRA_BINANCE_USE_TESTNET             = $env:STHYRA_BINANCE_USE_TESTNET
        STHYRA_ENABLE_BINANCE_HTTP             = $env:STHYRA_ENABLE_BINANCE_HTTP
        STHYRA_ENABLE_BINANCE_STREAM           = $env:STHYRA_ENABLE_BINANCE_STREAM
        STHYRA_ENABLE_BINANCE_TRADING          = $env:STHYRA_ENABLE_BINANCE_TRADING
        STHYRA_CANCEL_AFTER_SUBMIT             = $env:STHYRA_CANCEL_AFTER_SUBMIT
        STHYRA_BINANCE_API_KEY                 = $env:STHYRA_BINANCE_API_KEY
        STHYRA_BINANCE_API_SECRET              = $env:STHYRA_BINANCE_API_SECRET
    }.GetEnumerator()) {
        if ($kv.Value) { $psi.Environment[$kv.Key] = $kv.Value }
    }

    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.Id | Set-Content $SupervisorPidFile

    # Async log capture (PS5-compatible)
    $logPath = $SupervisorLog
    Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action {
        if ($Event.SourceEventArgs.Data) { Add-Content $using:logPath $Event.SourceEventArgs.Data }
    } | Out-Null
    Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
        if ($Event.SourceEventArgs.Data) { Add-Content $using:logPath $Event.SourceEventArgs.Data }
    } | Out-Null
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()

    # Wait up to 10 s for it to actually be running
    for ($i = 0; $i -lt 40; $i++) {
        if (Test-ProcessRunning $proc.Id) {
            Write-Host "Supervisor started on PID $($proc.Id)"
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Supervisor start timed out; inspect $SupervisorLog"
}

function Stop-SupervisorProcess {
    $pid = Get-SupervisorPid
    if (-not (Test-ProcessRunning $pid)) {
        Write-Host "Supervisor is not running"
        Remove-Item -Force -ErrorAction SilentlyContinue $SupervisorPidFile
        return
    }
    Write-Host "Stopping supervisor (PID $pid)..."
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    Remove-Item -Force -ErrorAction SilentlyContinue $SupervisorPidFile, $SupervisorLockFile
    Write-Host "Supervisor stopped"
}

function Get-Status {
    $pid = Get-SupervisorPid
    $running = Test-ProcessRunning $pid
    Write-Host "Supervisor: $(if ($running) { "running (PID $pid)" } else { "not running" })"
    if (Test-Path (Join-Path $RootDir "apps\desktop\runtime\runtime_snapshot.json")) {
        $snap = Get-Content (Join-Path $RootDir "apps\desktop\runtime\runtime_snapshot.json") -Raw | ConvertFrom-Json
        Write-Host "  Mode:    $($snap.mode)"
        Write-Host "  Cycle:   $($snap.cycle)"
        Write-Host "  Updated: $($snap.updated_at)"
    }
}

function Run-OverlayCompare {
    Load-RuntimeEnv
    $overlayBinary = Join-Path $RootDir "target\debug\overlay-compare.exe"
    if (-not (Test-Path $overlayBinary)) {
        Write-Host "Building overlay-compare..."
        Push-Location $RootDir
        & cargo build -p sthyra-supervisor --bin overlay-compare
        Pop-Location
    }
    & $overlayBinary --json
}

function Get-Health {
    $pid = Get-SupervisorPid
    $running = Test-ProcessRunning $pid
    if (-not $running) {
        Write-Host "Supervisor process FAIL"
        exit 1
    }
    Write-Host "Supervisor process OK: $pid"

    if ($env:STHYRA_DESKTOP_PORT) { $port = $env:STHYRA_DESKTOP_PORT } else { $port = "4174" }
    $apiUrl = "http://localhost:$port/api/runtime-snapshot"

    try {
        $resp = Invoke-WebRequest -Uri $apiUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        Write-Host "API OK: $apiUrl"
    } catch {
        Write-Host "API FAIL: $apiUrl"
        exit 1
    }

    $snapPath = Join-Path $RootDir "apps\desktop\runtime\runtime_snapshot.json"
    if (Test-Path $snapPath) {
        Write-Host "Snapshot OK"
    } else {
        Write-Host "Snapshot missing"
        exit 1
    }
}

# ─── Dispatch ──────────────────────────────────────────────────────────────────
Load-RuntimeEnv

switch ($Command) {
    "start"              { Start-Supervisor }
    "start-supervisor"   { Start-Supervisor }
    "stop"               { Stop-SupervisorProcess }
    "stop-supervisor"    { Stop-SupervisorProcess }
    "restart"            { Stop-SupervisorProcess; Start-Sleep -Seconds 1; Start-Supervisor }
    "restart-supervisor" { Stop-SupervisorProcess; Start-Sleep -Seconds 1; Start-Supervisor }
    "status"             { Get-Status }
    "health"             { Get-Health }
    "overlay-compare"    { Run-OverlayCompare }
    default {
        Write-Host "Usage: scripts\stack.ps1 <start|stop|restart|status|health|overlay-compare|start-supervisor|stop-supervisor|restart-supervisor>"
        exit 1
    }
}
