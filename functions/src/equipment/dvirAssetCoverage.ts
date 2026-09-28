/**
 * Pure pre-trip coverage over already trusted server rows.
 *
 * This module does not read Firestore, Auth, or Equipment device state.
 * A caller must normalize rows first. Dashboard `equipmentId` and
 * Equipment's `truck_<unit>` / `trailer_<unit>` strings are different
 * namespaces. This function compares `equipmentId` for exact equality
 * and does not translate a typed unit into either form.
 *
 * It does not read a client `verified` flag, a device receipt, a hash,
 * or a company/driver id supplied by the caller as proof. Company and
 * driver come only from `authority` when that authority is open.
 * Off-shift policy is not decided here: unavailable authority covers nothing.
 */

export type DvirAssetRole = 'truck' | 'trailer';
export type DvirCoveragePhase = 'pre_trip';
export type DvirInspectedResult = 'pass' | 'needs_attention';
export type TrustedRowStatus = 'accepted' | 'voided';

export interface TrustedDvirAssetRow {
  companyId: string;
  driverId: string;
  periodId: string;
  phase: DvirCoveragePhase;
  role: DvirAssetRole;
  /** Canonical Dashboard equipment id. Not a unit-derived asset id. */
  equipmentId: string;
  inspectionId: string;
  acceptedAtMs: number;
  result: DvirInspectedResult;
  status: TrustedRowStatus;
}

export type PeriodAuthority =
  | { state: 'open'; companyId: string; driverId: string; periodId: string }
  | { state: 'unavailable' };

export interface RequestedCoverageAsset {
  role: DvirAssetRole;
  equipmentId: string;
}

export interface DvirAssetCoverageInput {
  phase: DvirCoveragePhase;
  authority: PeriodAuthority;
  assets: readonly RequestedCoverageAsset[];
  rows: readonly TrustedDvirAssetRow[];
}

export type AssetCoverageReason =
  | 'accepted'
  | 'not_inspected'
  | 'authority_unavailable'
  | 'identity_mismatch'
  | 'role_mismatch'
  | 'voided'
  | 'stale_result';

export interface AssetCoverage {
  role: DvirAssetRole;
  equipmentId: string;
  covered: boolean;
  reason: AssetCoverageReason;
  inspectionId?: string;
  acceptedAtMs?: number;
  result?: DvirInspectedResult;
}

export type DvirAssetCoverageDecision =
  | { ok: false; reason: 'malformed' }
  | {
      ok: true;
      phase: DvirCoveragePhase;
      period: { state: 'open'; periodId: string } | { state: 'unavailable' };
      assets: AssetCoverage[];
    };

const ROLES: readonly DvirAssetRole[] = ['truck', 'trailer'];
const RESULTS: readonly DvirInspectedResult[] = ['pass', 'needs_attention'];

function isRole(v: unknown): v is DvirAssetRole {
  return v === 'truck' || v === 'trailer';
}

function isResult(v: unknown): v is DvirInspectedResult {
  return v === 'pass' || v === 'needs_attention';
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v === v.trim();
}

function requestMalformed(input: DvirAssetCoverageInput): boolean {
  if (input.phase !== 'pre_trip') return true;
  if (!input.authority || (input.authority.state !== 'open' && input.authority.state !== 'unavailable')) {
    return true;
  }
  if (input.authority.state === 'open') {
    const a = input.authority;
    if (!isNonEmpty(a.companyId) || !isNonEmpty(a.driverId) || !isNonEmpty(a.periodId)) return true;
  }
  if (!Array.isArray(input.assets) || !Array.isArray(input.rows)) return true;
  const seen = new Set<DvirAssetRole>();
  for (const asset of input.assets) {
    if (!asset || !isRole(asset.role) || !isNonEmpty(asset.equipmentId)) return true;
    if (seen.has(asset.role)) return true;
    seen.add(asset.role);
  }
  return false;
}

