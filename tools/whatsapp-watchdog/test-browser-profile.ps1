$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'start-watchdog.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Startup syntax error'}
$function=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-WatchdogProfileCommand'},$true)
. ([scriptblock]::Create($function.Extent.Text))
$profile='C:\Users\worker\AppData\Local\WellBuilt\WhatsAppWatchdog\session\session'
$good=@('--user-data-dir="'+$profile+'"', '--user-data-dir='+$profile, '--user-data-dir="'+$profile.Replace('\','\\')+'"', '--user-data-dir="'+$profile.Replace('\','/')+'"', '--user-data-dir="'+$profile.ToLower()+'"')
foreach($line in $good){if(-not (Test-WatchdogProfileCommand ('edge.exe '+$line+' --headless=new') $profile)){throw ('Missed exact profile: '+$line)}}
$bad=@('edge.exe','--user-data-dir="'+$profile+'-other"','--user-data-dir="'+$profile+'\other"','--user-data-dir="C:\Users\worker\Personal"','--user-data-dir="session\session"','--user-data-dir="'+$profile+'\..\other"')
foreach($line in $bad){if(Test-WatchdogProfileCommand $line $profile){throw ('Matched unrelated profile: '+$line)}}
Write-Output 'PASS exact watchdog profiles with single/doubled/mixed separators; unrelated, relative, descendant and lookalike profiles rejected; startup syntax valid.'
