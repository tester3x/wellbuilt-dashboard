$ErrorActionPreference='Stop'
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('watchdog-install-'+[guid]::NewGuid().ToString('N'))
$oldLocal=$env:LOCALAPPDATA
New-Item -ItemType Directory -Path $fixture | Out-Null
$source=Join-Path $fixture 'source';$hp=Join-Path $fixture 'hp';$package=Join-Path $fixture 'package'
New-Item -ItemType Directory -Path $source,$package | Out-Null
function Git-Fixture { & git @args | Out-Null; if($LASTEXITCODE -ne 0){throw ('Fixture Git failed: '+($args -join ' '))} }
try{
 Git-Fixture -C $source init --quiet
 Git-Fixture -C $source config user.name 'Watchdog Fixture'
 Git-Fixture -C $source config user.email 'fixture@example.test'
 Set-Content -LiteralPath (Join-Path $source 'fixture.txt') 'baseline'
 Git-Fixture -C $source add fixture.txt
 Git-Fixture -C $source commit --quiet -m baseline
 $base=(& git -C $source rev-parse HEAD).Trim()
 Git-Fixture clone --quiet $source $hp
 Set-Content -LiteralPath (Join-Path $hp 'preserve-private.txt') 'untracked preserved'
 Git-Fixture -C $source switch --quiet -c codex/watchdog-combined-time-20261019
 Set-Content -LiteralPath (Join-Path $source 'fixture.txt') 'updated'
 Git-Fixture -C $source commit --quiet -am updated
 $expected=(& git -C $source rev-parse HEAD).Trim()
 Git-Fixture -C $source bundle create (Join-Path $package 'recovery.bundle') ($base+'..codex/watchdog-combined-time-20261019')
 $env:LOCALAPPDATA=Join-Path $fixture 'local'
 $data=Join-Path $env:LOCALAPPDATA 'WellBuilt\WhatsAppWatchdog'
 New-Item -ItemType Directory -Path $data -Force | Out-Null
 foreach($file in @('queue.json','transport.json','hmac-key.dpapi')){Set-Content -LiteralPath (Join-Path $data $file) 'fixture only'}
 $global:installCalls=0
 function powershell.exe { $global:installCalls++;$global:LASTEXITCODE=0 }
 $installer=Join-Path $PSScriptRoot 'install-home-recovery.ps1'
 Push-Location $package
 try{& $installer -Bundle '.\recovery.bundle' -ExpectedCommit $expected -Repository $hp}finally{Pop-Location}
 if((& git -C $hp rev-parse HEAD).Trim() -ne $expected -or $global:installCalls -ne 2){throw 'Verified bundle installation did not finish'}
 if((Get-Content -LiteralPath (Join-Path $hp 'preserve-private.txt') -Raw).Trim() -ne 'untracked preserved'){throw 'Untracked work was not preserved'}
 Set-Content -LiteralPath (Join-Path $hp 'fixture.txt') 'local edit must survive'
 try{& $installer -Bundle (Join-Path $package 'recovery.bundle') -ExpectedCommit $expected -Repository $hp;throw 'Dirty source accepted'}catch{if($_.Exception.Message -notmatch 'tracked HP changes'){throw}}
 if((Get-Content -LiteralPath (Join-Path $hp 'fixture.txt') -Raw).Trim() -ne 'local edit must survive' -or $global:installCalls -ne 2){throw 'Dirty-source refusal changed work or installed tasks'}
 Write-Output 'Home installer fixture PASSED: real relative bundle, exact checkpoint, fast-forward, untracked preservation and dirty-source refusal'
}finally{
 $env:LOCALAPPDATA=$oldLocal
 $resolved=(Resolve-Path -LiteralPath $fixture).ProviderPath
 $expectedRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
 if(-not $resolved.StartsWith($expectedRoot,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'watchdog-install-*'){throw 'Unsafe fixture cleanup target'}
 Remove-Item -LiteralPath $resolved -Recurse -Force
}
