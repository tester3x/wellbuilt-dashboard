param([int]$Port=8791,[switch]$Once)
$ErrorActionPreference='Stop'
$env:WBC_CHROME_PATH='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:WBC_WATCHDOG_DATA=Join-Path $env:LOCALAPPDATA 'WellBuilt\WhatsAppWatchdog'
if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'queue.json')){$env:WBC_WATCHDOG_DATA=$PSScriptRoot}
function Write-StartupPhase($phase){Add-Content -LiteralPath (Join-Path $env:WBC_WATCHDOG_DATA 'startup-status.log') -Value ((Get-Date).ToUniversalTime().ToString('o')+' '+$phase)}
trap { Write-StartupPhase ('failed: '+$_.Exception.Message); throw $_ }
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
if($alreadyListening){Write-StartupPhase 'existing receiver owns reconnect and saved monitoring intent';exit 0}
# Keep supervising after the first successful connection. A Node crash must not
# exhaust Task Scheduler's three-retry allowance and leave watching stopped.
while($true){
 Write-StartupPhase 'launching receiver'
 $node=Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.mjs' -WorkingDirectory 'C:\dev\WellBuiltWatchdog\tools\whatsapp-watchdog' -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $env:WBC_WATCHDOG_DATA 'server.stdout.log') -RedirectStandardError (Join-Path $env:WBC_WATCHDOG_DATA 'server.stderr.log')
 Write-StartupPhase ('receiver process '+$node.Id)
 $node.WaitForExit()
 Write-StartupPhase ('receiver exited '+$node.ExitCode+'; restarting')
 # A crashed Node process can leave its own Chromium child holding the profile.
 # Match both the parent PID and our exact data directory; never touch user Edge.
 $profile=Join-Path $env:WBC_WATCHDOG_DATA 'session\session'
 $browsers=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($node.Id)" | Where-Object {($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -and $_.CommandLine.Contains($profile) -and $_.CommandLine.Contains('--user-data-dir')})
 foreach($browser in $browsers){& taskkill.exe /PID $browser.ProcessId /T /F | Out-Null}
 if($Once){break}
 Start-Sleep -Seconds 10
}
