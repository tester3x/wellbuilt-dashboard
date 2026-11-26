# Physical pickup versus level-observation watermark

Source: `1327542a` (preceded by `199261fb`). Deployed only
`dashboard:processIncomingPull` to `wellbuilt-sync`, us-central1.
Live ACTIVE update: 2026-11-26T20:10:59.053Z.

A later zero-barrel observation previously caused a delayed physical pickup
to be quarantined as stale. The processor now resolves the latest positive-barrel
pickup when this specific conflict occurs, preserving the stale/future/duplicate
guards against actual pickups and using that pickup's production interval.
Production calculations exclude measurements after the incoming pickup time.
The extra history query is scoped to the one well and only occurs on conflict;
no polling, new triggers, rules, indexes, Hosting or app releases were added.

Validation: TypeScript build; 47 tests across pickupWatermark, packetGuards
(including handler wiring), and crossKeyPullClaim. Downloaded live source and
verified compiled index and helper byte-for-byte against the committed build.

Compiled SHA256:
- lib/index.js: 0d931a9fe09e759c70dde2e9d963f1b5e229973cd6de068c4d9bac7d53469e33
- lib/pickupWatermark.js: afa48785a6776b723e92a063420ba0ff3a5526871a1c9f8e3766ac432999dbeb

Authorized single-record recovery used the original packet ID and payload,
after checking scoped well history for the packet, alias, linked invoice and
matching physical-pull fingerprint. A conditional create prevented overwriting
an existing incoming packet. Final readback proved one matching completed
receipt, cleared incoming, matching outgoing, and an applied deduplication claim.
The lossless rejection was retained and annotated recovered. The observation
and all earlier processed records for the well remained unchanged.

Recovery exposed a future-observation production-window artifact. The second
source commit prevents it; only the recovered well's affected outgoing estimate
and production-window field were corrected with ETag conditions, preserving
other fields and counters. No second pickup replay was performed.

Customer identifiers, snapshots, mutation backups and verification receipts
remain outside Git under the laptop's private release-artifacts directory.
Other jobs, signed evidence and strict rules were not modified.
