# Watchdog main and backup

Prepared for ROG main (`rog-main`) and old desktop backup (`od-backup`). Roles
are assigned in Firebase, never by a local machine promoting itself. Neither
host has been installed/configured in this work yet. The current connection is
the phone hotspot; home-host runtime/source/overlay checks remain necessary.

## Delivery and verification

- Each source WhatsApp channel/message/row gets one shared message reservation.
- Main can claim immediately. Backup waits two minutes from first cloud sighting,
  then claims if the 90-second work lease has expired. A healthy main heartbeat
  cannot indefinitely hide a stuck individual message.
- Before attempting delivery, both machines check the same reservation and legacy
  delivery records. An existing load is verified against `packets/processed` and
  the original receipt resumed if still pending. A missing response does not
  authorize another load. Multiple packet IDs stop for review.
- Claims coordinate effort; the intake's transactional message reservation and
  existing deterministic packet delivery remain the final duplicate barrier.
  Do not enable two hosts until that reconciled intake has been deployed/verified.
- Review/OCR ambiguity stays review. No guessed bottom or pre-haul is made by the
  backup. Explicit 21-15H/41-15 captions route to their named Good Shepherd review
  entries, with two tanks and blank pre-haul. Confirm host overlays also recognize
  identifiers printed inside photos before deployment; do not replace those with
  caption-only recognition.
- Completed local rows are audited again in rotating batches (up to 100 recent
  posts). A local completion badge is not accepted as proof of a cloud receipt.

## Firebase reports

`watchdog_workers/liquid-gold/hosts/{workerId}` holds current state, source commit,
last capture time, pending/review counts and error. Heartbeats run every 30 seconds;
five-minute report buckets retain history under `reports`. Capture is healthy only
with a fresh successful WhatsApp poll. Reports older than two minutes are stale.
`messages/{messageReservationKey}` records the checking worker, packet/identity,
and `recorded_once` or `delivery_unconfirmed` after actual WB Mobile lookup.
Capture health does not mean every message has been handled.

`listWatchdogWorkerReports` exposes current host/message status to the existing
company-scoped office authorization. No public rules or public photos are added.
Existing private photo-inbox synchronization remains enabled separately.

## Installation and activation gates

1. On home Wi-Fi, verify each registered source/home and current source, Windows
   user, pinned SSH identity, browser profile, queue and scheduled task. Back up
   configuration and queue. Reconcile HP's live Dwyer/Good Shepherd and restart
   overlays; never replace its worker wholesale with an older server.
2. Install exact committed source and dependencies in each registered home. Use
   separate linked WhatsApp device sessions; never copy the same browser profile.
   Provision the existing HMAC credential privately for each Windows user.
3. Deploy only the new coordination endpoints and the prepared photo-inbox /
   reconciled intake endpoints after live dependency comparison. Do not redeploy
   unrelated Functions, Hosting or any database/storage rules.
4. Write each host's `worker.json` using `configure-worker.ps1`. This preserves the
   original worker data and does not start or replay anything. A malformed config
   fails closed. Existing single-host installations without worker.json keep
   their existing behavior until deliberately migrated.
5. Firebase `watchdog_v2_config/laptop.workerCoordination` must explicitly contain
   `enabled:true` and `workers.rog-main:{enabled:true,role:"main"}` plus
   `workers.od-backup:{enabled:true,role:"backup"}`. Leave disabled until both
   identities and message reservations are ready. Disable the old HP sender when
   ownership transfers; preserve its queue for reconciliation.
6. Verify both fresh heartbeats, exact source commits and configured channels.
   Test a synthetic main success, lost response, main stopped before send,
   backup takeover and main recovery. Each message must have one processed packet
   throughout, and both hosts must report the same packet. No historical resend.
7. Acceptance requires the next real Dwyer photo to arrive, parse correctly,
   produce exactly one WB Mobile receipt and be independently verified by backup.
   Until then do not call the deployment self-verifying or retire daily checks.

## Source reconciliation and local checks

Base: `e75fc221` (prepared photo inbox/intake plus current laptop work). Isolated
worker changes from `c477fa34` brought the newer Dwyer OCR/download/restart path
into this base. Three conflicts were reconciled retaining photo intake, private
photo mirroring and sender-ignore behavior. Unrelated application implementations
were not copied or merged from the HP branch.

Functions TypeScript build passed. All 167 Watchdog backend tests passed before
the final report endpoint addition; rerun on the final source. Worker tests
reported 79 passed, 3 optional tests skipped. Host installation, live reporting,
failover and physical photo acceptance remain unverified.
