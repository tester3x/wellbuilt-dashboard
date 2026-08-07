/**
 * Canonical DVIR request/completion protocol (vc51.9E) — primitives.
 *
 * ONE shared protocol for WB-S, eQuipment, Dashboard Functions, and
 * Firestore rule-source pins. Every literal, key set, bound, and state
 * transition lives here exactly once so the JSA receipt v1/v2 outcome —
 * the same key sets hand-copied into three repositories — cannot repeat.
 *
 * INDEPENDENT VERSION. `DVIR_PROTOCOL_VERSION` is deliberately separate
 * from `CONTRACT_VERSION` (which versions the company-contract schema and
 * stays 1): the wire protocol and the company contract must be able to
 * move apart. Unknown protocol versions fail closed.
 *
 * ADDITIVE ONLY. Nothing in this module changes any 0.1.0 export.
 *
 * Derived from the established eQuipment domain (packages/dvir-domain),
 * not from assumptions — see docs in DvirNormalizedEvidence for the
 * field-by-field provenance.
 */
import type { ShiftScopedRecordKind } from '../types.js';
export declare const DVIR_PROTOCOL_VERSION: 1;
export type DvirProtocolVersion = typeof DVIR_PROTOCOL_VERSION;
export declare const SUPPORTED_DVIR_PROTOCOL_VERSIONS: readonly number[];
/** Fail closed on any unknown/future protocol version. */
export declare function assertDvirProtocolCompatible(version: number, consumerName: string): void;
/**
 * A v2-capable requester must never accept a v1 answer, and vice versa —
 * the answered version must EQUAL the requested one.
 */
export declare function isDvirProtocolDowngrade(requested: number, answered: number): boolean;
/** The two protected DVIR phases. (`periodic` exists in the eQuipment
 *  domain's InspectionType but is NOT part of the protected protocol.) */
export type DvirPhase = 'pre_trip' | 'post_trip';
export declare const DVIR_PHASES: readonly DvirPhase[];
export declare function isDvirPhase(v: unknown): v is DvirPhase;
/** The 0.1.0 shift-scoped record kind a phase binds as — no new vocabulary. */
export declare function recordKindForPhase(phase: DvirPhase): ShiftScopedRecordKind;
export declare function phaseForRecordKind(kind: ShiftScopedRecordKind): DvirPhase | null;
export type DvirRequestStatus = 'open' | 'completed' | 'cancelled' | 'expired';
export declare const DVIR_REQUEST_STATUSES: readonly DvirRequestStatus[];
export declare function isDvirRequestStatus(v: unknown): v is DvirRequestStatus;
export declare function isLegalDvirRequestTransition(from: DvirRequestStatus, to: DvirRequestStatus): boolean;
/** Only an `open`, unexpired request may be completed. */
export declare function isDvirRequestConsumable(status: DvirRequestStatus, expiresAtIso: string | null | undefined, nowMs: number): boolean;
/**
 * `pass_by_area_completion` states exactly what the established domain
 * proves: no issue was reported before the driver completed/advanced the
 * area (`nextArea()` bulk-resolves remaining `pending` items). It is NOT
 * an affirmative per-item tap and must never be presented as one.
 * `needs_attention` mirrors the domain's own defect result.
 */
export type DvirItemResult = 'pass_by_area_completion' | 'needs_attention';
export declare const DVIR_ITEM_RESULTS: readonly DvirItemResult[];
export declare function isDvirItemResult(v: unknown): v is DvirItemResult;
/** Human-honest description — for UI/report copy, so no consumer invents its own. */
export declare const DVIR_ITEM_RESULT_MEANING: Readonly<Record<DvirItemResult, string>>;
/** Severity — the domain's only defect classification. NOTE: the
 *  established domain has NO out-of-service concept, and 0.2.0
 *  deliberately does not invent one (possible future product addition). */
export type DvirIssueSeverity = 'minor' | 'major' | 'critical';
export declare const DVIR_ISSUE_SEVERITIES: readonly DvirIssueSeverity[];
export declare function isDvirIssueSeverity(v: unknown): v is DvirIssueSeverity;
export type DvirAssetRole = 'truck' | 'trailer';
export declare const DVIR_ASSET_ROLES: readonly DvirAssetRole[];
/** Attestation kind — the production path is a typed legal name. */
export type DvirAttestationKind = 'typed_name';
export declare const DVIR_ATTESTATION_KINDS: readonly DvirAttestationKind[];
/** Completion outcomes. `recorded_missing_evidence` is NOT a completion —
 *  see missingEvidence.ts; it exists so the union is exhaustive. */
export type DvirCompletionOutcome = 'accepted';
export declare const DVIR_COMPLETION_OUTCOMES: readonly DvirCompletionOutcome[];
/**
 * The nine Dashboard phase-1a categories. In 0.2.0 the ITEM model is
 * canonical; this axis is a projection derived from each item's
 * `legacyCategoryId`, kept so the existing category-based service and its
 * client mirror can be adapted rather than competing with the protocol.
 */
export declare const DVIR_LEGACY_CATEGORY_IDS: readonly ["lights", "brakes", "tires", "emergency_equipment", "fluid_leaks", "tank", "hoses", "pto", "miscellaneous"];
export type DvirLegacyCategoryId = (typeof DVIR_LEGACY_CATEGORY_IDS)[number];
export declare function isDvirLegacyCategoryId(v: unknown): v is DvirLegacyCategoryId;
export declare const DVIR_BOUNDS: Readonly<{
    /** Explanations are REQUIRED on needs_attention (vc51.9E decision 1) and
     *  bounded here, in the shared domain — never only by a UI maxLength. */
    explanationMin: 1;
    explanationMax: 500;
    idMax: 120;
    labelMax: 200;
    maxAssets: 2;
    maxAreas: 40;
    maxItemsPerArea: 60;
    maxTotalItems: 400;
    maxIssues: 100;
    maxEvidenceRefsPerIssue: 10;
    signerDisplayNameMax: 120;
    timezoneMax: 64;
    reasonMax: 300;
}>;
/** Canonical explanation normalization — collapse whitespace, trim.
 *  Shared so every consumer normalizes identically before hashing. */
export declare function normalizeDvirExplanation(raw: string): string;
export declare function isBoundedId(v: unknown): v is string;
export declare function isBoundedLabel(v: unknown, max?: number): v is string;
export declare function isIsoTimestamp(v: unknown): v is string;
/** Raw binary / data URLs are forbidden everywhere in this protocol. */
export declare function containsBinaryPayload(v: unknown): boolean;
//# sourceMappingURL=protocol.d.ts.map