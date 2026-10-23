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

Validation: 30 Node regressions pass, including outage/backoff, concurrent
reconnect, >100-message history, failed history, preserved auth profile, durable
queue/receipt identity and existing review contracts. The actual startup script
passes its PowerShell fixture for crash restart and existing-listener reuse.
Live HP installation and interruption results are recorded after execution.
