# Watchdog automatic recovery — 2026-10-23

The receiver persists connect/watch intent separately from current connection
state. A transient disconnect does not change operator intent. A bounded health
loop retries failed connections when WhatsApp is reachable, and replaces a stale
browser after three minutes. A deliberate Pause or Stop survives restarts. A
revoked WhatsApp link remains a QR/authentication issue; recovery never invents
credentials or deletes a live profile.

Each configured chat has a durable successful-scan checkpoint. After a restart or
connection gap, history is paged back through that checkpoint with a ten-minute
overlap. Catch-up ingestion has no 100-message truncation. Missing groups, failed
history loads and incomplete scans cannot advance checkpoints. Existing message
and server identities provide deduplication. The persistent delivery queue still
requires server receipts; reconnect does not clear it.

The hidden PowerShell startup action supervises the worker continuously, retries
worker crashes and removes only orphan browser children with both the exiting
worker's parent PID and the exact Watchdog profile path. Task settings retain the
existing user/logon trigger, enable StartWhenAvailable and battery operation,
remove the execution time limit, and extend failure restart attempts. The task
uses the existing interactive user profile: after Windows restarts it launches
when that user signs in. It does not configure Windows automatic sign-in.

Validation: 31 Node regressions pass, including outage/backoff, concurrent
reconnect, >100-message history, failed history, preserved auth profile, durable
queue/receipt identity and existing review contracts. The actual startup script
passes its PowerShell fixture for crash restart and existing-listener reuse.
Live HP installation and interruption results are recorded after execution.

## Installed and verified on the HP

Runtime source 1f1bdc84 is committed, pushed and installed in the HP checkout.
The scheduled action uses the updated supervisor. An actual worker termination
at 06:32:09 UTC was followed by automatic replacement at 06:32:20, with no manual
Connect/Resume call or QR scan. The restart exposed a restored duplicate WhatsApp
tab; the added scoped tab cleanup fixes that conflict while retaining the linked
profile. The replacement had one WhatsApp tab and authenticated normally.

A 45-second CDP network outage was applied only to the receiver tab (SSH and the
normal WhatsApp application were unaffected). During loss the receiver reported
Syncing, kept saved watch intent, and stopped advancing checkpoints. After
restoration it returned to Connected/unpaused on its own and resumed scans.
At 2026-10-23T06:35:16.897Z all eight watched groups had durable checkpoints from
06:35:14 UTC, signed server access returned HTTP 200, transport was Ready, all
493 complete delivery receipts remained, and there were no pending deliveries or
reviews. No fake production load or external test message was created.

The actual startup regression also passed under HP Windows PowerShell 5.1.
Task settings were read back: interactive user/logon trigger retained,
StartWhenAvailable=true, PT0S runtime limit, 999 one-minute failure restarts,
and no stop on battery. A full Windows reboot was not performed: the real worker
crash/restart, saved-session reopening and tab network outage were tested instead.
As before, Windows user sign-in and a valid WhatsApp link are required; a genuine
WhatsApp device unlink cannot be recovered without an owner QR scan.
