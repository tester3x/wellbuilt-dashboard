# ROG Watchdog setup checkpoint

The owner restored OpenSSH Server after the Windows installation. The laptop
verified the owner-provided ED25519 host fingerprint and successfully signed in
with the existing diagnostics key. Private connection details remain outside Git.

Read-only runtime inventory found Edge installed, but no Node.js installation,
Watchdog queue, scheduled task or C:/dev runtime directory. No existing ROG queue
or browser profile was replaced. No WhatsApp messages or loads were sent.

Prepared Watchdog changes from 57805103, 35ffd68a and f70a74e0 were integrated
onto the current deployed Dashboard/PW-exception baseline using isolated
cherry-picks. Source checkpoint: fb0be3a1. Existing job-exception exports remain.
Unrelated prepared Fresh Water and JSA changes were not integrated.

Validation: Functions TypeScript build passed; 22 Watchdog backend suites / 153
tests passed; worker default suite 82 passed and 3 optional tests skipped;
photo-inbox/coordination focused suite 5 passed. An initial Jest invocation used
an unsupported filtering option and ran unrelated suites with baseline failures;
the targeted run used explicit test paths. No broad-suite pass is claimed.

Automatic approval review rejected remote Node.js installer execution. The owner
was asked to install Node.js 22 LTS on the ROG. Runtime installation, WhatsApp
pairing, private credential provisioning, backend live-source reconciliation,
scoped endpoint deployment, activation cutoff and primary handover remain
pending. The HP sender has not been changed. Never activate another sender
before message reservations and role controls are verified live.

Follow the main/backup and photo-inbox rollout documents for remaining gates.
Do not resend historical photos or manually handled Dwyer loads.

## Installed checkpoint

The owner installed Node v26.13.1 / npm 11.20.0. Runtime module smoke checks
(including sharp) passed. A fresh paused runtime was installed under the Windows
user's LocalAppData, not a developer checkout. Its logon task runs as that
interactive user at limited privilege, with restart-on-failure and no runtime
limit. Health returned ok. Source a5ec83064c82deeb2040269f01355778f9c9ebd4
preserves HP's restriction on conflicting photo captions. On the ROG, 14 focused
worker tests passed and 3 optional private-photo tests skipped.
Installed bundle SHA256:
e0209aaed46234410d199fa3bb250ad39199cbe3e52673ee82a4fafee836314c.

Compared the live intake's 23 compiled relative dependencies: only intake
message reservations and the explicit Good Shepherd caption hold changed.
Scoped deployment from 41960ba46c97149989b75efb9983124b9a55bb03 completed for
ingestWatchdogPullV2, syncWatchdogPhotoInboxV2, listWatchdogPhotoInbox,
reportWatchdogWorkerV2, claimWatchdogMessageV2 and listWatchdogWorkerReports.
All six independently read back ACTIVE. No Hosting, database or Storage rules
were deployed. No other Functions were selected. Backend code is unchanged by
the later worker-only caption fix.

HP status independently confirmed nine channels healthy, zero pending deliveries
and 17 review entries; its task, source and queue were preserved. HP remains the
active sender. ROG transport is disabled, its fresh queue is paused, and it has
no selected channels or provisioned HMAC key. WhatsApp connection was initiated
to prepare pairing; owner QR authentication is pending. No old queue was copied
and no photo/load was resent. Cloud worker roles are not activated yet. Private
source comparisons, installation logs and ACTIVE metadata are retained outside
Git under release-artifacts/watchdog-rog.

## Main handover verified

Owner QR pairing succeeded. All nine HP channel IDs were verified present in the
ROG session before copying channel options and sender-exclusion hashes. The HMAC
secret was provisioned through encrypted SSH stdin and protected with the ROG
user's DPAPI; no plaintext credential was written to a packet or Git. Signed
lifecycle access returned 82 configured wells. A signed claim for one previously
completed photo returned its original packet with recorded_once and did not call
the intake delivery endpoint.

Firebase worker coordination now enables rog-main as main; od-backup remains
disabled. The server policy's other fields were preserved with an update-time
precondition. ROG reports are visible under watchdog_workers/liquid-gold/hosts.
Final readback showed Connected, paused false, nine channels, captureHealthy true
and a six-second heartbeat age. Receiver status independently showed all nine
poll groups, Ready transport, and no receiver/photo-inbox/review-sync errors.

The HP receiver stopped responding during handover, before its pause could be
confirmed. Its worker and remote-recovery scheduled tasks were exported,
disabled and stopped; no localhost listener remained. Transport was disabled on
disk. Its queue was preserved and independently read with zero pending deliveries.
All nine selected channels had the same final successful checkpoint:
2026-11-20T07:16:39.000Z. ROG text delivery, photo capture and photo delivery
cutoffs use that checkpoint, covering the short handover gap while excluding
historical traffic. No HP messages/deliveries queue or browser profile was copied.

The fresh launcher was replaced with the committed supervised launcher from
cb1f7ad9. It redirects native process streams through Start-Process rather than
PowerShell 5 native-stderr handling, and retries after receiver exit. A deliberate
termination of the ROG's exact Node listener was followed by automatic recovery
with a different PID and a successful health check. Runtime JavaScript/source
remains a5ec83064c82deeb2040269f01355778f9c9ebd4; launcher source is recorded
separately. AC sleep was already disabled and battery settings were unchanged.

A synthetic one-pixel photo verified private signed upload, checksum completion
and repeated completion with one message identity and no WB Mobile receipt. The
exact synthetic Storage object and inbox document were then removed; real photos
and loads were unchanged. At final receiver inspection, ROG had no deliveries
since the handover cutoff. No historical load was resent.

ROG is the active main. HP is preserved but disabled, not an automatic backup.
OD backup installation, two-host failover and the next real Dwyer photo's OCR /
exactly-one-receipt acceptance remain pending. Do not call the full main/backup
deployment or real-photo acceptance complete. Windows must remain signed in for
the interactive scheduled task; its at-logon trigger is installed.
