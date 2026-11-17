# Remote Watchdog photo inbox rollout

This update mirrors original photos into private Firebase Storage and metadata into
`watchdog_photo_inbox/liquid-gold/items/{messageHash}`. It does not submit loads.
The worker retains the original WhatsApp channel and message ID. The hash matches
the `messageHash` on existing Watchdog delivery records.

## Backend

- Deploy only `syncWatchdogPhotoInboxV2`, `listWatchdogPhotoInbox`, and the reconciled
  `ingestWatchdogPullV2`. Preserve all deployed Dwyer and Good Shepherd routing
  changes before compiling that intake function. See the reconciled baseline below.
- Confirm the Functions service account can sign Storage URLs and access its
  default private bucket. No public Storage rule changes are required.
- Uploads use ten-minute, immutable-object signed URLs. Completion verifies size,
  MIME type, and SHA-256 against the actual stored bytes before marking ready.
- Listing requires the existing company-scoped Watchdog office authorization.
  Photo read URLs expire after ten minutes.
- Receipt lookup reports `recorded_once`, `duplicate_attention`,
  `delivery_unconfirmed`, or `no_message_receipt`. The last state is not proof
  that a manually entered equivalent load is absent. Check well history too
  before authorizing a confirmed missing load.
- New delivery reservations bind channel, message ID, and row index atomically
  to one observation identity/packet. Legacy unindexed delivery conflicts are
  held for explicit reconciliation. Reviewed corrections to an existing load
  must continue through the existing edit operation, not another load.

## HP installation when home

1. Verify the pinned SSH host identity, capture actual worker path, Git commit,
   dirty source, installed overlays, running task entry point and queue backup.
   Preserve the live Dwyer/Good Shepherd parser and restart fixes.
2. Reconcile the additive `photo-inbox.mjs` file and the small `server.mjs`
   import/timer/settings-route/status changes into that existing worker.
   Do not replace the HP server with this checkout's older text-only server.
   The downloader uses the live `dwyer-photo.mjs` synced-image downloader when
   present and falls back to WhatsApp's normal media API.
3. Restart through the established worker restart procedure. After checking the
   backend release, POST `{"enabled":true}` to the token-protected loopback
   `/remote-photo-inbox` route. This enables photo mirroring only. Preserve the
   existing delivery and remote-review settings.
4. Use a held original photo. Confirm its bytes/digest and original message ID
   in the cloud, compare packet IDs against WB Mobile, then poll again. The cloud
   object/document counts must stay flat. No load confirmation or resend is part
   of this installation test.
5. Verify an unavailable old photo does not block newer photos. Check
   `remotePhotoInboxError` and `remotePhotoInboxEnabled` on `/status`.

## Reconciled live baseline — November 17, 2026

The cloud deployment archive was read through the Cloud Functions API. Live
ingestWatchdogPullV2 revision ingestwatchdogpullv2-00049-wib was ACTIVE, last
updated 2026-11-07T01:03:01.752379124Z. Its compiled JavaScript contains Dwyer
photo intake changes missing from the TypeScript source stored in that archive.
The prepared source now retains those compiled behaviors. A recursive comparison
of 23 compiled relative dependencies found only the intended intake message-ID
additions. Source reconciliation includes verified well restart, late app-match,
shorthand parser, and Dwyer photo transaction recovery changes. Existing receipt
and core remote-review functions must not be redeployed merely because they
share the intake source module.

The seven intake failures were stale fixtures/expectations. Known barrel loads
use calibrated removal while retaining reported-bottom provenance. Feet-and-inches
input 12.5 means 12 feet 5 inches in this intake lane. The invalid-bottom fixture
failed validation before the removal check, the nearby-pull fixture used a
different numeric top, and the edit fixture had not applied its corrected top.
Tests now exercise those contracts without weakening production calibration or
validation.

## Validation on the laptop

TypeScript compilation passed. All 146 Watchdog backend tests and both worker
photo-sync tests passed. A changed-gauge/image photo regression proves that a
second observation from the same WhatsApp message cannot issue another packet.
An alias-message retry is also reserved to its original delivery. Inbox lookup
includes reservations linked to existing app-created loads.

The backend is prepared for scoped deployment when home. HP installation still
requires the pinned-host/source/overlay check and additive server patch. No
backend deployment, HP installation, photo upload, live load submission, or
resend occurred during preparation. Live Storage URL signing and original-photo
upload remain installation acceptance checks.
