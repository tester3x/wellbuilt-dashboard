param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
node C:/dev/workspace-control/guard.cjs check $repo
if($LASTEXITCODE){throw 'Workspace ownership check failed'}
$head=(git -C $repo rev-parse HEAD).Trim()
if(git -C $repo status --porcelain){throw 'Build requires exact clean source'}
git -C $repo fetch origin
if($LASTEXITCODE){throw 'Remote reconciliation unavailable'}
if((git -C $repo rev-parse '@{upstream}').Trim() -ne $head){throw 'Build source must match pushed branch'}
if(Test-Path -LiteralPath $OutputDirectory){throw 'Use a new immutable artifact directory'}
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:winexe /optimize+ ('/out:'+(Join-Path $OutputDirectory 'WBCloudWatch.exe')) /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'CloudWatch.cs')
if($LASTEXITCODE){throw 'Native monitor compilation failed'}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'collector.cjs'),(Join-Path $PSScriptRoot 'metrics.cjs') -Destination $OutputDirectory
$hashes=@{};Get-ChildItem -LiteralPath $OutputDirectory -File|ForEach-Object{$hashes[$_.Name]=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()}
@{sourceCommit=$head;project='wellbuilt-sync';version='0.1.0.0';readOnly=$true;files=$hashes;builtAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $OutputDirectory 'build-receipt.json')
Write-Output ('Verified local monitor package: '+$OutputDirectory)
