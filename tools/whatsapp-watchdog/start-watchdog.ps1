param([int]$Port=8791)
$ErrorActionPreference='Stop'
$env:WBC_CHROME_PATH='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:WBC_WATCHDOG_DATA=Join-Path $env:LOCALAPPDATA 'WellBuilt\WhatsAppWatchdog'
if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'queue.json')){$env:WBC_WATCHDOG_DATA=$PSScriptRoot}
function Write-StartupPhase($phase){Add-Content -LiteralPath (Join-Path $env:WBC_WATCHDOG_DATA 'startup-status.log') -Value ((Get-Date).ToUniversalTime().ToString('o')+' '+$phase)}
trap { Write-StartupPhase ('failed: '+$_.Exception.Message); throw }
Write-StartupPhase 'starting'
if (-not (Test-Path -LiteralPath (Join-Path $env:WBC_WATCHDOG_DATA 'codex-bridge.json'))) {
$codexPackage=Get-AppxPackage '*Codex*' | Select-Object -First 1
$standalone=Get-ChildItem (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Filter codex.exe -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$codexExe=if($standalone){$standalone.FullName}elseif($codexPackage){Join-Path $codexPackage.InstallLocation 'app\resources\codex.exe'};if($codexExe -and (Test-Path $codexExe)){@{enabled=$true;executable=$codexExe;cwd='C:\dev\WellBuiltWatchdog'} | ConvertTo-Json -Compress | Set-Content (Join-Path $env:WBC_WATCHDOG_DATA 'codex-bridge.json') -Encoding ascii}
}
Write-StartupPhase 'saved configuration ready'
# A loopback socket check avoids waiting on Windows networking inventory/WMI.
$existingReceiver=New-Object System.Net.Sockets.TcpClient
$alreadyListening=$false
try {
 $connection=$existingReceiver.ConnectAsync('127.0.0.1',$Port)
 if($connection.Wait(1000) -and $existingReceiver.Connected){Write-StartupPhase 'receiver already listening';$alreadyListening=$true}
} catch {
 # No existing listener: launch the receiver below.
} finally { $existingReceiver.Dispose() }
$node=$null
if(-not $alreadyListening){
 Write-StartupPhase 'launching receiver'
 $node=Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.mjs' -WorkingDirectory 'C:\dev\WellBuiltWatchdog\tools\whatsapp-watchdog' -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $env:WBC_WATCHDOG_DATA 'server.stdout.log') -RedirectStandardError (Join-Path $env:WBC_WATCHDOG_DATA 'server.stderr.log')
 Write-StartupPhase ('receiver process '+$node.Id)
}
$b='http://127.0.0.1:'+$Port
while(!$node -or !$node.HasExited){
 try{
  $source=(Invoke-WebRequest ($b+'/app.js') -UseBasicParsing -TimeoutSec 15).Content
  $token=[regex]::Match($source,"let token='([^']+)'").Groups[1].Value
  $headers=@{'x-watchdog-token'=$token}
  $s=Invoke-RestMethod ($b+'/status') -Headers $headers -TimeoutSec 15
  if($s.state -eq 'Stopped'){Invoke-RestMethod ($b+'/connect') -Method Post -Headers $headers -TimeoutSec 30 | Out-Null}
  elseif($s.state -eq 'Connected'){if($s.paused){Invoke-RestMethod ($b+'/resume') -Method Post -Headers $headers -TimeoutSec 30 | Out-Null};Write-StartupPhase 'watching';break}
 }catch{}
 Start-Sleep -Seconds 10
 if($node){$node.Refresh()}
}
if($node){$node.WaitForExit();exit $node.ExitCode}



