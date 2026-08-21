/**
 * Platform-admin identity cleanup evaluators.
 * Callables re-read live records, then apply only what this module authorizes.
 * No wildcards, prefixes, or bulk deletes.
 */

export const EXACT_PENDING_KEY = /^-[-A-Za-z0-9_]{8,63}$/;
export const EXACT_AUTH_UID = /^[A-Za-z0-9]{20,64}$/;

export type ClassifiedReason =
  | 'pending_key_required'
  | 'uid_required'
  | 'wildcard_or_bulk_rejected'
  | 'pending_key_malformed'
  | 'uid_malformed'
  | 'confirm_required'
  | 'confirm_mismatch'
  | 'already_approved'
  | 'ambiguous_approved_identity'
  | 'ambiguous_name_index'
  | 'ambiguous_auth_linkage'
  | 'operational_records_present'
  | 'not_test_local'
  | 'provenance_incomplete';

export class IdentityCleanupError extends Error {
  constructor(public readonly reason: ClassifiedReason) {
    super(reason);
    this.name = 'IdentityCleanupError';
  }
}

function rejectWildcards(raw: string, kind: 'pending_key_malformed' | 'uid_malformed'): void {
  if (/[*?]|\/|,|\s|\.\./.test(raw) || raw.includes('%')) {
    throw new IdentityCleanupError('wildcard_or_bulk_rejected');
  }
  if (kind === 'pending_key_malformed' && !EXACT_PENDING_KEY.test(raw)) {
    throw new IdentityCleanupError('pending_key_malformed');
  }
  if (kind === 'uid_malformed' && !EXACT_AUTH_UID.test(raw)) {
    throw new IdentityCleanupError('uid_malformed');
  }
}

export function assertExactPendingKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new IdentityCleanupError('pending_key_required');
  const key = raw.trim();
  if (!key) throw new IdentityCleanupError('pending_key_required');
  rejectWildcards(key, 'pending_key_malformed');
  return key;
}

export function assertExactUid(raw: unknown): string {
  if (typeof raw !== 'string') throw new IdentityCleanupError('uid_required');
  const uid = raw.trim();
  if (!uid) throw new IdentityCleanupError('uid_required');
  rejectWildcards(uid, 'uid_malformed');
  return uid;
}

export function assertConfirm(input: { confirmKey: unknown; expected: string }): void {
  if (typeof input.confirmKey !== 'string' || !input.confirmKey.trim()) {
    throw new IdentityCleanupError('confirm_required');
  }
  if (input.confirmKey.trim() !== input.expected) {
    throw new IdentityCleanupError('confirm_mismatch');
  }
}

export type PendingCleanupAction =
  | { op: 'removePending'; path: string }
  | { op: 'removePendingSecure'; path: string }
  | { op: 'removePendingCredentials'; id: string }
  | { op: 'deleteProvisionalAuth'; uid: string };

export type RejectPendingDecision =
  | { ok: true; idempotent: true; reason: 'already_absent'; actions: [] }
  | { ok: true; idempotent: false; actions: PendingCleanupAction[]; displayName: string; source: string | null }
  | { ok: false; reason: ClassifiedReason };

export function evaluateRejectPendingRegistration(input: {
  pendingKey: string;
  pending: Record<string, unknown> | null;
  pendingSecure: Record<string, unknown> | null;
  approvedMatchCount: number;
  nameIndexExists: boolean;
  linkedAuthUids: string[];
  operationalHits: string[];
}): RejectPendingDecision {
  if (!input.pending) {
    return { ok: true, idempotent: true, reason: 'already_absent', actions: [] };
  }
  const status = typeof input.pending.status === 'string' ? input.pending.status : '';
  if (status === 'approved') return { ok: false, reason: 'already_approved' };
  if (input.approvedMatchCount > 0) return { ok: false, reason: 'ambiguous_approved_identity' };
  if (input.nameIndexExists) return { ok: false, reason: 'ambiguous_name_index' };
  if (input.linkedAuthUids.length > 1) return { ok: false, reason: 'ambiguous_auth_linkage' };
  if (input.operationalHits.length > 0) return { ok: false, reason: 'operational_records_present' };

  const actions: PendingCleanupAction[] = [
    { op: 'removePending', path: `drivers/pending/${input.pendingKey}` },
  ];
  const secureId = typeof input.pending.securePendingId === 'string' ? input.pending.securePendingId.trim() : '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secureId)) {
    actions.push({ op: 'removePendingSecure', path: `drivers/pending_secure/${secureId}` });
    actions.push({ op: 'removePendingCredentials', id: secureId });
  }
  if (input.linkedAuthUids.length === 1) {
    actions.push({ op: 'deleteProvisionalAuth', uid: input.linkedAuthUids[0] });
  }
  const displayName = typeof input.pending.displayName === 'string' ? input.pending.displayName : input.pendingKey;
  const source = typeof input.pending.source === 'string' ? input.pending.source : null;
  return { ok: true, idempotent: false, actions, displayName, source };
}

export type TestCleanupAction =
  | { op: 'removeUserProfile'; path: string }
  | { op: 'deleteAuth'; uid: string };

export type CleanupTestDecision =
  | { ok: true; idempotent: true; reason: 'already_absent'; actions: [] }
  | { ok: true; idempotent: false; actions: TestCleanupAction[]; email: string }
  | { ok: false; reason: ClassifiedReason };

export function evaluateCleanupTestIdentity(input: {
  uid: string;
  user: Record<string, unknown> | null;
  authEmail: string | null;
  operationalHits: string[];
}): CleanupTestDecision {
  if (!input.user && !input.authEmail) {
    return { ok: true, idempotent: true, reason: 'already_absent', actions: [] };
  }
  const profileEmail = typeof input.user?.email === 'string' ? input.user.email : null;
  const email = (profileEmail || input.authEmail || '').toLowerCase();
  if (!email.endsWith('@test.local')) return { ok: false, reason: 'not_test_local' };
  if (profileEmail && input.authEmail && profileEmail.toLowerCase() !== input.authEmail.toLowerCase()) {
    return { ok: false, reason: 'ambiguous_auth_linkage' };
  }
  const disposable = input.user?.disposable === true;
  const securityFlag = input.user?.disabledForSecurityTest === true;
  const note = typeof input.user?.note === 'string' ? input.user.note : '';
  const provenance = disposable || securityFlag || /security|stage-a-prod-verify/i.test(note);
  if (!provenance) return { ok: false, reason: 'provenance_incomplete' };
  if (input.operationalHits.length > 0) return { ok: false, reason: 'operational_records_present' };
  return {
    ok: true,
    idempotent: false,
    email,
    actions: [
      { op: 'removeUserProfile', path: `users/${input.uid}` },
      { op: 'deleteAuth', uid: input.uid },
    ],
  };
}
