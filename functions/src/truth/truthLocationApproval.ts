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
    // approvedBy naturally. Any previous revoke audit fields are cleared
    // (intentional: re-approving is a fresh decision, not a resurrection).
    await ref.set(approval);

    return {
      ok: true,
      approval,
      path: `truth_overrides/location_approvals/${scope}/${safeKey}`,
    };
  }
);

// ─────────────────────────────────────────────────────────────────────────
// Phase 19 — revoke path
// ─────────────────────────────────────────────────────────────────────────

interface RawRevokeRequest {
  canonicalLocationKey?: string;
  companyId?: string;
}

interface ParsedRevokeRequest {
  canonicalLocationKey: string;
  scope: string; // companyId or '_global'
}

function parseRevokeRequest(data: unknown): ParsedRevokeRequest {
  const req = (data ?? {}) as RawRevokeRequest;
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
  if (canonicalLocationKey.includes('/')) {
    throw new HttpsError(
      'invalid-argument',
      '`canonicalLocationKey` cannot contain `/`.'
    );
  }
  const companyIdRaw =
    typeof req.companyId === 'string' ? req.companyId.trim() : '';
  const scope = companyIdRaw.length > 0 ? companyIdRaw : '_global';
  return { canonicalLocationKey, scope };
}

/**
 * Phase 19 — revoke a persisted admin location approval.
 *
 * Admin-gated (requireAdminRole -> admin | it). Soft-delete by design:
 * the existing record at `truth_overrides/location_approvals/{scope}/
 * {safeKey}` is mutated with `active: false` plus audit fields
 * (revokedAt / revokedByUid / revokedByEmail), NOT removed. This
 * preserves an auditable history of who approved what and when it
 * was revoked.
 *
 * Idempotent:
 *   - missing record   -> returns { ok: true, alreadyInactive: true,
 *                                   note: 'no approval found' }
 *   - already inactive -> returns { ok: true, alreadyInactive: true }
 *                         (refreshes revokedAt/revokedBy for audit)
 *   - active record    -> flips active to false, stamps revoke fields
 *
 * After revoke:
 *   - getLocationHealthView reads see active: false → diagnostic builder
 *     no longer overrides reviewDisposition
 *   - if the location has official SWD backing (Phase 18) or catalog
 *     backing (Phase 11), it still resolves automatically
 *   - if nothing else backs it, it falls back to fallback-only (original
 *     Phase 11 default)
 *
 * Source truth is never modified — canonicalLocations / preferredName /
 * aliases stay exactly as they were before the original approval.
 */
export const revokeTruthLocationApproval = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const identity = await requireAdminRole(request);
    const { canonicalLocationKey, scope } = parseRevokeRequest(request.data);

    const safeKey = canonicalKeyToRtdbSafe(canonicalLocationKey);
    const path = `truth_overrides/location_approvals/${scope}/${safeKey}`;
    const ref = admin.database().ref(path);

    const snap = await ref.once('value');
    if (!snap.exists()) {
      // Nothing to revoke. Return success so the client can treat this
      // as idempotent — e.g. if the user double-clicked or re-ran after
      // an earlier cleanup.
      return {
        ok: true,
        alreadyInactive: true,
        path,
        note: 'no approval found',
      };
    }

    const revokedAt = new Date().toISOString();
    const revokePatch: {
      active: false;
      revokedAt: string;
      revokedByUid: string;
      revokedByEmail?: string;
    } = {
      active: false,
      revokedAt,
      revokedByUid: identity.uid,
    };
    if (identity.email) revokePatch.revokedByEmail = identity.email;

    // Partial update preserves original approvedBy / approvedAt /
    // approvedDisplayName / canonicalLocationKey / companyScope.
    await ref.update(revokePatch);

    const afterSnap = await ref.once('value');
    return {
      ok: true,
      alreadyInactive: snap.val()?.active === false,
      approval: afterSnap.val(),
      path,
    };
  }
);
