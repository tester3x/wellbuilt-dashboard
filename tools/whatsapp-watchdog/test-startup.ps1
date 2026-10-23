$ErrorActionPreference='Stop'
$testData=Join-Path ([IO.Path]::GetTempPath()) ('watchdog-startup-'+[guid]::NewGuid().ToString('N'))
$configDir=Join-Path $testData 'WellBuilt/WhatsAppWatchdog'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
Set-Content -LiteralPath (Join-Path $configDir 'codex-bridge.json') -Value '{"enabled":false}'
$oldLocal=$env:LOCALAPPDATA
try {
 $env:LOCALAPPDATA=$testData
 function Get-AppxPackage { throw 'Saved configuration must avoid installed-app discovery' }
 function Start-Process {
  $fake=[pscustomobject]@{HasExited=$true;ExitCode=0}
  $fake | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {}
  return $fake
 }
 & (Join-Path $PSScriptRoot 'start-watchdog.ps1')
 if($LASTEXITCODE -and $LASTEXITCODE -ne 0){throw 'Startup fixture failed'}
 $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
 $listener.Start()
 try {
  $global:watchdogTestRequests=@();$global:watchdogTestStatusCalls=0
  function Start-Process { throw 'Existing listener must not start another receiver' }
  function Invoke-WebRequest { return @{Content="let token='synthetic';"} }
  function Invoke-RestMethod($Uri,$Method) {
   $global:watchdogTestRequests+=([string]$Uri)
   if($Uri -like '*/status'){$global:watchdogTestStatusCalls++;if($global:watchdogTestStatusCalls -eq 1){return @{state='Stopped';paused=$true}};return @{state='Connected';paused=$true}}
   return @{ok=$true}
  }
  function Start-Sleep {}
  & (Join-Path $PSScriptRoot 'start-watchdog.ps1') -Port $listener.LocalEndpoint.Port
  if(-not ($global:watchdogTestRequests -like '*/connect') -or -not ($global:watchdogTestRequests -like '*/resume')){throw 'Existing stopped receiver was not connected and resumed'}
 } finally { $listener.Stop() }
 Write-Output 'Startup regression passed: no repeated discovery; existing stopped receiver connects and resumes without duplicate launch.'
} finally { $env:LOCALAPPDATA=$oldLocal }

