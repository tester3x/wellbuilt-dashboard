/**
 * Create-secure-login linkage. Exact approved row key only.
 * Never joins identities by display name, email, or visual similarity.
 */
export type CreateSecureLoginLinkDecision =
  | { action: 'reset' }
  | { action: 'create_from_approved'; approvedKey: string }
  | { action: 'create_from_legacy_hash'; legacyHash: string }
  | { action: 'refuse'; reason: string };

const APPROVED_KEY = /^[A-Za-z0-9_-]{16,}$/;

export function decideCreateSecureLoginLink(input: {
  driverId?: unknown;
  approvedKey?: unknown;
  legacyHash?: unknown;
}): CreateSecureLoginLinkDecision {
  const driverId = typeof input.driverId === 'string' ? input.driverId.trim() : '';
  if (driverId) return { action: 'reset' };

  const approvedKey = typeof input.approvedKey === 'string' ? input.approvedKey.trim() : '';
  const legacyHash = typeof input.legacyHash === 'string' ? input.legacyHash.trim() : '';

  if (approvedKey && legacyHash) {
    return { action: 'refuse', reason: 'ambiguous_link_selector' };
  }
  if (!approvedKey && !legacyHash) {
    return { action: 'refuse', reason: 'legacy_link_required' };
  }
  if (approvedKey) {
    if (!APPROVED_KEY.test(approvedKey)) {
      return { action: 'refuse', reason: 'approved_key_malformed' };
    }
    return { action: 'create_from_approved', approvedKey };
  }
  return { action: 'create_from_legacy_hash', legacyHash };
}

export function evaluateApprovedRowForCreate(input: {
  requestDisplayName: string;
  row: Record<string, unknown> | null;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.row) return { ok: false, reason: 'approved_row_missing' };
  const rowName = typeof input.row.displayName === 'string' ? input.row.displayName : '';
  if (rowName !== input.requestDisplayName) {
    return { ok: false, reason: 'approved_row_name_mismatch' };
  }
  if (typeof input.row.migratedToDriverId === 'string' && input.row.migratedToDriverId.trim()) {
    return { ok: false, reason: 'approved_row_already_linked' };
  }
  return { ok: true };
}
