# Proposed `@tester3x/wellbuilt-contracts@0.2.0` — DVIR request/completion protocol

**Status: PUBLISHED AND ADOPTED (vc51.9F / vc51.9G).** This began as a
proposal written when vc51.9D stopped at the Part 3 schema-adequacy
gate. `0.2.0` has since been authored, audited, published immutably, and
pinned by this repository.

- Published `@tester3x/wellbuilt-contracts@0.2.0`, tag `v0.2.0` at
  contracts commit `2a913de`
- SHA-256 `aa99296cdd71d94322a1e36862177de427a32301d034aacbdc1b03010e8c171f`
- Integrity `sha512-uf6QuaWGloxvsnphgOM8SVINNLkv6scBLvdfRf9LCz+iBSwMxw3A2/4CQSyQMI5cfK6YhaZr9HCNYE8StjJtoQ==`
- 39 files, 45,589 bytes, zero runtime/peer dependencies, private,
  UNLICENSED
- `0.1.0` remains published, immutable, and byte-unchanged

The Part 3 gate is therefore **closed** — see
`tools/test-dvirProtocolSchemaGap.mjs`, which now proves each required
agreement resolves to a real `0.2.0` export.

**Still not implemented:** the server-side DVIR request/completion
protocol. Adopting the package is not implementing the protocol;
vc51.9D remains future work, and the undeployed phase-1a
`functions/src/equipment/*` protocol must be retired or adapted before
any deployment — it must never ship with client-supplied `driverHash`
authority.

The sections below are retained as the authored design record. Where
they describe what a future packet "would" do, that work is now done.

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

---

# RECONCILIATION — the 0.2.0 release candidate now exists (vc51.9E)

The proposal above was written before the eQuipment domain census. The
authored candidate differs where the real domain demanded it. **This
section supersedes the sketch above where they disagree.**

## Final exported API (additive; 71 runtime exports total)

`DVIR_PROTOCOL_VERSION`, `SUPPORTED_DVIR_PROTOCOL_VERSIONS`,
`assertDvirProtocolCompatible`, `isDvirProtocolDowngrade`,
`DVIR_PHASES`/`isDvirPhase`, `recordKindForPhase`/`phaseForRecordKind`,
`DVIR_REQUEST_STATUSES`/`isDvirRequestStatus`,
`isLegalDvirRequestTransition`, `isDvirRequestConsumable`,
`DVIR_ITEM_RESULTS`/`isDvirItemResult`/`DVIR_ITEM_RESULT_MEANING`,
`DVIR_ISSUE_SEVERITIES`, `DVIR_ASSET_ROLES`, `DVIR_ATTESTATION_KINDS`,
`DVIR_COMPLETION_OUTCOMES`, `DVIR_LEGACY_CATEGORY_IDS`, `DVIR_BOUNDS`,
`normalizeDvirExplanation`, `validateDvirNormalizedEvidence`,
`computeLegacyCategoryProjection`, `canonicalDvirEvidenceString`,
`validateDvirCompletionSubmission`, `toDvirCompletionView`,
`viewMatchesRecord`, `isEquivalentDvirCompletion`,
`satisfiesEnforcedDvirPhase`, `validateDvirMissingEvidenceSubmission`,
`missingEvidenceSatisfiesEnforcedPhase`,
`isDvirMissingEvidenceSubmission`, plus every `DVIR_*_KEYS` key set and
the shared guards (`isBoundedId`, `isIsoTimestamp`,
`containsBinaryPayload`, id regexes).

Naming changed from the sketch: `DvirCompletionRecord.acceptedAtServer`
(was `acceptedAtIso`) and `observedCompletedAtClient` (was
`observedCompletedAtIso`) — the suffixes now make client-vs-server
provenance unmistakable at every call site.

## State machine

Request: `open → {completed | cancelled | expired}`; every terminal
state is final (`isLegalDvirRequestTransition`), and only an `open`,
unexpired request is consumable. Completion: validate submission
against the server's request **and** an independently re-resolved
binding → write the immutable record → derive the view. An identical
re-submission is the same completion (`isEquivalentDvirCompletion`); a
conflicting one is a genuine conflict.

## Evidence vs receipt separation

Full `DvirNormalizedEvidence` (items, issues, explanations,
attestation) is server-persisted and administratively retrievable.
`DvirCompletionView` — what WB-S exact-gets — carries only protocol
version, ids, company, driver, binding, phase, inspection record id,
outcome, evidence digest, and `acceptedAtServer`.
`DVIR_VIEW_FORBIDDEN_KEYS` names what may never appear there or in a
deep link; a test asserts the typed name and explanation text are
absent from the serialized view.

## `preTripNotCaptured`

A separate type with an outcome (`recorded_missing_evidence`)
deliberately outside `DvirCompletionOutcome`. It has no completionId,
no evidenceDigest, and no accepted outcome, so no receipt or view can
be derived; `missingEvidenceSatisfiesEnforcedPhase` returns the literal
type `false`. Payloads carrying completion material are rejected with a
distinct `completion_fields_present` reason.

## Retention — still unresolved

No automatic deletion, no hardcoded duration, records immutable. Who
may delete and after how long remains a policy decision requiring
separate review before any production retention behavior ships.

## Expected integration (future authorized packets)

- **Functions** — `validateDvirCompletionSubmission` becomes THE gate;
  identity from `requireSecureDriver` (verified claims), period from the
  canonical resolver, `acceptedAtServer` from the server clock only.
- **Firestore rules** — mirror `DVIR_*_KEYS` with a source pin exactly
  as `protected-company-keys.mjs` pins the company roots; server-only
  writes, no enumeration, exact-get for the owning driver/company.
- **eQuipment** — adopt `authenticateDriver` (the established flow WB-S
  already uses), construct submissions from the shared types, and
  implement the now-required explanation on `needs_attention`.
- **WB-S** — exact-get the view and verify it via `viewMatchesRecord` +
  `satisfiesEnforcedDvirPhase`; never enumerate, never trust link fields.
- **A9B mirror** — must be regenerated from the eventual published
  0.2.0 artifact; its expected sha256/integrity constants change to the
  values in `RELEASE-0.2.0-CANDIDATE.md`.

## Disposition of the pre-existing phase-1a equipment protocol

`functions/src/equipment/{types/dvir.ts, services/dvirService.ts}` and
the client mirror `src/lib/equipment/dvirContracts.ts` predate this
work and are **undeployed** (60 live functions; none equipment/DVIR),
so no live record can exist through that path and there is no data
migration.

They must not become a second protocol. Required before any deploy:

1. **Retire or adapt** `dvir.submitPreTrip`. It has no period binding,
   is pre-trip only server-side, and has no request/completion state
   machine, protocol version, or idempotency.
2. **Never ship its trust model** — `requireDriver` validates a
   *client-supplied* `driverHash`; the canonical protocol requires
   server-derived identity from verified claims.
3. **Reconcile the existing client/server drift** — the client mirror
   permits `pre_trip | post_trip | periodic` and
   `submitted | draft | reviewed` while the server accepts only
   `pre_trip`/`submitted`.
4. **Keep the category axis as a projection.** The item model is
   canonical; `computeLegacyCategoryProjection` reproduces the nine
   phase-1a categories from `legacyCategoryId`, so the existing
   category-shaped consumers can be adapted rather than duplicated.
