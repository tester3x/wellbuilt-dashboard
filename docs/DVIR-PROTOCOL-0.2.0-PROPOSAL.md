# Proposed `@tester3x/wellbuilt-contracts@0.2.0` — DVIR request/completion protocol

**Status: PROPOSAL ONLY.** vc51.9D stopped at the Part 3 schema-adequacy
gate. Nothing here is implemented, and the immutable published `0.1.0`
is untouched. This document is the change set a future authorized
packet would apply to the *contracts repository* (not to Dashboard).

## Why the gate failed

`0.1.0` exports 11 runtime values + 7 types, all of which answer *"which
work period is this, and may a record bind to it?"*:

- period resolution — `resolveWorkPeriod`, `isOperationallyOpen`,
  `mayBindRequestEvidence`, `requiresWorkPeriod`, `isValidTimezone`,
  `localDateInZone`
- shift-scoped binding — `bindShiftScopedRecord`,
  `verifyShiftScopedBinding`, `ShiftScopedBinding`,
  `ShiftScopedRecordKind` (which already includes `dvir_pre_trip`,
  `dvir_post_trip`, `equipment_return_receipt`)
- versioning — `CONTRACT_VERSION`, `SUPPORTED_CONTRACT_VERSIONS`,
  `assertContractCompatible`

It describes **no request lifecycle and no wire protocol**.
`ShiftScopedBinding` is period identity only:
`{contractVersion, kind, companyId, driverId, periodId, mode, source, boundAtIso}`.

A three-party authenticated protocol (WB-S mints → eQuipment submits →
Functions validates → WB-S verifies) additionally requires agreement on
**request status, protocol version, exact key sets, the completion
submission shape, downgrade rules, and server-vs-client timestamp
naming**. None are expressible from `0.1.0`, so each of WB-S,
eQuipment, and Dashboard/Functions would declare its own copy.

That is precisely the drift the package exists to prevent — and it has
already happened once: the JSA receipt v1/v2 key sets are currently
duplicated across WB-T, WB-JSA, and `firestore.rules`, and vc51.9B had
to hand-align all three. Repeating that for DVIR would be a knowing
regression. Proven by `tools/test-dvirProtocolSchemaGap.mjs` (20/20).

## Backward-compatibility rules for 0.2.0

1. **Purely additive.** Every `0.1.0` export keeps its name, signature,
   and behavior. No field is renamed, removed, or re-typed.
2. `CONTRACT_VERSION` stays `1` — it versions the *company contract
   schema*, which is unchanged. The DVIR protocol gets its **own**
   independent `DVIR_PROTOCOL_VERSION = 1`, so the two can move apart.
3. `SUPPORTED_CONTRACT_VERSIONS` and `assertContractCompatible` are
   untouched; a parallel `assertDvirProtocolCompatible` fails closed on
   unknown protocol versions.
4. Consumers on `0.1.0` keep working unchanged; adopting `0.2.0` is
   opt-in per repository.
5. Still zero runtime dependencies, still environment-neutral (no
   Firebase, no I/O, no clock beyond injected `nowMs`).

## Proposed additive surface

