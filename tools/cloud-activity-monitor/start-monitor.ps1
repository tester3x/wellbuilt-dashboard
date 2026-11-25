param([string]$DataDir=(Join-Path $env:LOCALAPPDATA 'WellBuilt\CloudActivityMonitor'),[ValidateRange(1024,65535)][int]$Port=8793)
$ErrorActionPreference='Stop'
$node=(Get-Command node -ErrorAction Stop).Source
$server=Join-Path $PSScriptRoot 'web-monitor.cjs'
$url="http://127.0.0.1:$Port"
if(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue){
  throw "Port $Port is already in use. Open $url if your monitor is already running; otherwise choose another port."
}
if($DataDir.Contains('"')){throw 'Data directory cannot contain a quote.'}
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
Start-Process -FilePath $node -WindowStyle Hidden -ArgumentList ('"'+$server+'" --data "'+$DataDir+'" --port '+$Port) -RedirectStandardOutput (Join-Path $DataDir 'web.log') -RedirectStandardError (Join-Path $DataDir 'web-error.log') | Out-Null
Start-Process $url
Write-Output "Opened $url. In Chrome or Edge, click Float monitor and leave the parent tab open."
