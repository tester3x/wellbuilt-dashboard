#requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$FunctionsRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $FunctionsRoot
$WALL_MS = 55000
Write-Host "BOUNDED_PROOF start wallMs=$WALL_MS"
Set-Location $FunctionsRoot
npm run build --silent
Set-Location $RepoRoot
$npmDir = Join-Path $env:APPDATA 'npm'
$env:Path = $npmDir + ';' + $env:Path
$cmdline = 'firebase.cmd emulators:exec --only database --project demo-watchdog-canonical --config firebase.json "node functions/tools/watchdog-hmac-bounded-proof.cjs"'
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $cmdline) -PassThru -NoNewWindow -WorkingDirectory $RepoRoot
$exited = $p.WaitForExit($WALL_MS)
if (-not $exited) {
  Write-Host 'BOUNDED_PROOF killing hung emulator/proof'
  try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ParentProcessId -eq $p.Id -or ($_.CommandLine -and $_.CommandLine -match 'watchdog-hmac-bounded-proof|java.*firestore|firebase.*emulator')
  } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
  Write-Host 'BOUNDED_PROOF_FAIL blockingOperation=firebase_emulators_exec_or_child wallMs=55000'
  exit 3
}
Write-Host ("BOUNDED_PROOF firebaseExit=" + $p.ExitCode)
exit $p.ExitCode
