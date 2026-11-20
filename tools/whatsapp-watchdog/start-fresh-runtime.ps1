$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$env:WBC_WATCHDOG_DATA=Split-Path $PSCommandPath
$env:WBC_CHROME_PATH=Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
$env:PUPPETEER_SKIP_DOWNLOAD='true'
$runtime=(Get-Content -LiteralPath (Join-Path $env:WBC_WATCHDOG_DATA 'runtime-path.txt') -Raw).Trim()
$tools=Join-Path $runtime 'tools\whatsapp-watchdog'
$node=Join-Path $env:ProgramFiles 'nodejs\node.exe'
$log=Join-Path $env:WBC_WATCHDOG_DATA 'runtime-supervisor.log'
while($true){
 try {
  Add-Content $log ((Get-Date).ToUniversalTime().ToString('o')+' starting receiver')
  # PowerShell 5 treats native stderr as errors under Stop. Redirect through
  # Start-Process so a Node/browser warning cannot terminate the launcher.
  $child=Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory $tools -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $env:WBC_WATCHDOG_DATA 'server.stdout.log') -RedirectStandardError (Join-Path $env:WBC_WATCHDOG_DATA 'server.stderr.log')
  $child.WaitForExit()
  Add-Content $log ((Get-Date).ToUniversalTime().ToString('o')+' receiver exited '+$child.ExitCode)
 } catch {
  Add-Content $log ((Get-Date).ToUniversalTime().ToString('o')+' launcher error: '+$_.Exception.Message)
 }
 Start-Sleep -Seconds 10
}
