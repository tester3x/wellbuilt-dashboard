# Field recovery and home installation

Firebase exposes admin-authorized receiver health and five fixed actions:
refresh receiver, reconnect WhatsApp, retry pending work, resume watching and
restart the Node worker. Recovery requires company manageWells authority or a
verified platform administrator. Ordinary view access cannot send commands.

Commands retain the trusted actor, reason and request ID, are server sealed,
expire after ten minutes and cannot replace an unexpired pending request.
The independent HP helper reports health every minute, with network-error
backoff up to five minutes. Dashboard reads remain manual. It sends counts and
receiver state, never QR data, message bodies, signing credentials or raw queues.

The helper persists a separate command ledger before performing actions and
retains results until Firebase confirms receipt. Repeated delivery cannot repeat
an action. If it crashes during an action, it reports interruption and requires
a fresh deliberate request instead of repeating an uncertain side effect.
Restart targets only the Node server on the fixed Watchdog loopback port; the
existing supervisor handles its browser cleanup and worker replacement. No queue
or WhatsApp profile is removed. Relinking a revoked WhatsApp session still needs
the user's phone.

## Install at home

The HP is currently unreachable from the field hotspot. Cloud/dashboard changes
can be deployed now; the helper cannot be called installed until these steps
have actually been completed on the HP under its existing Watchdog Windows user.

1. Fast-forward the existing HP checkout to this branch's verified checkpoint;
   preserve its queue, profile, signing files and unrelated local helpers.
2. From `tools/whatsapp-watchdog`, run `install-startup-task.ps1` to update the
   existing receiver and `install-remote-agent.ps1` to register the independent
   recovery task. Both retain the existing user/logon context. Verify a real
   heartbeat before testing recovery.
3. Run `setup-private-remote-access.ps1` elevated on both computers and sign into
   the same private Tailscale account. It installs the official Winget package
   if needed and enables unattended mode. On the HP, rerun it with
   `-AllowedPeerIPv4 <field-laptop-Tailscale-IPv4>` to add a peer-specific SSH rule.
   Existing LAN firewall rules and SSH keys are preserved; no public router port
   forwarding is required. Configure the tailnet access policy for the intended
   laptop-to-HP connection rather than adding other users.
4. Move the laptop back to its phone hotspot. Verify existing key-based Windows
   OpenSSH access using the HP's private address, then test health, a receipt
   retry, worker restart, command acknowledgment and loss/recovery of Wi-Fi.
5. Reboot and verify Tailscale is reachable before Windows sign-in, then verify
   Watchdog and its recovery helper start with their existing Windows logon
   context. This does not enable Windows automatic sign-in or change credentials.

Windows Tailscale uses the existing Windows OpenSSH service here, not a
Tailscale SSH server. Official setup references:
https://tailscale.com/docs/how-to/run-unattended
https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse

No database, Firestore or Storage rules deployment is part of this work.
