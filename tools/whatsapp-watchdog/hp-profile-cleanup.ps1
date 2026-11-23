function Stop-WatchdogBrowser {
 $profile=Join-Path $env:WBC_WATCHDOG_DATA 'session\session'
 $pattern='(?i)(?:^|\s)--user-data-dir=(?:"'+[regex]::Escape($profile)+'"|'+[regex]::Escape($profile)+')(?=\s|$)'
 $all=@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'")
 $roots=@($all | Where-Object {$_.CommandLine -match $pattern -and $_.CommandLine -notmatch '(?:^|\s)--type='})
 $ids=New-Object 'System.Collections.Generic.HashSet[int]'
 foreach($root in $roots){[void]$ids.Add([int]$root.ProcessId)}
 do {
  $added=$false
  foreach($item in $all){if($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)){$added=$true}}
 } while($added)
 $stopping=@()
 foreach($item in @($all | Where-Object {$ids.Contains([int]$_.ProcessId)})){
  $process=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
  if($process -and -not $process.HasExited){
   Write-StartupPhase ('stopping Watchdog profile process '+$item.ProcessId)
   $stopping+=,$process
   Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop
  }
 }
 # Signal the entire verified tree before waiting. A parent can remain pending
 # while its children still hold browser resources on a memory-starved host.
 foreach($process in $stopping){
  if(-not $process.WaitForExit(30000)){throw ('Watchdog profile process did not stop: '+$process.Id)}
 }
 Write-StartupPhase ('Watchdog profile cleanup verified; matched roots '+$roots.Count)
}

