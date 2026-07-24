# Deploy RTDB containment rules (requires explicit Product Owner GO).
# Usage (from Dashboard/):  pwsh ./scripts/deploy-rtdb-containment.ps1

$ErrorActionPreference = 'Stop'
$DashboardRoot = Split-Path -Parent $PSScriptRoot
$Candidate = Join-Path $DashboardRoot 'database.containment.json'
$LiveRules = Join-Path $DashboardRoot 'database.rules.json'
$Backup = Join-Path $DashboardRoot 'database.rules.production.backup.json'

if (-not (Test-Path $Candidate)) {
  Write-Error "Candidate rules not found: $Candidate"
}

# Refresh backup from current live rules before swap
Copy-Item $LiveRules $Backup -Force
Copy-Item $Candidate $LiveRules -Force
Write-Host "Swapped database.containment.json -> database.rules.json (backup at database.rules.production.backup.json)"

Push-Location $DashboardRoot
try {
  firebase deploy --only database --project wellbuilt-sync
  Write-Host "Containment rules deployed."
} finally {
  Pop-Location
}