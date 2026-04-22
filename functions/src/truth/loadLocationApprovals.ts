import * as admin from 'firebase-admin';
import type { LocationManualApproval } from '../truth-layer/types.locationHealth';

/**
 * Phase 17 — read persisted admin location approvals from RTDB.
 *
 * Storage path (see truthLocationApproval.ts for the writer):
 *   truth_overrides/location_approvals/{scope}/{safeKey}
 *     scope   = companyId or '_global'
 *     safeKey = canonicalLocationKey sanitized for RTDB path legality
 *               (. # $ [ ] / replaced with _)
 *
 * This function returns a map keyed by the raw `canonicalLocationKey`
 * (i.e. the field on the stored record, NOT the sanitized safeKey) so
 * `buildLocationIdentityDiagnostics` can do O(1) lookups against the
 * diagnostics' canonical keys without re-sanitizing.
 *
 * When `companyId` is provided, both the company-scoped and '_global'
 * scopes are merged — company entries take precedence on key collision.
 * When `companyId` is absent (WB admin all-companies view), both '_global'
 * AND every company scope are merged with '_global' taking precedence.
 *
 * Inactive records (`active === false`) are returned too — the consumer
 * decides whether to honor them. (Current Phase 17 consumer gates on
 * `active === true` in the diagnostics builder.)
 *
 * NEVER writes. Errors are caught; a truthy `sourceErrors` output from
 * the caller may surface the string. Returns an empty map on any failure.
 */
export interface LoadLocationApprovalsResult {
  approvalsByKey: Record<string, LocationManualApproval>;
  count: number;
  sourceError?: string;
}

function readApprovalsUnder(
  raw: unknown
): Record<string, LocationManualApproval> {
  const out: Record<string, LocationManualApproval> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const entry of Object.values(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const canonicalLocationKey = e.canonicalLocationKey;
    if (typeof canonicalLocationKey !== 'string' || !canonicalLocationKey) {
      continue;
    }
    const approvedDisplayName =
      typeof e.approvedDisplayName === 'string' ? e.approvedDisplayName : '';
    const approvedByUid =
      typeof e.approvedByUid === 'string' ? e.approvedByUid : '';
    const approvedAt =
      typeof e.approvedAt === 'string' ? e.approvedAt : '';
    const companyScope =
      typeof e.companyScope === 'string' ? e.companyScope : '_global';
    const active = e.active !== false;

    const approval: LocationManualApproval = {
      canonicalLocationKey,
      approvedDisplayName,
      approvedByUid,
      approvedAt,
      companyScope,
      active,
    };
    if (typeof e.approvedByEmail === 'string' && e.approvedByEmail) {
      approval.approvedByEmail = e.approvedByEmail;
    }
    out[canonicalLocationKey] = approval;
  }
  return out;
}

export async function loadLocationApprovals(
  companyId?: string
): Promise<LoadLocationApprovalsResult> {
  try {
    const db = admin.database();
    const root = db.ref('truth_overrides/location_approvals');

    // Always pull '_global' first; it applies to every view.
    const globalSnap = await root.child('_global').once('value');
    const globalMap = readApprovalsUnder(
      globalSnap.exists() ? globalSnap.val() : {}
    );

    // Company scope layered on top. If blank (all-companies), skip.
    let companyMap: Record<string, LocationManualApproval> = {};
    if (companyId) {
      const companySnap = await root.child(companyId).once('value');
      companyMap = readApprovalsUnder(
        companySnap.exists() ? companySnap.val() : {}
      );
    }

    // Company takes precedence on key collision (more specific scope wins).
    const approvalsByKey: Record<string, LocationManualApproval> = {
      ...globalMap,
      ...companyMap,
    };

    return {
      approvalsByKey,
      count: Object.keys(approvalsByKey).length,
    };
  } catch (err) {
    return {
      approvalsByKey: {},
      count: 0,
      sourceError: `location_approvals: ${(err as Error).message}`,
    };
  }
}

/**
 * Sanitize a canonicalLocationKey for use as an RTDB path segment.
 * Exported for the approval writer to compute the doc path identically.
 */
export function canonicalKeyToRtdbSafe(canonicalLocationKey: string): string {
  return canonicalLocationKey.replace(/[.#$\[\]/]/g, '_');
}
