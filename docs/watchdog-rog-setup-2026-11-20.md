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
