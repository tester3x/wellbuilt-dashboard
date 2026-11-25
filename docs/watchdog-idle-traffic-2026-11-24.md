# Watchdog idle cloud traffic reduction - 2026-11-24

Trace: the worker coordinator audited three completed rows every 30 seconds per
host, using claimWatchdogMessageV2. Each authenticated request also performs two
security reads and two writes (nonce and rate counter); a successful existing
claim additionally updates its audit document. Keep that security intact and
remove unnecessary requests instead. Healthy worker reports also ran every 30
seconds, lifecycle checks every minute even without pending work, unresolved
photo receipt checks every minute, and unchanged office review checks every 30
seconds. These run independently of driver shifts. Firestore monitoring totals
are project-wide and cannot alone attribute every operation to a device.

Changes:
- Heartbeat every minute, with operational state changes on the next 30-second
  timer. Existing two-minute capture freshness is retained.
- Completed-row audits: at most three each ten minutes; each successfully checked
  receipt is then quiet for six hours. Persist identity/packet-specific evidence
  locally so restart does not repeatedly audit the same rows. Receipt identity
  must match. New-load claims, backup grace and final reservations are unchanged.
- Idle lifecycle refresh five minutes; pending/new eligible rows retain the
  one-minute maximum age. WhatsApp capture remains local every four seconds.
- Unchanged office holds checked every five minutes; new revisions and command
  acknowledgments stay immediate. Office commands may wait up to five minutes.
- Unresolved photo receipt checks back off 1, 2, 4, 8, then 15 minutes. New photo
  revisions still upload promptly. Settled/local-success photos stay quiet.

Validation: 116 worker cases, 113 passed, three private-photo fixtures skipped,
zero failures. Four new timed tests cover persistent audit throttling, prompt
new-work policy refresh, photo backoff and office review changes. No cloud
function, database rules or phone build is required for this worker-side repair.
No historical resend or review decision is authorized by this change.

Runtime installation and measured live reduction will be recorded separately.
