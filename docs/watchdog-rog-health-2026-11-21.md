# ROG Watchdog runtime and receipt verification — November 21, 2026

The owner requested a ROG check after the TicketTime update. TicketTime 165 was
installed and verified on the S24 only; the owner took the Fold for alarms and
explicitly deferred its update. No phone job was operated or closed during this
Watchdog work.

## Installed runtime

ROG remains the active `rog-main` host. Its pinned SSH identity was verified.
Before the update it was Connected, watching nine channels, with Ready transport,
a healthy cloud capture report, and no receiver/photo-inbox/review-sync error.
It still had the previously documented pending runtime update.

The prepared runtime from `d9da3984eb92d0b329b666aeb266e3ec75edde98` is now installed
in the existing LocalAppData deployment layout. Bundle SHA256:
`b13bfc3e66d2dd056360a9dc0b0cc71c887bd776db57efd84174cacb3fbd51eb`.
Every bundled file independently matched the installed bytes after activation.
The parser hash remains
`7589dabec8dfeb561a2f13ee742007cd80a981d710a941939a625e2e2dda4ce8`.

The source comparison retained the live parser and sender/Good Shepherd rules.
Only the already-prepared unresolved-photo upload/verified-receipt reconciliation
worker change was activated. Other remote branches were freshly fetched; no newer
worker changes were found. Unpushed work on another computer cannot be discovered.

The dependency lock matches the prior runtime. The new deployment reuses those
installed dependencies through a junction; retain the old runtime directory.
The existing supervised launcher already matches the prepared launcher and was
preserved, as were the task settings, linked WhatsApp profile, DPAPI credential,
sender exclusions, channel options, delivery cutoffs, and all 77 captured messages.
Configuration, queue and scheduled-task backups remain on the ROG in its private
Watchdog backup directory.

Activation paused capture, gracefully closed this receiver's browser without
logging WhatsApp out, switched the source pointer, restarted the existing task,
and resumed only after Connected/Ready and all nine channels were verified.
No historical replay, review confirmation, manual load submission, or packet
resend was requested. No Functions, Hosting, rules or cloud policy were deployed.

## Checks

- Registered-source default worker suite: 82 passed, three optional fixtures skipped.
- On-ROG focused runtime suite: 50 passed, three optional fixtures skipped.
- A broader on-ROG development-suite attempt found two missing backend test-only
  dependencies omitted from the runtime bundle. Its available tests passed; it
  is not reported as a complete default-suite runtime pass. The complete default
  suite was run from the registered source instead.
- The cloud OCR fallback remains ACTIVE with its existing verified function hash,
  activation cutoff and bounded daily policy unchanged.
- The latest real Dwyer photo's fallback audit contains two agreeing model reads
  and an automatic intake result. Its message ID resolves to exactly one delivery
  ledger entry and one processed WB Mobile packet.
- Three already-handled local Dwyer photo holds were automatically reconciled by
  verified server receipts. Their original packet IDs and one-receipt counts
  stayed unchanged before/after the update. No image re-upload or resend was
  needed to clear them. One separate possible-duplicate text hold remains in
  review; it was not confirmed, excluded or resent.
- Final readback: Connected, unpaused, nine channels, task Running, Ready transport,
  fresh healthy cloud capture heartbeat, no receiver/photo-inbox/review-sync error.

Private source hashes, runtime test logs, queue/source backups, message IDs,
readings and before/after receipt comparisons are retained outside Git under
`C:/dev/release-artifacts/watchdog-rog/`, in the files dated `20261121`.

OD backup installation and two-host failover acceptance remain separate unfinished
work. HP remains preserved/disabled. This check did not activate another sender
or claim the main/backup rollout complete.
