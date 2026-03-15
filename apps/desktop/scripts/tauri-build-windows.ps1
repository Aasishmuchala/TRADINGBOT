# Sthyra Quant OS — Windows Tauri build script
# Equivalent of scripts/tauri-build-macos.sh for Windows PowerShell
param([string[]]$ExtraArgs = @())

$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
$AppRoot   = Resolve-Path (Join-Path $ScriptDir "..")
$BundleDir = Join-Path $AppRoot "src-tauri\target\release\bundle"
$NsisDir   = Join-Path $BundleDir "nsis"
$MsiDir    = Join-Path $BundleDir "msi"

# Clean up stale bundle outputs
if (Test-Path $NsisDir) { Remove-Item -Recurse -Force $NsisDir -ErrorAction SilentlyContinue }
if (Test-Path $MsiDir)  { Remove-Item -Recurse -Force $MsiDir  -ErrorAction SilentlyContinue }

Set-Location $AppRoot

Write-Host "Building NyraQ for Windows..."
$tauriArgs = @("tauri", "build") + $ExtraArgs
& npx @tauriArgs

if ($LASTEXITCODE -ne 0) {
    Write-Error "tauri build failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

$nsisInstaller = Get-ChildItem -Path $BundleDir -Filter "*.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
$msiInstaller  = Get-ChildItem -Path $BundleDir -Filter "*.msi" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1

if ($nsisInstaller) {
    Write-Host "Created NSIS installer: $($nsisInstaller.FullName)"
} elseif ($msiInstaller) {
    Write-Host "Created MSI installer: $($msiInstaller.FullName)"
} else {
    Write-Warning "No installer file found — check src-tauri/target/release/bundle/"
}
