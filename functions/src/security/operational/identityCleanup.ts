/**
 * Platform-admin identity cleanup evaluators.
 * Callables re-read live records, then apply only what this module authorizes.
 * No wildcards, prefixes, or bulk deletes.
 */

export const EXACT_PENDING_KEY = /^-[-A-Za-z0-9_]{8,63}$/;
export const EXACT_AUTH_UID = /^[A-Za-z0-9]{20,64}$/;
export const EXACT_SECURE_PENDING_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Dashboard / WB identity fields that must be scanned before deletion. */
export const OPERATIONAL_IDENTITY_SURFACES = [
  { surface: 'users', store: 'rtdb', path: 'users/{uid}' },
  { surface: 'users.driverHash', store: 'rtdb', path: 'users/{uid}/driverHash' },
  { surface: 'drivers/approved.dashboardUid', store: 'rtdb', path: 'drivers/approved/*/dashboardUid' },
  { surface: 'drivers/approved.email', store: 'rtdb', path: 'drivers/approved/*/email' },
  { surface: 'drivers/approved.displayName', store: 'rtdb', path: 'drivers/approved/*/displayName' },
  { surface: 'drivers/profiles', store: 'rtdb', path: 'drivers/profiles/{driverId}' },
  { surface: 'drivers/pending', store: 'rtdb', path: 'drivers/pending/{key}' },
  { surface: 'drivers/pending_secure', store: 'rtdb', path: 'drivers/pending_secure/{id}' },
  { surface: 'pending_credentials', store: 'firestore', path: 'pending_credentials/{id}' },
  { surface: 'driver_credentials', store: 'firestore', path: 'driver_credentials/{driverId}' },
  { surface: 'driver_name_index', store: 'firestore', path: 'driver_name_index/{displayNameNorm}' },
  { surface: 'dispatches.assignedBy', store: 'firestore', path: 'dispatches.assignedBy' },
  { surface: 'dispatches.driverHash', store: 'firestore', path: 'dispatches.driverHash' },
  { surface: 'tickets.createdBy', store: 'firestore', path: 'tickets.createdBy' },
  { surface: 'tickets.driverId', store: 'firestore', path: 'tickets.driverId' },
  { surface: 'invoices.createdBy', store: 'firestore', path: 'invoices.createdBy' },
  { surface: 'chat_threads.participants', store: 'firestore', path: 'chat_threads.participants' },
  { surface: 'chat_threads.senderId', store: 'firestore', path: 'chat_threads.lastMessage.senderId' },
  { surface: 'projects.createdBy', store: 'firestore', path: 'projects.createdBy' },
  { surface: 'payroll.driverHash', store: 'firestore', path: 'payroll' },
  { surface: 'billing_invoices', store: 'firestore', path: 'billing_invoices' },
  { surface: 'packets.driverId', store: 'rtdb', path: 'packets/processed/*/driverId' },
  { surface: 'equipment.assignments', store: 'firestore', path: 'equipment_assignments' },
  { surface: 'security_audit', store: 'firestore', path: 'security_audit', retain: true },
] as const;

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
  | 'unproven_secure_linkage'
  | 'unproven_credentials_linkage'
  | 'operational_records_present'
  | 'operational_scan_failed'
  | 'auth_lookup_failed'
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

export function normalizeDisplayName(name: string): string {
  return name.trim().toLowerCase();
}

export function collectAuthUidsFromRecords(
  records: Array<Record<string, unknown> | null | undefined>,
  extra: string[] = [],
): string[] {
  const found = new Set<string>();
  for (const rec of records) {
    if (!rec) continue;
    for (const key of ['authUid', 'firebaseUid', 'uid', 'dashboardUid']) {
      const v = rec[key];
      if (typeof v === 'string' && EXACT_AUTH_UID.test(v.trim())) found.add(v.trim());
    }
  }
  for (const u of extra) {
    if (typeof u === 'string' && EXACT_AUTH_UID.test(u.trim())) found.add(u.trim());
  }
  return [...found];
}

export function provenSecurePendingLink(input: {
  pending: Record<string, unknown>;
  pendingSecure: Record<string, unknown> | null;
  securePendingId: string;
}): boolean {
  if (!input.pendingSecure) return false;
  if (!EXACT_SECURE_PENDING_ID.test(input.securePendingId)) return false;
  const claimed = typeof input.pending.securePendingId === 'string' ? input.pending.securePendingId.trim() : '';
  if (claimed !== input.securePendingId) return false;
  const a = typeof input.pending.displayName === 'string' ? input.pending.displayName : '';
  const b = typeof input.pendingSecure.displayName === 'string' ? input.pendingSecure.displayName : '';
  return a.length > 0 && a === b;
}

