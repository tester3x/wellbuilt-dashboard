# Offline / Outbox Migration Plan

## Goals

1. No loss of durable queued work across secure cutover.
2. No anonymous fallback after rule enforcement.
3. Idempotent replay.

## Pre-cutover (dual-run, rules open)

- New builds try secure callables first; fall back to legacy only if callable fails **and** error is transport/not-found (not permission-denied after enforcement).
- All new queue entries store:
  - `schemaVersion: 2`
  - `idempotencyKey`
  - `driverId` / `passcodeHash` (legacy) / secure session flag
  - `op` enum: `packet_ingest | ticket_submit | photo_upload | jsa_submit | shift_upsert | chat_message`

## At enforcement

1. App starts → require secure login (custom token) before any replay.
2. Refresh ID token; on failure, **pause** queue (do not delete).
3. Replay in order; on success mark done; on 401 reauth; on 403 surface to user and keep.
4. Legacy `schemaVersion: 1` items: map to secure ops if possible; else show “update required / contact admin” and retain until drained manually.

## Photo/PDF

- Do not base64 through callables.
- Use `requestStorageUploadPath` → authenticated Storage upload to returned path.
- On failure, keep local file URI in queue.

## Token expiry

- Queued items never auto-purge on auth failure.
- Max retention: existing product policy (no change this pass).
