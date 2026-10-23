param([string]$DataDirectory=(Join-Path $env:LOCALAPPDATA 'WellBuilt/WhatsAppWatchdog'))
$ErrorActionPreference='Stop'
if(-not (Test-Path -LiteralPath (Join-Path $DataDirectory 'queue.json'))){throw 'Select the existing Watchdog data directory; do not create a second queue.'}
$taskName='WellBuilt Watchdog'
$task=Get-ScheduledTask -TaskName $taskName
$backup=Join-Path $DataDirectory ('scheduled-task-before-update-'+(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfff')+'.xml')
Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath $backup -Encoding Unicode
$startup=Join-Path $DataDirectory 'start-watchdog.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-watchdog.ps1') -Destination $startup
$log=Join-Path $DataDirectory 'startup-task.log'
$command='$ErrorActionPreference=''Stop''; & '''+$startup.Replace("'","''")+''' *>> '''+$log.Replace("'","''")+''''
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$action=New-ScheduledTaskAction -Execute ($env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand '+$encoded) -WorkingDirectory $DataDirectory
if($task.State -eq 'Running'){Stop-ScheduledTask -TaskName $taskName}
Set-ScheduledTask -TaskName $taskName -Action $action | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output 'Updated only the existing task action; preserved principal, settings, triggers, queue and linked session.'