export function provenPendingCredentialsLink(input: {
  pending: Record<string, unknown>;
  credentials: Record<string, unknown> | null;
  securePendingId: string;
}): boolean {
  if (!input.credentials) return false;
  if (!EXACT_SECURE_PENDING_ID.test(input.securePendingId)) return false;
  const claimed = typeof input.pending.securePendingId === 'string' ? input.pending.securePendingId.trim() : '';
  if (claimed !== input.securePendingId) return false;
  const name = typeof input.pending.displayName === 'string' ? input.pending.displayName : '';
  const norm = typeof input.credentials.displayNameNorm === 'string' ? input.credentials.displayNameNorm : '';
  return name.length > 0 && norm === normalizeDisplayName(name);
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
  pendingCredentials: Record<string, unknown> | null;
  approvedMatchCount: number;
  nameIndexExists: boolean;
  linkedAuthUids: string[];
  operationalHits: string[];
  scanOk: boolean;
  authLookupOk: boolean;
}): RejectPendingDecision {
  if (!input.scanOk) return { ok: false, reason: 'operational_scan_failed' };
  if (!input.authLookupOk) return { ok: false, reason: 'auth_lookup_failed' };
  if (!input.pending) {
    return { ok: true, idempotent: true, reason: 'already_absent', actions: [] };
  }
  const status = typeof input.pending.status === 'string' ? input.pending.status : '';
  if (status === 'approved') return { ok: false, reason: 'already_approved' };
  if (input.approvedMatchCount > 0) return { ok: false, reason: 'ambiguous_approved_identity' };
  if (input.nameIndexExists) return { ok: false, reason: 'ambiguous_name_index' };
  if (input.operationalHits.length > 0) return { ok: false, reason: 'operational_records_present' };
  if (input.linkedAuthUids.length > 1) return { ok: false, reason: 'ambiguous_auth_linkage' };

  const claimedSecure = typeof input.pending.securePendingId === 'string' ? input.pending.securePendingId.trim() : '';
  if (claimedSecure) {
    if (input.pendingSecure && !provenSecurePendingLink({
      pending: input.pending, pendingSecure: input.pendingSecure, securePendingId: claimedSecure,
    })) {
      return { ok: false, reason: 'unproven_secure_linkage' };
    }
    if (input.pendingCredentials && !provenPendingCredentialsLink({
      pending: input.pending, credentials: input.pendingCredentials, securePendingId: claimedSecure,
    })) {
      return { ok: false, reason: 'unproven_credentials_linkage' };
    }
  }

  const actions: PendingCleanupAction[] = [
    { op: 'removePending', path: `drivers/pending/${input.pendingKey}` },
  ];
  if (claimedSecure && provenSecurePendingLink({
    pending: input.pending, pendingSecure: input.pendingSecure, securePendingId: claimedSecure,
  })) {
    actions.push({ op: 'removePendingSecure', path: `drivers/pending_secure/${claimedSecure}` });
  }
  if (claimedSecure && provenPendingCredentialsLink({
    pending: input.pending, credentials: input.pendingCredentials, securePendingId: claimedSecure,
  })) {
    actions.push({ op: 'removePendingCredentials', id: claimedSecure });
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
  authLookupOk: boolean;
  operationalHits: string[];
  scanOk: boolean;
}): CleanupTestDecision {
  if (!input.scanOk) return { ok: false, reason: 'operational_scan_failed' };
  if (!input.authLookupOk) return { ok: false, reason: 'auth_lookup_failed' };
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
  const actions: TestCleanupAction[] = [];
  if (input.user) actions.push({ op: 'removeUserProfile', path: `users/${input.uid}` });
  if (input.authEmail) actions.push({ op: 'deleteAuth', uid: input.uid });
  if (actions.length === 0) {
    return { ok: true, idempotent: true, reason: 'already_absent', actions: [] };
  }
  return { ok: true, idempotent: false, email, actions };
}

export type ActionResultStatus = 'applied' | 'already_absent' | 'failed';

export type ActionResult = {
  op: string;
  target: string;
  status: ActionResultStatus;
  error?: string;
};

export function summarizeActionResults(results: ActionResult[]): {
  ok: boolean;
  complete: boolean;
  retryable: boolean;
  applied: number;
  alreadyAbsent: number;
  failed: number;
} {
  const applied = results.filter((r) => r.status === 'applied').length;
  const alreadyAbsent = results.filter((r) => r.status === 'already_absent').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const complete = failed === 0;
  return {
    ok: complete,
    complete,
    retryable: failed > 0,
    applied,
    alreadyAbsent,
    failed,
  };
}

export function isNotFoundError(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
  const msg = err instanceof Error ? err.message : String(err);
  return /not-found|NOT_FOUND|no user record|404/i.test(`${code} ${msg}`);
}
