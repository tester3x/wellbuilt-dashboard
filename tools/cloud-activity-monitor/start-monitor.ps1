param([string]$AppDirectory,[string]$DataDir=(Join-Path $env:LOCALAPPDATA 'WellBuilt\CloudActivityMonitor'),[switch]$Demo)
$ErrorActionPreference='Stop'
if(-not $AppDirectory){$AppDirectory=(Get-Content -LiteralPath (Join-Path $DataDir 'current.json') -Raw|ConvertFrom-Json).appDirectory}
$exe=Join-Path $AppDirectory 'WBCloudWatch.exe'
if(-not (Test-Path -LiteralPath $exe)){throw 'Build/install the local monitor package first.'}
$arguments='--data "'+$DataDir+'"'+$(if($Demo){' --demo'}else{''})
Start-Process -FilePath $exe -ArgumentList $arguments