function rowShapeUsable(row: TrustedDvirAssetRow): boolean {
  return !!row
    && isNonEmpty(row.companyId)
    && isNonEmpty(row.driverId)
    && isNonEmpty(row.periodId)
    && row.phase === 'pre_trip'
    && isRole(row.role)
    && isNonEmpty(row.equipmentId)
    && isNonEmpty(row.inspectionId)
    && typeof row.acceptedAtMs === 'number'
    && Number.isFinite(row.acceptedAtMs)
    && (row.status === 'accepted' || row.status === 'voided')
    && isResult(row.result);
}

function newer(a: TrustedDvirAssetRow, b: TrustedDvirAssetRow): TrustedDvirAssetRow {
  if (a.acceptedAtMs !== b.acceptedAtMs) return a.acceptedAtMs > b.acceptedAtMs ? a : b;
  return a.inspectionId >= b.inspectionId ? a : b;
}

function sameAssetIdentity(
  row: TrustedDvirAssetRow,
  authority: Extract<PeriodAuthority, { state: 'open' }>,
  asset: RequestedCoverageAsset,
): boolean {
  return row.companyId === authority.companyId
    && row.driverId === authority.driverId
    && row.periodId === authority.periodId
    && row.phase === 'pre_trip'
    && row.equipmentId === asset.equipmentId;
}

function decideAsset(
  authority: PeriodAuthority,
  asset: RequestedCoverageAsset,
  rows: readonly TrustedDvirAssetRow[],
): AssetCoverage {
  const base = { role: asset.role, equipmentId: asset.equipmentId, covered: false as const };
  if (authority.state !== 'open') {
    return { ...base, reason: 'authority_unavailable' };
  }

  const usable = rows.filter(rowShapeUsable);
  const accepted = usable.filter((row) =>
    sameAssetIdentity(row, authority, asset) && row.role === asset.role && row.status === 'accepted');
  if (accepted.length > 0) {
    const winner = accepted.reduce(newer);
    return {
      ...base,
      covered: true,
      reason: 'accepted',
      inspectionId: winner.inspectionId,
      acceptedAtMs: winner.acceptedAtMs,
      result: winner.result,
    };
  }

  const voided = usable.some((row) =>
    sameAssetIdentity(row, authority, asset) && row.role === asset.role && row.status === 'voided');
  if (voided) return { ...base, reason: 'voided' };

  const roleMismatch = usable.some((row) =>
    sameAssetIdentity(row, authority, asset)
    && row.role !== asset.role
    && row.status === 'accepted');
  if (roleMismatch) return { ...base, reason: 'role_mismatch' };

  const identityMismatch = usable.some((row) =>
    row.equipmentId === asset.equipmentId
    && row.role === asset.role
    && row.phase === 'pre_trip'
    && row.status === 'accepted'
    && (row.companyId !== authority.companyId
      || row.driverId !== authority.driverId
      || row.periodId !== authority.periodId));
  if (identityMismatch) return { ...base, reason: 'identity_mismatch' };

  const stale = rows.some((row) =>
    row
    && row.companyId === authority.companyId
    && row.driverId === authority.driverId
    && row.periodId === authority.periodId
    && row.phase === 'pre_trip'
    && row.role === asset.role
    && row.equipmentId === asset.equipmentId
    && row.status === 'accepted'
    && !isResult(row.result));
  if (stale) return { ...base, reason: 'stale_result' };

  return { ...base, reason: 'not_inspected' };
}

/**
 * Repeat calls with the same input return the same decision and write nothing.
 * `needs_attention` is an inspected result. No out-of-service rule is applied.
 */
export function evaluateDvirAssetCoverage(input: DvirAssetCoverageInput): DvirAssetCoverageDecision {
  if (requestMalformed(input)) return { ok: false, reason: 'malformed' };
  const period = input.authority.state === 'open'
    ? { state: 'open' as const, periodId: input.authority.periodId }
    : { state: 'unavailable' as const };
  return {
    ok: true,
    phase: 'pre_trip',
    period,
    assets: input.assets.map((asset) => decideAsset(input.authority, asset, input.rows)),
  };
}

export const DVIR_COVERAGE_RESULTS = RESULTS;
export const DVIR_COVERAGE_ROLES = ROLES;
