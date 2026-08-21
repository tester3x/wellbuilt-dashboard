/**
 * Governed, source-only staff/platform claims synchronization.
 *
 * Dual-gated platform authorization. Dry-run and execute are separate.
 * Unrelated custom claims are preserved. platformAdminEnabled is set true
 * only when platform_admins/{uid} is enabled. Stale staff/platform claims
 * are cleared when canonical records are disabled.
 *
 * Token refresh / re-login is required before RTDB rule access changes.
 * This module does not execute against production.
 */
export type ClaimsSyncMode = 'dry_run' | 'execute';

export interface ClaimsSyncTarget {
  uid: string;
  expectedCompanyId?: string | null;
  expectedRole?: string | null;
}

export interface CanonicalClaimsSnapshot {
  staffEnabled?: boolean;
  staffCompanyId?: string | null;
  staffRole?: string | null;
  platformAdminEnabled?: boolean;
  existingClaims?: Record<string, unknown> | null;
}

export type ClaimsSyncDecision =
  | {
      ok: true;
      mode: ClaimsSyncMode;
      uid: string;
      nextClaims: Record<string, unknown>;
      changedKeys: string[];
      requiresTokenRefresh: true;
      wouldWrite: boolean;
    }
  | { ok: false; reason: string };

export function decideClaimsSync(input: {
  callerIsPlatform: boolean;
  mode: ClaimsSyncMode;
  target: ClaimsSyncTarget;
  snapshot: CanonicalClaimsSnapshot;
}): ClaimsSyncDecision {
  if (!input.callerIsPlatform) return { ok: false, reason: 'platform_admin_required' };
  const uid = (input.target.uid || '').trim();
  if (!uid) return { ok: false, reason: 'uid_required' };

  const staffOn = input.snapshot.staffEnabled === true;
  const staffCompany = staffOn ? (input.snapshot.staffCompanyId || '').trim() : '';
  const staffRole = staffOn ? (input.snapshot.staffRole || '').trim() : '';
  if (staffOn) {
    if (!staffCompany) return { ok: false, reason: 'staff_unscoped' };
    if (!staffRole) return { ok: false, reason: 'staff_role_missing' };
    if (input.target.expectedCompanyId && input.target.expectedCompanyId !== staffCompany) {
      return { ok: false, reason: 'target_company_mismatch' };
    }
    if (input.target.expectedRole && input.target.expectedRole !== staffRole) {
      return { ok: false, reason: 'target_role_mismatch' };
    }
  }

  const existing = { ...(input.snapshot.existingClaims || {}) };
  const next: Record<string, unknown> = { ...existing };

  if (staffOn) {
    next.staffCompanyId = staffCompany;
    next.staffRole = staffRole;
  } else {
    delete next.staffCompanyId;
    delete next.staffRole;
  }

  if (input.snapshot.platformAdminEnabled === true) {
    next.platformAdminEnabled = true;
  } else {
    next.platformAdminEnabled = false;
  }

  const changedKeys = Object.keys({ ...existing, ...next }).filter((k) => existing[k] !== next[k]);
  const extraDeleted = Object.keys(existing).filter((k) => !(k in next) && existing[k] !== undefined);
  const allChanged = [...new Set([...changedKeys, ...extraDeleted])];

  return {
    ok: true,
    mode: input.mode,
    uid,
    nextClaims: next,
    changedKeys: allChanged.sort(),
    requiresTokenRefresh: true,
    wouldWrite: input.mode === 'execute' && allChanged.length > 0,
  };
}

export function claimsSyncAuditRecord(decision: Extract<ClaimsSyncDecision, { ok: true }>): {
  action: 'adminSyncStaffClaims';
  mode: ClaimsSyncMode;
  uid: string;
  changedKeys: string[];
  requiresTokenRefresh: true;
} {
  return {
    action: 'adminSyncStaffClaims',
    mode: decision.mode,
    uid: decision.uid,
    changedKeys: decision.changedKeys,
    requiresTokenRefresh: true,
  };
}
