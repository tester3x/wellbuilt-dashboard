#Requires -RunAsAdministrator
param([string]$AllowedPeerIPv4='')
$ErrorActionPreference='Stop'
$tailscale=Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if(-not(Test-Path -LiteralPath $tailscale)){
 & winget.exe install --id Tailscale.Tailscale --exact --source winget --accept-package-agreements --accept-source-agreements
 if($LASTEXITCODE -ne 0){throw 'Tailscale installation did not finish successfully'}
}
if(-not(Test-Path -LiteralPath $tailscale)){throw 'Tailscale CLI is not available at the expected installation path'}
Write-Output 'Use the same private Tailscale account on the HP and field laptop. Complete browser sign-in if requested.'
& $tailscale up --unattended=true
if($LASTEXITCODE -ne 0){throw 'Tailscale sign-in or unattended setup did not finish'}
$status=(& $tailscale status --json | ConvertFrom-Json)
if($status.BackendState -ne 'Running' -or -not $status.Self.Online){throw 'Tailscale is not online yet'}
Write-Output ('Private device address: '+($status.Self.TailscaleIPs -join ', '))
Write-Output ('Private device name: '+$status.Self.DNSName)
if($AllowedPeerIPv4){
 $peer=$null
 if(-not [Net.IPAddress]::TryParse($AllowedPeerIPv4,[ref]$peer) -or $peer.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $AllowedPeerIPv4 -notmatch '^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.') {throw 'Specify the other computer''s Tailscale IPv4 address (100.64.0.0/10)'}
 $sshd=Get-Service sshd -ErrorAction Stop
 Set-Service sshd -StartupType Automatic
 if($sshd.Status -ne 'Running'){Start-Service sshd}
 $ruleName='WellBuilt-Private-SSH'
 if(Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue){Remove-NetFirewallRule -Name $ruleName}
 New-NetFirewallRule -Name $ruleName -DisplayName 'WellBuilt SSH from approved private peer' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 -RemoteAddress $AllowedPeerIPv4 -InterfaceAlias 'Tailscale' -Profile Any | Out-Null
 Write-Output 'Added SSH access for the specified private peer. Existing home-network rules were preserved.'
}
Write-Output 'No public router port forwarding is needed. Test from the phone hotspot before leaving home.'