```ts
// ── protocol versioning (independent of CONTRACT_VERSION) ──────────────
export const DVIR_PROTOCOL_VERSION = 1 as const;
export const SUPPORTED_DVIR_PROTOCOL_VERSIONS: readonly number[];
export function assertDvirProtocolCompatible(v: number, consumer: string): void;

// ── request lifecycle ──────────────────────────────────────────────────
export type DvirPhase = 'pre_trip' | 'post_trip';          // ⇄ ShiftScopedRecordKind
export type DvirRequestStatus = 'open' | 'consumed' | 'cancelled' | 'expired';

export interface DvirRequest {
  protocolVersion: number;
  requestId: string;            // opaque, server-minted, unenumerable
  status: DvirRequestStatus;
  phase: DvirPhase;
  companyId: string;
  driverId: string;             // server-derived, never client-supplied
  binding: ShiftScopedBinding;  // reuses 0.1.0 — no new period semantics
  issuedAtIso: string;          // server clock
  expiresAtIso: string;
}

// ── completion submission (what eQuipment sends) ───────────────────────
export interface DvirCompletionSubmission {
  protocolVersion: number;
  requestId: string;
  phase: DvirPhase;
  inspectionRecordId: string;
  /** Client-observed completion — a CLAIM, never the server time. */
  observedCompletedAtIso: string;
  /** Digest of the sealed local record; integrity, not authenticity. */
  recordDigest?: string;
}

// ── accepted completion (what the server writes / WB-S reads) ──────────
export interface DvirCompletionRecord {
  protocolVersion: number;
  completionId: string;
  requestId: string;
  phase: DvirPhase;
  companyId: string;
  driverId: string;
  inspectionRecordId: string;
  binding: ShiftScopedBinding;
  observedCompletedAtIso: string;  // client claim, labeled
  acceptedAtIso: string;           // SERVER clock — the authoritative time
  recordDigest?: string;
}

// ── exact key sets (the anti-smuggling contract, shared by rules) ───────
export const DVIR_REQUEST_KEYS: readonly string[];
export const DVIR_COMPLETION_SUBMISSION_KEYS: readonly string[];
export const DVIR_COMPLETION_RECORD_KEYS: readonly string[];

// ── pure validators (one implementation, three consumers) ──────────────
export function validateDvirCompletionSubmission(
  submission: unknown,
  request: DvirRequest,
  resolution: WorkPeriodResolution,
  nowMs: number,
): { ok: true; accepted: DvirCompletionSubmission }
  | { ok: false; reason: DvirRejection };

export type DvirRejection =
  | 'unsupported_protocol_version' | 'protocol_downgrade'
  | 'unknown_fields' | 'malformed_submission'
  | 'request_not_open' | 'request_expired' | 'request_cancelled'
  | 'phase_mismatch' | 'company_mismatch' | 'driver_mismatch'
  | 'period_mismatch' | 'period_not_open' | 'period_unverified'
  | 'already_consumed';

export function isDvirProtocolDowngrade(requested: number, answered: number): boolean;
```

`DvirPhase` ↔ `ShiftScopedRecordKind` conversion ships as a helper so
the mapping exists once, not in three repositories.

## What this buys each consumer

| Consumer | Uses |
|---|---|
| Dashboard Functions | `validateDvirCompletionSubmission` as THE validator; `DVIR_*_KEYS` for exact-key enforcement; `assertDvirProtocolCompatible` |
| `firestore.rules` | key sets mirrored from `DVIR_*_KEYS` with a source pin, exactly as `protected-company-keys.mjs` pins the company roots today |
| eQuipment | request/submission types + downgrade rule; no local copies |
| WB-S | `DvirCompletionRecord` shape + `verifyShiftScopedBinding` for exact-get verification |

## Release procedure (a later authorized packet)

1. Additive change in the contracts repo + tests (API snapshot, purity,
   conformance) — the existing 108-case suite must stay green.
2. `npm version 0.2.0`, `npm pack`, record SHA-256 + integrity.
3. Publish `0.2.0` to GitHub Packages (`0.1.0` remains immutable and
   published).
4. Re-pin consumers deliberately, one repository per commit.
5. Regenerate the Dashboard Functions A9B mirror from the **new**
   immutable artifact (`mirror-contracts.mjs --regenerate --tarball`),
   which fails closed on any hash mismatch.
6. Only then implement vc51.9D Parts 5–7.

## Open decisions for review

- **Retention/privacy of `recordDigest`** — a digest proves the sealed
  record did not change, but only if the full record is retained
  somewhere verifiable. If DVIR bodies stay device-local, the digest
  proves *integrity of a client artifact*, not that an inspection
  occurred. Decide whether full DVIR bodies must be submitted (with
  retention + read-access rules) or whether the honest claim is
  "an authenticated submission passed validation and was accepted".
- **Post-Trip without Pre-Trip** — eQuipment already supports a truthful
  `preTripNotCaptured` legacy path; decide whether the protocol accepts
  it and how the completion record labels it.
- **Request expiry window** and whether WB-S may cancel an open request.
