$ErrorActionPreference='Stop'
$task=Get-ScheduledTask -TaskName 'WellBuilt Watchdog'
# Only the Node worker on Watchdog's fixed loopback port can be replaced.
$listeners=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8791 -State Listen -ErrorAction SilentlyContinue)
foreach($listener in $listeners){
 $worker=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
 if($worker.Name -ne 'node.exe' -or $worker.CommandLine -notmatch '(?:\s|\")server\.mjs(?:\s|\"|$)'){throw 'Port 8791 is owned by an unexpected process; no process was stopped'}
 Stop-Process -Id $worker.ProcessId -Force
}
# The existing supervisor restarts its own worker and preserves its browser profile.
if($task.State -ne 'Running'){Start-ScheduledTask -TaskName 'WellBuilt Watchdog'}
Write-Output 'Worker restart requested through the existing Watchdog supervisor'
