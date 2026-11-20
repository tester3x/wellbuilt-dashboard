param(
 [Parameter(Mandatory=$true)][string]$Bundle,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$BundleSha256,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_-]{3,64}$')][string]$WorkerId
)
$ErrorActionPreference='Stop'
$node=Join-Path $env:ProgramFiles 'nodejs\node.exe'
$npm=Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
if(-not(Test-Path $node) -or -not(Test-Path $npm)){throw 'Install Node.js before provisioning the runtime'}
$bundlePath=(Resolve-Path -LiteralPath $Bundle).Path
if((Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash -ne $BundleSha256){throw 'Runtime bundle hash mismatch'}
$data=Join-Path $env:LOCALAPPDATA 'WellBuilt\WhatsAppWatchdog'
$runtime=Join-Path $env:LOCALAPPDATA ('WellBuilt\WatchdogRuntime\'+$SourceCommit)
$taskName='WellBuilt Watchdog'
if(Test-Path $data){throw 'Existing Watchdog data requires reconciliation; fresh installer will not overwrite it'}
if(Test-Path $runtime){throw 'Runtime already exists; inspect the previous installation first'}
if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){throw 'Preserve the existing scheduled task before installing'}
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Expand-Archive -LiteralPath $bundlePath -DestinationPath $runtime
$manifest=Get-Content -LiteralPath (Join-Path $runtime 'runtime-manifest.json') -Raw | ConvertFrom-Json
if($manifest.sourceCommit -ne $SourceCommit){throw 'Runtime manifest source mismatch'}
$tools=Join-Path $runtime 'tools\whatsapp-watchdog'
$env:PUPPETEER_SKIP_DOWNLOAD='true'
$env:Path=(Split-Path $node)+';'+$env:Path
Push-Location $tools
try {
 & $npm ci --omit=dev --no-audit --no-fund
 if($LASTEXITCODE -ne 0){throw 'Runtime dependency installation failed'}
 & $node --input-type=module -e "import sharp from 'sharp'; import {Queue} from './core.mjs'; import {WorkerCoordinator} from './worker-coordinator.mjs'; console.log('Runtime modules ready; sharp '+sharp.versions.sharp);"
 if($LASTEXITCODE -ne 0){throw 'Runtime module smoke check failed'}
} finally {Pop-Location}
New-Item -ItemType Directory -Path $data | Out-Null
@{version=1;messages=@{};receiverControl=@{connect=$false;watching=$false}} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $data 'queue.json') -Encoding ascii
@{enabled=$false;enabledAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()} | ConvertTo-Json | Set-Content (Join-Path $data 'transport.json') -Encoding ascii
@{workerId=$WorkerId;sourceCommit=$SourceCommit} | ConvertTo-Json | Set-Content (Join-Path $data 'worker.json') -Encoding ascii
$launcher=Join-Path $data 'start-runtime.ps1'
$body=@'
$ErrorActionPreference='Stop'
$env:WBC_WATCHDOG_DATA=Split-Path $PSCommandPath
$env:WBC_CHROME_PATH=Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
$env:PUPPETEER_SKIP_DOWNLOAD='true'
$runtime=Get-Content -LiteralPath (Join-Path $env:WBC_WATCHDOG_DATA 'runtime-path.txt') -Raw
$runtime=$runtime.Trim()
Set-Location (Join-Path $runtime 'tools\whatsapp-watchdog')
& (Join-Path $env:ProgramFiles 'nodejs\node.exe') server.mjs 1>> (Join-Path $env:WBC_WATCHDOG_DATA 'server.stdout.log') 2>> (Join-Path $env:WBC_WATCHDOG_DATA 'server.stderr.log')
exit $LASTEXITCODE
'@
$body | Set-Content -LiteralPath $launcher -Encoding utf8
$runtime | Set-Content -LiteralPath (Join-Path $data 'runtime-path.txt') -Encoding utf8
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "'+$launcher+'"') -WorkingDirectory $data
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output ('Installed '+$WorkerId+' from '+$SourceCommit+'. Capture and delivery remain disabled. Open http://127.0.0.1:8791 to pair WhatsApp.')
