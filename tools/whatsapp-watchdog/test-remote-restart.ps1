$ErrorActionPreference='Stop'
$global:stops=0;$global:starts=0;$global:workerName='node.exe';$global:workerCommand='"C:\Program Files\nodejs\node.exe" server.mjs';$global:taskState='Running'
function Get-ScheduledTask {param($TaskName) if($TaskName -ne 'WellBuilt Watchdog'){throw 'Unexpected task'};return @{State=$global:taskState}}
function Get-NetTCPConnection {param($LocalAddress,$LocalPort,$State,$ErrorAction) if($LocalAddress -ne '127.0.0.1' -or $LocalPort -ne 8791){throw 'Unexpected port'};return @{OwningProcess=999999}}
function Get-CimInstance {param($ClassName,$Filter) if($Filter -ne 'ProcessId=999999'){throw 'Unexpected process query'};return @{Name=$global:workerName;CommandLine=$global:workerCommand;ProcessId=999999}}
function Stop-Process {param($Id,[switch]$Force) if($Id -ne 999999){throw 'Unexpected process stop'};$global:stops++}
function Start-ScheduledTask {param($TaskName) if($TaskName -ne 'WellBuilt Watchdog'){throw 'Unexpected task start'};$global:starts++}
& (Join-Path $PSScriptRoot 'restart-watchdog-worker.ps1')
if($global:stops -ne 1 -or $global:starts -ne 0){throw 'Running supervisor was not preserved'}
$global:taskState='Ready'
& (Join-Path $PSScriptRoot 'restart-watchdog-worker.ps1')
if($global:starts -ne 1){throw 'Stopped supervisor was not started'}
$global:workerCommand='node.exe another-server.mjs'
try{& (Join-Path $PSScriptRoot 'restart-watchdog-worker.ps1');throw 'Unsafe process accepted'}catch{if($_.Exception.Message -notmatch 'unexpected process'){throw}}
if($global:stops -ne 2){throw 'Unexpected process was stopped'}
Write-Output 'Remote restart fixtures PASSED: exact port and worker, existing supervisor, unrelated process refusal'
