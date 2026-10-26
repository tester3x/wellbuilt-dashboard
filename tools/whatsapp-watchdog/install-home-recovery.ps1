param([Parameter(Mandatory=$true)][string]$Bundle,[Parameter(Mandatory=$true)][string]$ExpectedCommit,[string]$Repository='C:\dev\WellBuiltWatchdog')
$ErrorActionPreference='Stop'
if($ExpectedCommit -notmatch '^[a-f0-9]{40}$'){throw 'A full verified source commit is required'}
$bundlePath=(Resolve-Path -LiteralPath $Bundle).ProviderPath
if(-not(Test-Path -LiteralPath (Join-Path $Repository '.git'))){throw 'Select the existing HP Watchdog repository'}
$data=Join-Path $env:LOCALAPPDATA 'WellBuilt\WhatsAppWatchdog'
foreach($file in @('queue.json','transport.json','hmac-key.dpapi')){if(-not(Test-Path -LiteralPath (Join-Path $data $file))){throw ('Existing Watchdog data is missing: '+$file)}}
& git -C $Repository diff --quiet
if($LASTEXITCODE -ne 0){throw 'Preserve and review tracked HP changes before updating'}
& git -C $Repository diff --cached --quiet
if($LASTEXITCODE -ne 0){throw 'Preserve and review staged HP changes before updating'}
& git -C $Repository fetch $bundlePath 'refs/heads/codex/watchdog-combined-time-20261019'
if($LASTEXITCODE -ne 0){throw 'Bundle prerequisites do not match; no source files were replaced'}
$incoming=(& git -C $Repository rev-parse FETCH_HEAD).Trim()
if($incoming -ne $ExpectedCommit){throw 'Bundle does not contain the expected verified checkpoint'}
& git -C $Repository merge --ff-only FETCH_HEAD
if($LASTEXITCODE -ne 0){throw 'HP source diverged; preserved without reset or overwrite'}
$tools=Join-Path $Repository 'tools\whatsapp-watchdog'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools 'install-startup-task.ps1')
if($LASTEXITCODE -ne 0){throw 'Worker startup installation failed; helper not started'}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools 'install-remote-agent.ps1')
if($LASTEXITCODE -ne 0){throw 'Remote helper installation failed'}
Write-Output 'Source and tasks updated. Verify the real HP heartbeat on the dashboard, then test recovery and private access from the hotspot.'
