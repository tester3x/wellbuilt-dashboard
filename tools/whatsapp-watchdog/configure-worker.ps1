param(
 [Parameter(Mandatory=$true)][string]$DataDirectory,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_-]{3,64}$')][string]$WorkerId,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceCommit
)
$ErrorActionPreference='Stop'
$dataPath=(Resolve-Path -LiteralPath $DataDirectory).Path
if(-not(Test-Path -LiteralPath (Join-Path $dataPath 'queue.json'))){throw 'Use the verified existing worker data directory.'}
if(-not(Test-Path -LiteralPath (Join-Path $dataPath 'hmac-key.dpapi'))){throw 'Provision credentials privately under this Windows user; do not copy another computer''s DPAPI key.'}
$configPath=Join-Path $dataPath 'worker.json'
if(Test-Path -LiteralPath $configPath){
 $old=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
 if($old.workerId -ne $WorkerId){throw 'Worker identity differs; preserve and reconcile the existing host configuration.'}
 Copy-Item -LiteralPath $configPath -Destination ($configPath+'.before-'+(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfff'))
}
@{workerId=$WorkerId;sourceCommit=$SourceCommit} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding ascii
Write-Output "Configured $WorkerId. Firebase must assign its role before it can send. No worker started and no messages replayed."
