# Restore request-bound JSA well display

The Android JSA client refuses a pending full-read request without a server-authorized wellName. Live jsaGetReadRequest returned request metadata without the well display fields, so the client could not safely enter that flow.

## Proven source lineage

Read-only Cloud Functions v2 inspection of wellbuilt-sync/us-central1 found jsaGetReadRequest revision jsagetreadrequest-00003-xoj, updated 2026-08-23T02:21:16.939306339Z. Its deployed handlers match the register/complete/consume deployment archives. Every one of the 235 deployed src files matches commit 871ef44886c8bcb6a4f150390861f1dc96c859e9 after newline normalization. The isolated branch starts at that exact base; no dirty shared checkout was used.

Reviewed/reused commit 5cd438f1558b4a30aac2be0bf0617bc3014a1110, applied as 8d365216. It adds a read-only lookup of the registered request's invoice/job after the existing principal/request/shift/policy checks. Company and driver assignment must match. Only bounded wellName and optional jobType are returned; missing/foreign/malformed jobs share not_found. Completed and acknowledge-only requests do not read the invoice. No invoice or other commercial record is written.

## Validation

- Functions TypeScript build passes.
- Request/receipt suite: 138 passed, zero failed.
- SSO JSA spine: 14 passed, zero failed.
- Immutable contracts mirror: 59 files match version 0.5.0.
- Firestore emulator: 15 direct read/list/write attempts denied for anonymous, JSA, Tickets, Suite, and foreign-company driver identities. The pinned rules use catch-all deny, not a redundant exact collection block; the source-shape test now recognizes that baseline and the behavioral emulator checks verify the denial. Rules were not edited.

Deployment scope: ONLY functions:dashboard:jsaGetReadRequest. Recheck live revision immediately before deployment and verify deployed source/revision and unchanged peer revisions afterward. No rules, Hosting, other Functions, shift records, or commercial writes are authorized by this restoration.

This restores job display for existing governed requests. It does not implement Suite's separate end-of-shift JSA closure/recovery contract. Phone vc28 presentation refresh is a separate repository/build. Actual read/sign/close device testing remains pending under Liquid Gold.

## Deployment verified

Deployed from b38e14e7 using the explicit single-function list above. Target is ACTIVE at revision jsagetreadrequest-00004-nob, updated 2026-09-13T14:38:35.161613289Z. Downloaded deployed source: all three changed TypeScript modules and their compiled JavaScript match the reviewed local build byte-for-byte. A live unauthenticated request returned 401 UNAUTHENTICATED.

Register, complete, consume, and current-shift-read-evidence peer revisions remained identical to the predeployment inventory. CLI reported only the target function update. No rules or other resources deployed; no production JSA, job, invoice, payroll, or shift record was created/changed by verification.
