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

## Installed and verified

- Runtime source `59af6d9b46dc1ab179eeb707e425a922f4d1f7b9` installed
  first on ROG, then HP after ROG returned healthy.
- Bundle SHA256 `5dc1634d63626bffad04e4ac1cc1759bea7ecce68d8ed075fedcffd407225b32`.
- All 61 packaged files matched the manifest on both machines. Dependency lock
  and compiled parser matched each machine's prior runtime; parser SHA256
  `7589dabec8dfeb561a2f13ee742007cd80a981d710a941939a625e2e2dda4ce8`.
- Twenty-eight selected runtime tests passed on each machine. ROG moved from its
  earlier d9da3984 runtime to current recovery code; HP retained its existing
  recovery behavior and separately maintained exact-profile supervisor.
- Both cloud host reports confirmed the new source, Connected, captureHealthy,
  no current error; each local receiver retained nine channels and unpaused
  capture. HP had a transient browser Target closed error on cold startup and
  recovered through its existing recovery path before final verification.
- Original runtime, queue and configuration backups retained privately on each
  host. Transport bytes and activation cutoffs unchanged. Both delivery maps
  byte-equal to their install backups. Counts remain ROG 184 messages / 142
  delivery rows; HP 2,921 / 1,858. ROG history refresh changed author display
  fields/header digests on some cached posts; only author changed inside parsed
  rows, not measurements. HP cached messages were byte-equal to backup. Existing
  review holds and pending work remain intact; no manual resend or intake call.
- The temporary laptop verification watcher now reads receipts every five minutes
  rather than every minute. Its Cloud Monitoring spike check is still read-only;
  the floating panel independently samples platform metrics each minute.

Initial platform observations: before, completed-message claims were six/minute,
reads commonly 51-57/minute and writes 36-46/minute. After the ROG update, observed
quiet minutes had zero completed-message claims, 8-20 reads/minute and 7-19
writes/minute. These early samples include HP restart/recovery; do not treat them
as a full-day steady-state guarantee or complete per-device attribution. Final
health confirmation happened after both workers recovered. No real new photo
has yet been used as an end-to-end post-update test. The next-photo watcher
remains pending, without historical resends. No Firebase function deployment,
rule change or phone update was needed.
