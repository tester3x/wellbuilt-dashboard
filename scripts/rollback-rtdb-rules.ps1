# Rollback RTDB rules to production backup (pre-containment global-open rules).
# Usage (from Dashboard/):  pwsh ./scripts/rollback-rtdb-rules.ps1
# Requires: firebase CLI authenticated to wellbuilt-sync project.

$ErrorActionPreference = 'Stop'
$DashboardRoot = Split-Path -Parent $PSScriptRoot
$BackupRules = Join-Path $DashboardRoot 'database.rules.production.backup.json'
$LiveRules = Join-Path $DashboardRoot 'database.rules.json'

if (-not (Test-Path $BackupRules)) {
  Write-Error "Backup rules not found: $BackupRules"
}

Copy-Item $BackupRules $LiveRules -Force
Write-Host "Copied backup rules -> database.rules.json"

Push-Location $DashboardRoot
try {
  firebase deploy --only database --project wellbuilt-sync
  Write-Host "Rollback deploy complete."
} finally {
  Pop-Location
}