# HP backup activation — November 23, 2026

Mike authorized updating the HP to the ROG's parser/OCR fixes and enabling it as
the backup. This supersedes the earlier disabled HP handover state; the ROG
remains the main worker. OD backup remains disabled.

## Installed and configured

- Both workers run runtime source `d9da3984eb92d0b329b666aeb266e3ec75edde98`.
- HP runtime archive SHA256:
  `b13bfc3e66d2dd056360a9dc0b0cc71c887bd776db57efd84174cacb3fbd51eb`.
- Compiled parser SHA256:
  `7589dabec8dfeb561a2f13ee742007cd80a981d710a941939a625e2edda4ce8`.
- Server policy assigns `rog-main` the main role and `hp-backup` the backup role.
  Only the HP worker entry was added; unrelated cloud policy was preserved.
- HP uses the same nine channel definitions and sender-ignore configuration.
  Shared cloud fallback policy and server barrel rules remain authoritative.
- Preserved HP's existing WhatsApp profile, queue, historical review items,
  signed credential, source checkout and disabled remote recovery task. No browser
  profile or queue was copied from the ROG.
- Updated HP's existing supervised launcher to use the verified installed runtime
  pointer. Retained exact-profile stale-browser cleanup, HTTP health checks and
  automatic restart. Enabled its existing logon task.
- Started with capture paused and transport disabled. Verified signed cloud
  requests before enabling transport, then resumed only after WhatsApp connected.
  A WhatsApp "What's new" Continue prompt was dismissed; no relink was required.
- HP transport cutoff is `2026-11-23T20:49:08.059Z`, preventing automatic replay
  of its preserved historical queue. Backup review alerts and remote correction
  consumption are disabled to avoid competing with the main worker.

## Duplicate and takeover checks

The ROG gets first chance. A backup claim waits two minutes from the first cloud
sighting and cannot steal another worker's unexpired 90-second claim. An existing
receipt is returned instead of submitting another load. Intake's transactional
message-ID reservation remains the final duplicate barrier.

- Seven server coordination-policy cases passed.
- Three local coordinator cases passed: backup grace, existing receipt/lost
  response reconciliation, and independent receipt verification.
- On HP, parser/OCR plus coordinator tests passed: 12 passed, three private-photo
  fixture tests skipped. Sharp native module loaded successfully.
- Signed requests from HP reconciled an existing Dwyer receipt without intake.
- A synthetic claim-only ID was denied during grace and granted after grace.
  It was never sent to intake and created no WB Mobile load. The claim expires
  normally; its audit record remains distinguishable from actual source messages.
- A fresh real post was captured by HP after activation. Cloud coordination showed
  ROG ownership and HP verification with `recorded_once`; one delivery ledger and
  exactly one WB Mobile processed receipt existed. HP's local delivery showed the
  original packet as complete/already recorded. Private source/receipt evidence
  is retained outside Git.
- Both hosts reported Connected, unpaused, captureHealthy, the same source and
  nine channels, with no current receiver error.

## Operational limits and preserved state

The HP has about 4 GB RAM and was under heavy memory pressure during cold startup.
It remains suitable as a secondary worker, not evidence of equal performance to
the ROG. Its old review queue is preserved, not newly cleared or resent.

The npm dependency installation timed out in Puppeteer's postinstall; subsequent
native-module loading, worker startup and installed parser/coordinator tests
passed. No dependency versions or runtime source were changed to bypass it.

This verifies live duplicate avoidance and claim takeover, not a future real
photo failover. The next real photo that local OCR cannot read still needs the
normal cloud-fallback receipt audit. No historical load was manually resent and
no simulated load was inserted. No Hosting, rules or Functions deployment was
needed for this host activation.

Private installation backups and evidence:
`C:/dev/release-artifacts/watchdog-hp-backup-20261123/` on the laptop, and HP's
existing Watchdog data directory under `backups/hp-backup-20261123-*`.

## Follow-up while watching the next photo

The HP's preserved queue exposed a separate photo-inbox problem: image fallback
did not honor the structured transport activation cutoff and attempted to download
old unresolved photos. Some old media IDs were no longer available, producing an
invalid serialized message ID error. The ROG remained healthy.

Fixed in `d18e2ec42ce9311e9e58c561470b22e39e4cf1e6`: photo fallback now skips
pre-activation or undated posts when a cutoff is configured, and skips completed,
duplicate, excluded, archived, before-activation and ignored rows. New unresolved
photos at or after the cutoff remain eligible. No historical queue entries were
deleted or manually resent.

Nine relevant tests passed locally and on HP. Installed the new HP runtime from
archive SHA256 `5a552ccc3187abcc18362a89d62ff3991c08cab9eab9241bd17dd4bf185163f0`.
The compiled parser is unchanged. The dependency lock is byte-identical; the new
runtime uses the previous installed dependencies through a directory junction.
The previous runtime is retained and must not be removed while that junction is
in use. The existing activation cutoff and queue were preserved.

HP reconnected with fallback enabled and reported captureHealthy with no error;
ROG also reported captureHealthy. ROG remains on its previous runtime. The next
new Tallgrass photo after the watch began remains pending acceptance; this
follow-up does not claim a future photo was processed. Private watch evidence is
under `C:/dev/release-artifacts/watchdog-next-dwyer-20261123/`.

## Recovery correction during the watch

HP later hit an HTTP stall and a profile-lock reconnect failure. Its old native
taskkill call could raise a PowerShell stderr error before cleanup completed;
checking only whether Get-Process returned an object also confused retained
exited process handles with active processes. Cleanup now selects the exact
Watchdog profile and its browser descendants, signals the full selected tree,
then waits for exit. Unrelated profiles are excluded. The maintained helper is
`tools/whatsapp-watchdog/hp-profile-cleanup.ps1`; the HP supervisor embeds it.

Worker source `b9a338aff799544e07bc3e329e7777c832907840` additionally requires
confirmed browser closure before reconnecting. A failed/timed-out close exits the
worker for supervised profile cleanup instead of immediately launching another
browser over the same profile. Duplicate restart attempts are guarded.

Installed HP runtime archive SHA256:
`f78722869f26fb04f325efe61d5a76ba817a4e33f9ddbfbf46e53ddd2274943b`.
Parser and dependency lock remain unchanged. Supervisor cleanup was subsequently
refined in `ecc41457`; its live/exited parent and unrelated-profile isolation test
is retained in `hp-profile-cleanup.test.ps1` (`33724946`). Thus worker runtime and
the separately maintained supervisor revision are distinct recorded components.

Twenty-four recovery/photo-inbox/coordinator tests passed locally and on HP.
The isolated Windows cleanup test passed without terminating any real process.
For the live recovery check, stopped only HP's verified receiver Node process;
its supervisor stopped eight browser processes from one exact profile root,
verified cleanup, launched a new receiver, and returned to healthy capture with
no current error. ROG stayed connected and healthy. Cold recovery on this
memory-constrained HP took several minutes; this is not an instantaneous failover
claim. No load was manually resent and original queue/activation boundary stayed
intact. The next new Tallgrass photo is still pending at this checkpoint.
