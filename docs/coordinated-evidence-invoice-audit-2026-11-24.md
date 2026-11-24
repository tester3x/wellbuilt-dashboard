# Coordinated JSA evidence, receipt and invoice audit repair

Status: source implementation and synthetic validation only. No deployment, APK, installation, customer record mutation or signed-record migration performed. See security-audit-verification-2026-11-24.md for the live/source findings and earlier containment.

Follow-up: [S24 local-emulator check](s24-audit-emulator-check-2026-11-24.md) passed on-device browser logic/transport checks. Native app acceptance is still outstanding; installed apps and production work were preserved.

## Changes

- New authenticated `jsaLegacyEvidence` bridge uses verified JSA driver claims plus current active company membership. Historical evidence is create-only, byte-bounded, hashed and replayed identically. A conflicting signed original is never updated or deleted. Ownership-unknown records stay on the phone for recovery.
- Receipts require an archived signed record, frozen request binding, matching owner/job/shift or period, and signature time inside that binding. Separate server-only provenance records bind the exact receipt and signed snapshot. A pre-existing anonymous receipt is not accepted just because it exists. Identical retries reuse the same receipt; conflicts are held.
- Candidate `security/jsa-evidence/firestore.rules` retains existing authorized evidence reads and denies direct client evidence mutation and all direct receipt access. Proof collections are server-only. This candidate is deliberately not wired to a deploy config; default rule deployment refusals remain.
- JSA client uses authenticated archive/receipt calls, freezes the request binding in new signed originals, uses a stable bound record ID and retries background delivery. Account-switch fences prevent another identity confirming or adopting pending evidence. Existing originals are not augmented with transport timestamps/device metadata during replay. Partial failures do not advance last-success sync time.
- Tickets invoice allocation derives company from verified identity, rejects caller-company mismatch and persists an owner-bound idempotency request before allocating. The phone scopes blocks and recycle pools to UID/driver/company, reads valid cached blocks offline and never consumes the ambiguous old global cache. Consumed progress cannot roll backward. Original queued jobs remain intact.

## Validation

All input records are synthetic. No production record probes or writes were used.

- Backend evidence handler: 8 tests passed, including membership/audience, immutable conflict, lost response, receipt provenance, wrong job/shift/time, closed-period offline replay and no governed fallback.
- Candidate Firestore rules emulator: 33 assertions passed, including owner/staff reads; anonymous/foreign denial; driver/staff create/update/delete denial; receipt/proof denial.
- Cross-repository real Firestore-emulator transactions passed: concurrent immutable archive replay, concurrent receipt replay, original timestamp/signature retention, one invoice block for repeated/concurrent reservation, nonoverlapping next range and foreign-company denial. One repeated run hit emulator INVALID_ARGUMENT transaction-closed; a separate rerun passed. The harness now randomizes request IDs so prior synthetic runs cannot collide. This is not a Functions/Auth emulator or phone acceptance test.
- JSA client/retention/sync: 10 tests passed. Receipt submission checks and 18 receipt-v2 checks passed. Workflow/history: 6 tests passed. JSA TypeScript passed.
- Tickets allocation/offline/prepared/create-accept: 35 tests passed (including 13 internal create/accept scenarios). Phone split offline numbering and retirement guard passed. Tickets and backend TypeScript passed.
- Known existing test limitation: JSA `test-wbtReadRequest.mjs` expects `captureReadRequestFromParams` directly in `app/start.tsx`; baseline already delegates to `consumeJsaStart`. Do not restore the obsolete launch route to satisfy that source pin. JSA has no scripts/retired-code-guard.cjs; the attempted invocation was unavailable, not a pass.

## Required coordinated rollout and remaining acceptance

1. Review exact combined commits across Dashboard, JSA and Tickets and provision required query indexes (owner-scoped JSA list and existing company invoice range query). Deploy nothing from a stale/default rules file. No blanket Functions deploy: live `getWellData` has authentication protections absent from older laptop source. Future allocation deployment must target only the reviewed export.
2. Stage authenticated backend bridge first while preserving existing governed JSA endpoints. Updated clients must be tested before strict candidate rules are published. Existing JSA122/Tickets459 installations were not changed by this source checkpoint. Legacy callers without reservation IDs require client-first compatibility planning before replacing live allocation.
3. S24 canary: new signed legacy record, offline save/restart/reconnect, lost acknowledgement, account/company switch, immutable original comparison, receipt read, governed prepared/standalone flows and queued offline job Start/Close. Then Fold acceptance without touching its real open job. No new preparedness or inspection certifications may be invented by automation.
4. Strict receipt/evidence rules last, after migrated client acceptance and explicit coordinated deployment authorization. Existing authenticated governed paths remain the authority; this legacy bridge cannot satisfy them.
5. Ownerless, transport-different and unproven historical records remain held, not reassigned, normalized, deleted or re-signed. Legacy ancillary PDF/day-status REST projections were removed from signoff; local signed reports remain and projections are not proof of completion. Any needed historical projection/recovery needs a separately governed design before release. Driver display-name lookup is not authorization.

Do not roll back by restoring permissive rules or discarding pending signed work. Broader audit findings (staff tenant exceptions, credential inventory/rotation, full live path matrix and device failure matrix) remain separate outstanding work. Private raw evidence and logs stay outside Git.
