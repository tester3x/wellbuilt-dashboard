param([string]$DataDirectory=(Join-Path $env:LOCALAPPDATA 'WellBuilt/WhatsAppWatchdog'))
$ErrorActionPreference='Stop'
if(-not(Test-Path -LiteralPath (Join-Path $DataDirectory 'hmac-key.dpapi'))){throw 'Existing Watchdog signing configuration required'}
$worker=Get-ScheduledTask -TaskName 'WellBuilt Watchdog'
$script=Join-Path $PSScriptRoot 'remote-agent.mjs'
$node=(Get-Command node.exe).Source
$taskName='WellBuilt Watchdog Remote Recovery'
$prior=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($prior){Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $DataDirectory ('remote-task-backup-'+(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmss')+'.xml'));if($prior.State -eq 'Running'){Stop-ScheduledTask -TaskName $taskName}}
$command='$env:WBC_WATCHDOG_DATA='''+$DataDirectory.Replace("'","''")+'''; & '''+$node.Replace("'","''")+''' '''+$script.Replace("'","''")+''' *>> '''+(Join-Path $DataDirectory 'remote-agent.log').Replace("'","''")+''''
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$action=New-ScheduledTaskAction -Execute ($env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '+$encoded) -WorkingDirectory $PSScriptRoot
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -Priority 4
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $worker.Triggers -Principal $worker.Principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output 'Installed independent recovery helper; existing Watchdog task, queue and WhatsApp profile preserved'
