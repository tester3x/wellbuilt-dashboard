$ErrorActionPreference='Stop'
$env:WBC_WATCHDOG_DATA='C:\__watchdog_cleanup_test__'
. (Join-Path $PSScriptRoot 'hp-profile-cleanup.ps1')

# Isolated process inventory: never invoke real process termination in this test.
function Get-CimInstance { param($ClassName,$Filter) $script:Inventory }
function Get-Process { param($Id,$ErrorAction) $script:Processes[[int]$Id] }
function Stop-Process { param($Id,[switch]$Force,$ErrorAction)
 [void]$script:Stopped.Add([int]$Id)
 $script:Processes[[int]$Id].HasExited=$true
}
function Write-StartupPhase { param($phase) }

foreach($deadParent in @($false,$true)){
 $script:Stopped=New-Object 'System.Collections.Generic.List[int]'
 $script:Processes=@{}
 $script:ExpectedStops=if($deadParent){2}else{3}
 $script:Inventory=@(
  [pscustomobject]@{ProcessId=10;ParentProcessId=1;CommandLine='msedge.exe --user-data-dir=C:\__watchdog_cleanup_test__\session\session'},
  [pscustomobject]@{ProcessId=11;ParentProcessId=10;CommandLine='msedge.exe --type=renderer'},
  [pscustomobject]@{ProcessId=12;ParentProcessId=11;CommandLine='msedge.exe --type=utility'},
  [pscustomobject]@{ProcessId=20;ParentProcessId=1;CommandLine='msedge.exe --user-data-dir=C:\unrelated_profile'},
  [pscustomobject]@{ProcessId=21;ParentProcessId=20;CommandLine='msedge.exe --type=renderer'}
 )
 foreach($item in $script:Inventory){
  $process=[pscustomobject]@{Id=$item.ProcessId;HasExited=($deadParent -and $item.ProcessId -eq 10)}
  $process | Add-Member ScriptMethod WaitForExit {
   param($milliseconds)
   if($script:Stopped.Count -ne $script:ExpectedStops){throw 'Wait began before signaling the entire profile tree'}
   return $this.HasExited
  }
  $script:Processes[[int]$item.ProcessId]=$process
 }
 Stop-WatchdogBrowser
 $expected=if($deadParent){'11,12'}else{'10,11,12'}
 if(($script:Stopped -join ',') -ne $expected){throw ('Wrong process tree: '+($script:Stopped -join ','))}
 if($script:Processes[20].HasExited -or $script:Processes[21].HasExited){throw 'Unrelated profile was touched'}
}
Write-Output 'PASS: live and exited parent trees; all descendants signaled before waiting; unrelated browser preserved'
