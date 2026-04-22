import * as httpsV2 from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireAdminRole } from './requireAdminRole';
import { canonicalKeyToRtdbSafe } from './loadLocationApprovals';
import type { LocationManualApproval } from '../truth-layer/types.locationHealth';

interface RawRequest {
  /**
   * Required. The canonical location key from the Location Health drilldown
   * (e.g. "loc:atlas 1"). Used verbatim in the stored record and as the
   * override lookup key on subsequent read paths.
   */
  canonicalLocationKey?: string;
  /**
   * Optional. Admin-preferred display name. If blank/missing, the
   * consumer falls back to the location's preferredName on read.
   */
  approvedDisplayName?: string;
  /**
   * Optional. Company scope. Blank / absent means '_global' (applies to
   * every view). Otherwise this is a companyId and the approval only
   * applies when the shadow read is filtered to that companyId OR
   * company-scoped approvals are merged alongside global ones (the
   * loader handles precedence).
   */
  companyId?: string;
}

interface ParsedRequest {
  canonicalLocationKey: string;
  approvedDisplayName: string;
  scope: string; // companyId or '_global'
}

function parseRequest(data: unknown): ParsedRequest {
  const req = (data ?? {}) as RawRequest;
  const canonicalLocationKey =
    typeof req.canonicalLocationKey === 'string'
      ? req.canonicalLocationKey.trim()
      : '';
  if (!canonicalLocationKey) {
    throw new HttpsError(
      'invalid-argument',
      'Missing required `canonicalLocationKey`.'
    );
  }
  // Sanity: canonical keys in the truth layer look like "loc:xxx". Be lenient
  // (accept anything non-empty without `/`) — the loader sanitizes for RTDB
  // and the builder uses the raw form as the lookup key.
  if (canonicalLocationKey.includes('/')) {
    throw new HttpsError(
      'invalid-argument',
      '`canonicalLocationKey` cannot contain `/`.'
    );
  }

  const approvedDisplayName =
    typeof req.approvedDisplayName === 'string'
      ? req.approvedDisplayName.trim()
      : '';

  const companyIdRaw =
    typeof req.companyId === 'string' ? req.companyId.trim() : '';
  const scope = companyIdRaw.length > 0 ? companyIdRaw : '_global';

  return { canonicalLocationKey, approvedDisplayName, scope };
}

/**
 * Phase 17 — persist a single admin location approval.
 *
 * Admin-gated (requireAdminRole -> admin | it). Writes a minimal
 * `LocationManualApproval` record to RTDB:
 *
 *   truth_overrides/location_approvals/{scope}/{safeKey}
 *
 * - scope   = companyId (if provided) or '_global'
 * - safeKey = canonicalKeyToRtdbSafe(canonicalLocationKey)
 *
 * Idempotent by design — re-approving overwrites with a fresh timestamp
 * and `active: true`. No delete/unapprove action in this phase.
 *
 * Source truth (canonicalLocations, aliases, preferredName) is NEVER
 * modified by this callable. It only persists a sidecar approval record
 * that the read pipeline folds in.
 */
export const approveTruthLocation = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const identity = await requireAdminRole(request);
    const { canonicalLocationKey, approvedDisplayName, scope } = parseRequest(
      request.data
    );

    const approval: LocationManualApproval = {
      canonicalLocationKey,
      approvedDisplayName,
      approvedByUid: identity.uid,
      approvedAt: new Date().toISOString(),
      companyScope: scope,
      active: true,
    };
    if (identity.email) approval.approvedByEmail = identity.email;

    const safeKey = canonicalKeyToRtdbSafe(canonicalLocationKey);
    const ref = admin
      .database()
      .ref(`truth_overrides/location_approvals/${scope}/${safeKey}`);

    // set() — idempotent overwrite. Re-approvals update approvedAt +
    // approvedBy naturally.
    await ref.set(approval);

    return {
      ok: true,
      approval,
      path: `truth_overrides/location_approvals/${scope}/${safeKey}`,
    };
  }
);
