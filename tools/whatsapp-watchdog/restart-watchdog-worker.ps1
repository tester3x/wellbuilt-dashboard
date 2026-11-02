$ErrorActionPreference='Stop'
# Only the Node worker on Watchdog's fixed loopback port can be replaced.
$listeners=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8791 -State Listen -ErrorAction SilentlyContinue)
foreach($listener in $listeners){
 $worker=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
 if($worker.Name -ne 'node.exe' -or $worker.CommandLine -notmatch '(?:\s|\")server\.mjs(?:\s|\"|$)'){throw 'Port 8791 is owned by an unexpected process; no process was stopped'}
 Stop-Process -Id $worker.ProcessId -Force
}
# The existing supervisor restarts its own worker and preserves its browser profile.
# Do not trust the task state captured before stopping the listener. An
# installer can have launched a supervisor that is just exiting after seeing
# the old listener. Re-read until the replacement owns the port.
$restarted=$false
for($attempt=0;$attempt -lt 40;$attempt++){
 if((Get-ScheduledTask -TaskName 'WellBuilt Watchdog').State -ne 'Running'){Start-ScheduledTask -TaskName 'WellBuilt Watchdog'}
 $replacement=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8791 -State Listen -ErrorAction SilentlyContinue)
 if($replacement.Count -gt 0){$restarted=$true;break}
 Start-Sleep -Milliseconds 500
}
if(-not $restarted){throw 'Watchdog replacement did not open its listener; check the startup task'}
Write-Output 'Worker restart requested through the existing Watchdog supervisor'
