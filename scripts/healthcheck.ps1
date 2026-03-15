# ─────────────────────────────────────────────────────────────────────
# healthcheck.ps1 — Runs every 5 minutes via Task Scheduler.
# Checks all Docker containers and restarts any that have exited.
# Also monitors disk space and Docker health.
# ─────────────────────────────────────────────────────────────────────
$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$LogDir = Join-Path $ProjectDir "logs"
$LogFile = Join-Path $LogDir "healthcheck.log"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogFile -Value "[$ts] $msg"
}

function Send-Notification($title, $message) {
    try {
        # Windows 10/11 toast notification via PowerShell
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

        $template = @"
<toast>
    <visual>
        <binding template="ToastGeneric">
            <text>$title</text>
            <text>$message</text>
        </binding>
    </visual>
    <audio src="ms-winsoundevent:Notification.Default"/>
</toast>
"@
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml($template)
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
        $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("CryptoBot")
        $notifier.Show($toast)
    } catch {
        # Fallback: BurntToast module or simple console output
        Log "NOTIFICATION: $title - $message"
    }
}

# Rotate log if > 10MB
if (Test-Path $LogFile) {
    $size = (Get-Item $LogFile).Length
    if ($size -gt 10MB) {
        Move-Item $LogFile "$LogFile.old" -Force
        Log "Log rotated"
    }
}

# ── 1. Check Docker is running ────────────────────────────────────────
try {
    $null = docker info 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Docker not running" }
} catch {
    Log "ALERT: Docker not running. Attempting to start Docker Desktop..."
    try {
        Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" -ErrorAction SilentlyContinue
    } catch {}
    Start-Sleep -Seconds 25
    try {
        $null = docker info 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Still not running" }
    } catch {
        Log "CRITICAL: Docker still not running after restart attempt"
        Send-Notification "Crypto Bot Alert" "Docker Desktop is not running! Trading bot is DOWN."
        exit 1
    }
    Log "Docker Desktop restarted successfully"
}

Set-Location $ProjectDir

# ── 2. Check container health ─────────────────────────────────────────
$exited = docker compose ps --format "{{.Name}} {{.State}}" 2>&1 | Select-String "exited"

if ($exited) {
    Log "ALERT: Found exited containers:"
    $exited | ForEach-Object { Log "  - $_" }

    Log "Restarting exited containers..."
    docker compose up -d 2>&1 | Out-Null
    Start-Sleep -Seconds 5

    $stillExited = docker compose ps --format "{{.Name}} {{.State}}" 2>&1 | Select-String "exited"
    if ($stillExited) {
        Log "CRITICAL: Containers still exited after restart"
        Send-Notification "Crypto Bot Alert" "Some trading bot services failed to restart!"
    } else {
        Log "All containers restarted successfully"
        Send-Notification "Crypto Bot" "Trading bot services recovered automatically."
    }
} else {
    $running = (docker compose ps --format "{{.State}}" 2>&1 | Select-String "running").Count
    Log "OK: ${running} services running"
}

# ── 3. Check API responsiveness ───────────────────────────────────────
try {
    $response = Invoke-WebRequest -Uri "http://localhost:8000/api/ping" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    if ($response.StatusCode -eq 200) {
        Log "OK: Dashboard API healthy"
    } else {
        throw "Non-200 status"
    }
} catch {
    Log "WARNING: Dashboard API not responding. Restarting dashboard_api..."
    docker compose restart dashboard-api 2>&1 | Out-Null
}

# ── 4. Check disk space ──────────────────────────────────────────────
$disk = Get-PSDrive C
$usedPercent = [math]::Round(($disk.Used / ($disk.Used + $disk.Free)) * 100)
if ($usedPercent -gt 90) {
    Log "WARNING: Disk usage at ${usedPercent}%"
    docker system prune -f --volumes --filter "until=168h" 2>&1 | Out-Null
    Log "Ran Docker prune to free space"
    Send-Notification "Crypto Bot Alert" "Disk usage at ${usedPercent}%. Docker cleanup performed."
}

# ── 5. Check Redis connectivity ──────────────────────────────────────
$redisPing = docker compose exec -T redis redis-cli ping 2>&1
if ($redisPing -match "PONG") {
    Log "OK: Redis healthy"
} else {
    Log "ALERT: Redis not responding. Restarting..."
    docker compose restart redis 2>&1 | Out-Null
}

# ── 6. Check TimescaleDB connectivity ────────────────────────────────
$pgReady = docker compose exec -T timescaledb pg_isready -U trader -d trading 2>&1
if ($LASTEXITCODE -eq 0) {
    Log "OK: TimescaleDB healthy"
} else {
    Log "ALERT: TimescaleDB not responding. Restarting..."
    docker compose restart timescaledb 2>&1 | Out-Null
}

Log "----------------------------------------------"
