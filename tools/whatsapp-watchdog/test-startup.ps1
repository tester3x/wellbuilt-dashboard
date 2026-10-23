$ErrorActionPreference='Stop'
$testData=Join-Path ([IO.Path]::GetTempPath()) ('watchdog-startup-'+[guid]::NewGuid().ToString('N'))
$configDir=Join-Path $testData 'WellBuilt/WhatsAppWatchdog'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
Set-Content -LiteralPath (Join-Path $configDir 'codex-bridge.json') -Value '{"enabled":false}'
$oldLocal=$env:LOCALAPPDATA
try {
 $env:LOCALAPPDATA=$testData
 $global:watchdogLaunches=0
 function Get-AppxPackage { throw 'Saved configuration must avoid installed-app discovery' }
 function Get-CimInstance { return @() }
 function Start-Process {
  $global:watchdogLaunches++
  $fake=[pscustomobject]@{HasExited=$true;ExitCode=1;Id=999999;PriorityClass='BelowNormal'}
  $fake | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {}
  return $fake
 }
 & (Join-Path $PSScriptRoot 'start-watchdog.ps1') -Port 1 -Once
 if($global:watchdogLaunches -ne 1){throw 'One-shot fixture did not launch receiver'}
 function Start-Sleep { if($global:watchdogLaunches -ge 3){throw 'fixture-complete'} }
 try { & (Join-Path $PSScriptRoot 'start-watchdog.ps1') -Port 1 } catch {if($_.Exception.Message -ne 'fixture-complete'){throw}}
 if($global:watchdogLaunches -ne 3){throw 'Supervisor did not restart failed receiver'}
 $global:watchdogHungFake=[pscustomobject]@{HasExited=$false;ExitCode=1;Id=999999;PriorityClass='BelowNormal'}
 $global:watchdogHungFake | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {}
 $global:watchdogHungFake | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
 $global:watchdogHealthStops=0
 function Start-Process { return $global:watchdogHungFake }
 function Start-Sleep {}
 function Invoke-WebRequest { throw 'fixture-unresponsive' }
 function Stop-Process($Id){if($Id -ne 999999){throw 'Unexpected worker target'};$global:watchdogHealthStops++;$global:watchdogHungFake.HasExited=$true}
 & (Join-Path $PSScriptRoot 'start-watchdog.ps1') -Port 1 -Once -HealthyBootGraceSeconds 0
 if($global:watchdogHealthStops -ne 1 -or $global:watchdogHungFake.PriorityClass -ne 'Normal'){throw 'Unresponsive worker was not replaced at normal priority'}
 $global:watchdogHungFake.HasExited=$false
 $global:watchdogHealthyChecks=0
 function Invoke-WebRequest {$global:watchdogHealthyChecks++;return @{StatusCode=200}}
 function Start-Sleep {if($global:watchdogHealthyChecks -gt 0){$global:watchdogHungFake.HasExited=$true}}
 & (Join-Path $PSScriptRoot 'start-watchdog.ps1') -Port 1 -Once -HealthyBootGraceSeconds 0
 if($global:watchdogHealthStops -ne 1 -or $global:watchdogHealthyChecks -ne 1){throw 'Healthy worker must not be terminated'}
 $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
 $listener.Start()
 try {
  function Start-Process { throw 'Existing listener must not start another receiver' }
  & (Join-Path $PSScriptRoot 'start-watchdog.ps1') -Port $listener.LocalEndpoint.Port
 } finally { $listener.Stop() }
 Write-Output 'Startup regression passed: saved config, crash restart, hung-worker replacement, healthy-worker retention and existing receiver reuse.'
} finally { $env:LOCALAPPDATA=$oldLocal;Remove-Variable watchdogLaunches -Scope Global -ErrorAction SilentlyContinue }
