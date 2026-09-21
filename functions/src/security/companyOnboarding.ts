import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { createHash, randomBytes } from 'crypto';
import { ServerValue } from 'firebase-admin/database';
import { authorizeAdminCall } from '../admin/authority';
import { writeSecurityAudit } from './audit';
import {
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
} from './trustedStaffAuthority';
import { staffWriteDispatchAccessFromTrusted } from './operational/staffWriteDispatch';

const COMPANY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeCompanyJoinCode(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

export function companyJoinCodeDigest(value: unknown): string {
  return createHash('sha256').update(normalizeCompanyJoinCode(value)).digest('hex');
}

export function decideCompanyJoinCodeResolution(input: {
  matchExists: boolean;
  mapping?: Record<string, unknown>;
  companyExists: boolean;
  company?: Record<string, unknown>;
}): { ok: true; companyId: string; companyName: string } | { ok: false; reason: 'unknown' | 'unavailable' } {
  const companyId = input.mapping?.companyId;
  if (!input.matchExists || input.mapping?.active !== true || typeof companyId !== 'string') {
    return { ok: false, reason: 'unknown' };
  }
  const companyName = input.company?.name;
  if (!input.companyExists || input.company?.status === 'archived' || typeof companyName !== 'string') {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, companyId, companyName };
}

export function slugifyCompanyName(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function newJoinCode(): string {
  const bytes = randomBytes(8);
  let raw = '';
  for (let i = 0; i < 8; i += 1) raw += COMPANY_CODE_ALPHABET[bytes[i] % COMPANY_CODE_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

async function requireTrustedTenantCompany(authUid: string | undefined) {
  const trusted = await requireTrustedCompanyCapability(authUid, TRUSTED_CAPABILITY_MANAGE_DRIVERS);
  const access = staffWriteDispatchAccessFromTrusted(trusted);
  if (!access.ok) {
    throw new httpsV2.HttpsError(
      access.reason === 'unauthenticated' ? 'unauthenticated' : 'permission-denied',
      access.reason,
    );
  }
  return access;
}

const PLATFORM_ONBOARDING_CAPABILITY_UNDEFINED = 'platform_onboarding_capability_undefined';

async function requireVerifiedPlatformAdmin(request: httpsV2.CallableRequest<unknown>) {
  const uid = request.auth?.uid;
  const record = uid
    ? (await admin.firestore().collection('platform_admins').doc(uid).get()).data()
    : null;
  const decision = authorizeAdminCall(
    request.auth ? { uid, token: request.auth.token as unknown as Record<string, unknown> } : null,
    record || null,
  );
  if (!decision.ok) {
    throw new httpsV2.HttpsError(
      decision.reason === 'unauthenticated' ? 'unauthenticated' : 'permission-denied',
      `platform_admin_required:${decision.reason}`,
    );
  }
  return decision;
}

async function allocateJoinCode(companyId: string, actorUid: string): Promise<string> {
  const db = admin.firestore();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = newJoinCode();
    const digest = companyJoinCodeDigest(code);
    try {
      await db.runTransaction(async tx => {
        const ref = db.collection('company_join_codes').doc(digest);
        const existing = await tx.get(ref);
        if (existing.exists) throw new Error('join_code_collision');
        tx.create(ref, {
          companyId,
          code,
          active: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdBy: actorUid,
        });
        tx.set(db.collection('company_join_codes_by_company').doc(companyId), {
          digest,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      return code;
    } catch (error) {
      if ((error as Error).message !== 'join_code_collision') throw error;
    }
  }
  throw new httpsV2.HttpsError('internal', 'Could not allocate a unique company join code');
}

async function joinCodeForCompany(companyId: string): Promise<string | null> {
  const db = admin.firestore();
  const pointer = await db.collection('company_join_codes_by_company').doc(companyId).get();
  const digest = pointer.data()?.digest;
  if (typeof digest !== 'string') return null;
  const code = await db.collection('company_join_codes').doc(digest).get();
  const data = code.data();
  return data?.active === true && typeof data.code === 'string' ? data.code : null;
}

export async function resolveCompanyJoinCode(code: unknown): Promise<{ companyId: string; companyName: string }> {
  const normalized = normalizeCompanyJoinCode(code);
  if (normalized.length !== 8) {
    throw new httpsV2.HttpsError('invalid-argument', 'Enter the 8-character company join code');
  }
  const match = await admin.firestore().collection('company_join_codes').doc(companyJoinCodeDigest(normalized)).get();
  const data = match.data();
  if (!match.exists || data?.active !== true || typeof data.companyId !== 'string') {
    throw new httpsV2.HttpsError('not-found', 'Company join code was not found');
  }
  const company = await admin.firestore().collection('companies').doc(data.companyId).get();
  const decision = decideCompanyJoinCodeResolution({
    matchExists: match.exists,
    mapping: data,
    companyExists: company.exists,
    company: company.data(),
  });
  if (!decision.ok) {
    throw new httpsV2.HttpsError('failed-precondition', 'Company is not available for employee registration');
  }
  return { companyId: decision.companyId, companyName: decision.companyName };
}

export const requestCompanyOnboarding = httpsV2.onCall(
  { timeoutSeconds: 20, memory: '256MiB', enforceAppCheck: false },
  async request => {
    if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'Sign in is required');
    const companyName = String((request.data as any)?.companyName || '').trim();
    if (companyName.length < 2 || companyName.length > 120) {
      throw new httpsV2.HttpsError('invalid-argument', 'Company name must be 2–120 characters');
    }
    const userRef = admin.database().ref(`users/${request.auth.uid}`);
    const current = (await userRef.once('value')).val() || {};
    if (current.companyId || current.status === 'active') {
      throw new httpsV2.HttpsError('failed-precondition', 'This account is already assigned to a company');
    }
    await userRef.update({
      status: 'pending',
      requestedCompanyName: companyName,
      requestedAt: ServerValue.TIMESTAMP,
      role: 'viewer',
      companyId: null,
      onboardingStatus: 'pending_company_assignment',
      email: request.auth.token.email || current.email || null,
      displayName: request.auth.token.email || current.displayName || null,
    });
    await writeSecurityAudit({ action: 'requestCompanyOnboarding', actorUid: request.auth.uid, detail: { companyName } });
    return { ok: true, status: 'pending' as const };
  },
);

export const adminListCompanyOnboardingRequests = httpsV2.onCall(async request => {
  throw new httpsV2.HttpsError('failed-precondition', PLATFORM_ONBOARDING_CAPABILITY_UNDEFINED);
  await requireVerifiedPlatformAdmin(request);
  const snap = await admin.database().ref('users').once('value');
  const requests: Record<string, unknown>[] = [];
  for (const [uid, raw] of Object.entries(snap.val() || {})) {
    const row = raw as Record<string, unknown>;
    if (row.status !== 'pending' && row.onboardingStatus !== 'pending_company_assignment') continue;
    requests.push({
      uid,
      email: typeof row.email === 'string' ? row.email : null,
      requestedCompanyName: typeof row.requestedCompanyName === 'string' ? row.requestedCompanyName : null,
      requestedAt: typeof row.requestedAt === 'number' ? row.requestedAt : null,
    });
  }
  return { requests };
});

async function uniqueCompanyId(baseName: string): Promise<string> {
  const base = slugifyCompanyName(baseName) || 'company';
  for (let n = 1; n < 1000; n += 1) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!(await admin.firestore().collection('companies').doc(id).get()).exists) return id;
  }
  throw new httpsV2.HttpsError('resource-exhausted', 'Could not allocate company ID');
}

export const adminApproveCompanyOnboarding = httpsV2.onCall(async request => {
  throw new httpsV2.HttpsError('failed-precondition', PLATFORM_ONBOARDING_CAPABILITY_UNDEFINED);
  const actor = await requireVerifiedPlatformAdmin(request);
  const uid = String((request.data as any)?.uid || '').trim();
  if (!uid) throw new httpsV2.HttpsError('invalid-argument', 'uid required');
  const userRef = admin.database().ref(`users/${uid}`);
  const userSnap = await userRef.once('value');
  if (!userSnap.exists()) throw new httpsV2.HttpsError('not-found', 'Company request not found');
  const user = userSnap.val();
  if (user.companyId && user.status === 'active') {
    const existingCode = await joinCodeForCompany(user.companyId);
    return { ok: true, companyId: user.companyId, companyName: user.companyName || null, joinCode: existingCode, alreadyApproved: true };
  }
  if (user.status !== 'pending' && user.onboardingStatus !== 'pending_company_assignment') {
    throw new httpsV2.HttpsError('failed-precondition', 'Account is not awaiting company approval');
  }
  const companyName = String((request.data as any)?.companyName || user.requestedCompanyName || '').trim();
  if (companyName.length < 2 || companyName.length > 120) throw new httpsV2.HttpsError('invalid-argument', 'Valid companyName required');
  const db = admin.firestore();
  const approvalRef = db.collection('company_onboarding_approvals').doc(uid);
  const priorApproval = await approvalRef.get();
  const companyId = typeof priorApproval.data()?.companyId === 'string'
    ? priorApproval.data()!.companyId
    : await uniqueCompanyId(companyName);
  if (!priorApproval.exists) {
    await approvalRef.create({
      companyId,
      companyName,
      requesterUid: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: actor.actorUid,
    });
  }
  await db.collection('companies').doc(companyId).set({
    name: companyName,
    status: 'active',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: actor.actorUid,
  }, { merge: true });
  const joinCode = await allocateJoinCode(companyId, actor.actorUid);
  await userRef.update({
    companyId,
    companyName,
    role: 'it',
    roles: ['it'],
    status: 'active',
    onboardingStatus: 'active',
    approvedAt: ServerValue.TIMESTAMP,
    approvedBy: actor.actorUid,
  });
  await writeSecurityAudit({ action: 'adminApproveCompanyOnboarding', actorUid: actor.actorUid, detail: { uid, companyId } });
  return { ok: true, companyId, companyName, joinCode };
});

export const adminCreateCompanyWithJoinCode = httpsV2.onCall(async request => {
  throw new httpsV2.HttpsError('failed-precondition', PLATFORM_ONBOARDING_CAPABILITY_UNDEFINED);
  const actor = await requireVerifiedPlatformAdmin(request);
  const companyName = String((request.data as any)?.companyName || '').trim();
  const requestedId = slugifyCompanyName((request.data as any)?.companyId);
  if (companyName.length < 2 || companyName.length > 120) throw new httpsV2.HttpsError('invalid-argument', 'Valid companyName required');
  const companyId = requestedId || await uniqueCompanyId(companyName);
  const companyRef = admin.firestore().collection('companies').doc(companyId);
  if ((await companyRef.get()).exists) throw new httpsV2.HttpsError('already-exists', 'Company ID already exists');
  const supplied = (request.data as any)?.fields;
  const inputFields = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? supplied : {};
  const allowedFields = [
    'address', 'city', 'state', 'zip', 'invoicePrefix', 'invoiceBook',
    'transferRequiresApproval', 'wellMonitoring', 'ticketPrefix', 'phone', 'notes',
  ];
  const fields = Object.fromEntries(Object.entries(inputFields).filter(([key]) => allowedFields.includes(key)));
  await companyRef.create({ ...fields, name: companyName, status: 'active', createdAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: actor.actorUid });
  const joinCode = await allocateJoinCode(companyId, actor.actorUid);
  await writeSecurityAudit({ action: 'adminCreateCompanyWithJoinCode', actorUid: actor.actorUid, detail: { companyId } });
  return { ok: true, companyId, companyName, joinCode };
});

export const getCompanyJoinCode = httpsV2.onCall(async request => {
  const access = await requireTrustedTenantCompany(request.auth?.uid);
  const requested = String((request.data as any)?.companyId || '').trim();
  if (requested && requested !== access.companyId) {
    throw new httpsV2.HttpsError('permission-denied', 'cross_company');
  }
  const companyId = access.companyId;
  let code = await joinCodeForCompany(companyId);
  if (!code) code = await allocateJoinCode(companyId, access.uid);
  return { companyId, joinCode: code };
});

export interface JoinCodeStoreOps {
  getPointer(companyId: string): Promise<{ digest?: string } | null>;
  getJoinCode(digest: string): Promise<{ exists: boolean; active?: boolean; companyId?: string; code?: string } | null>;
  runTransaction<T>(fn: (tx: JoinCodeTransactionOps) => Promise<T>): Promise<T>;
  generateCode?: () => string;
}

export interface JoinCodeTransactionOps {
  getPointer(companyId: string): Promise<{ digest?: string } | null>;
  getJoinCode(digest: string): Promise<{ exists: boolean; active?: boolean; companyId?: string; code?: string } | null>;
  deactivateCode(digest: string, actorUid: string): void;
  createCode(digest: string, code: string, companyId: string, actorUid: string): void;
  setPointer(companyId: string, digest: string, actorUid: string): void;
  writeAudit(audit: { action: string; actorUid: string; detail: Record<string, unknown> }): void;
}

export function decideGetCompanyJoinCodeAccess(params: {
  authUid?: string | null;
  tenantCaller?: { companyId?: string | null; caps: string[] } | null;
  platformAdminDecision?: { ok: boolean; reason?: string } | null;
  requestedCompanyId?: string;
}): { ok: boolean; companyId?: string; error?: string; status?: string } {
  if (!params.authUid) {
    return { ok: false, error: 'Must be signed in', status: 'unauthenticated' };
  }
  const requested = String(params.requestedCompanyId || '').trim();

  // Tenant manageDrivers callers may act ONLY on their own company
  if (params.tenantCaller?.caps?.includes('manageDrivers') && params.tenantCaller.companyId) {
    if (!requested || requested === params.tenantCaller.companyId) {
      return { ok: true, companyId: params.tenantCaller.companyId };
    }
  }

  // Platform-targeted path requires requireVerifiedPlatformAdmin and verified platform_admins membership.
  // Never authorize cross-company actions from an unscoped admin or it role string.
  if (!params.platformAdminDecision?.ok) {
    const reason = params.platformAdminDecision?.reason || 'permission-denied';
    return {
      ok: false,
      error: `platform_admin_required:${reason}`,
      status: reason === 'unauthenticated' ? 'unauthenticated' : 'permission-denied',
    };
  }

  if (!requested) {
    return { ok: false, error: 'companyId required for platform admin join code access', status: 'invalid-argument' };
  }

  return { ok: true, companyId: requested };
}

export function decideGetCompanyJoinCodeTenantAccess(
  caller: { uid: string; companyId?: string | null; isPlatformAdmin: boolean; caps?: string[] },
  requestedCompanyId?: string,
  platformAdminDecision?: { ok: boolean; reason?: string } | null,
): { ok: boolean; companyId?: string; error?: string; status?: string } {
  return decideGetCompanyJoinCodeAccess({
    authUid: caller.uid,
    tenantCaller: { companyId: caller.companyId, caps: caller.caps || [] },
    platformAdminDecision: platformAdminDecision ?? (caller.isPlatformAdmin ? { ok: true } : { ok: false, reason: 'missing_admin_record' }),
    requestedCompanyId,
  });
}

export function decideRotateCompanyJoinCodeAccess(params: {
  authUid?: string | null;
  tenantCaller?: { companyId?: string | null; caps: string[] } | null;
  platformAdminDecision?: { ok: boolean; reason?: string } | null;
  requestedCompanyId?: string;
}): { ok: boolean; companyId?: string; error?: string; status?: string } {
  if (!params.authUid) {
    return { ok: false, error: 'Must be signed in', status: 'unauthenticated' };
  }
  const requested = String(params.requestedCompanyId || '').trim();

  // Tenant manageDrivers callers may act ONLY on their own company
  if (params.tenantCaller?.caps?.includes('manageDrivers') && params.tenantCaller.companyId) {
    if (!requested || requested === params.tenantCaller.companyId) {
      return { ok: true, companyId: params.tenantCaller.companyId };
    }
  }

  // Cross-company replacement requires requireVerifiedPlatformAdmin and verified platform_admins membership.
  // Never authorize cross-company actions from an unscoped admin or it role string.
  if (!params.platformAdminDecision?.ok) {
    const reason = params.platformAdminDecision?.reason || 'permission-denied';
    return {
      ok: false,
      error: `platform_admin_required:${reason}`,
      status: reason === 'unauthenticated' ? 'unauthenticated' : 'permission-denied',
    };
  }

  if (!requested) {
    return { ok: false, error: 'companyId required for platform admin rotation', status: 'invalid-argument' };
  }

  return { ok: true, companyId: requested };
}

export function decideRotateCompanyJoinCodeTenantAccess(
  caller: { uid: string; companyId?: string | null; isPlatformAdmin: boolean; caps?: string[] },
  requestedCompanyId?: string,
  platformAdminDecision?: { ok: boolean; reason?: string } | null,
): { ok: boolean; companyId?: string; error?: string; status?: string } {
  return decideRotateCompanyJoinCodeAccess({
    authUid: caller.uid,
    tenantCaller: { companyId: caller.companyId, caps: caller.caps || [] },
    platformAdminDecision: platformAdminDecision ?? (caller.isPlatformAdmin ? { ok: true } : { ok: false, reason: 'missing_admin_record' }),
    requestedCompanyId,
  });
}

export async function executeRotateJoinCode(
  companyId: string,
  actorUid: string,
  store: JoinCodeStoreOps,
  expectedDigest?: string | null,
): Promise<string> {
  const codeGen = store.generateCode || newJoinCode;
  const initialPointer = await store.getPointer(companyId);
  const targetExpected = expectedDigest !== undefined ? expectedDigest : (initialPointer?.digest ?? null);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const newCode = codeGen();
    const newDigest = companyJoinCodeDigest(newCode);
    try {
      await store.runTransaction(async tx => {
        const pointer = await tx.getPointer(companyId);
        const oldDigest = pointer?.digest ?? null;

        // Concurrent replacement semantics: exactly ONE same-generation replacement succeeds
        if (oldDigest !== targetExpected) {
          throw new httpsV2.HttpsError(
            'aborted',
            'concurrent_join_code_replacement_conflict: Code was already replaced by another request',
          );
        }

        const newExisting = await tx.getJoinCode(newDigest);
        if (newExisting?.exists) throw new Error('join_code_collision');

        let oldExists = false;
        if (typeof oldDigest === 'string') {
          const oldRecord = await tx.getJoinCode(oldDigest);
          oldExists = !!oldRecord?.exists;
        }

        // Writes after all transaction reads
        if (oldDigest && oldExists) {
          tx.deactivateCode(oldDigest, actorUid);
        }
        tx.createCode(newDigest, newCode, companyId, actorUid);
        tx.setPointer(companyId, newDigest, actorUid);

        // Security audit written atomically INSIDE the same transaction
        // Audit records MUST NEVER contain plaintext codes
        tx.writeAudit({
          action: 'rotateCompanyJoinCode',
          actorUid,
          detail: { companyId },
        });
      });

      return newCode;
    } catch (error) {
      if ((error as Error).message === 'join_code_collision') continue;
      throw error;
    }
  }
  throw new httpsV2.HttpsError('internal', 'Could not allocate a unique company join code during rotation');
}

export async function rotateJoinCode(
  companyId: string,
  actorUid: string,
  storeOps?: JoinCodeStoreOps,
  expectedDigest?: string | null,
): Promise<string> {
  if (storeOps) {
    return executeRotateJoinCode(companyId, actorUid, storeOps, expectedDigest);
  }
  const db = admin.firestore();
  const initialPointer = await db.collection('company_join_codes_by_company').doc(companyId).get();
  const targetExpected = expectedDigest !== undefined ? expectedDigest : (initialPointer.data()?.digest ?? null);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const newCode = newJoinCode();
    const newDigest = companyJoinCodeDigest(newCode);
    try {
      await db.runTransaction(async tx => {
        const pointerRef = db.collection('company_join_codes_by_company').doc(companyId);
        const pointerSnap = await tx.get(pointerRef);
        const oldDigest = pointerSnap.data()?.digest ?? null;

        // Concurrent replacement semantics: exactly ONE same-generation replacement succeeds
        if (oldDigest !== targetExpected) {
          throw new httpsV2.HttpsError(
            'aborted',
            'concurrent_join_code_replacement_conflict: Code was already replaced by another request',
          );
        }

        const newRef = db.collection('company_join_codes').doc(newDigest);
        const newExisting = await tx.get(newRef);
        if (newExisting.exists) throw new Error('join_code_collision');

        let oldRef: admin.firestore.DocumentReference | null = null;
        let oldExists = false;
        if (typeof oldDigest === 'string') {
          oldRef = db.collection('company_join_codes').doc(oldDigest);
          const oldSnap = await tx.get(oldRef);
          oldExists = oldSnap.exists;
        }

        // Writes after all transaction reads
        if (oldRef && oldExists) {
          tx.update(oldRef, {
            active: false,
            revokedAt: admin.firestore.FieldValue.serverTimestamp(),
            revokedBy: actorUid,
          });
        }
        tx.create(newRef, {
          companyId,
          code: newCode,
          active: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdBy: actorUid,
        });
        tx.set(pointerRef, {
          digest: newDigest,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: actorUid,
        }, { merge: true });

        // Security audit written atomically INSIDE the same transaction
        // Audit records MUST NEVER contain plaintext codes
        const auditRef = db.collection('security_audit').doc();
        tx.set(auditRef, {
          action: 'rotateCompanyJoinCode',
          actorUid,
          detail: { companyId },
          ts: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      return newCode;
    } catch (error) {
      if ((error as Error).message === 'join_code_collision') continue;
      throw error;
    }
  }
  throw new httpsV2.HttpsError('internal', 'Could not allocate a unique company join code during rotation');
}

export const rotateCompanyJoinCode = httpsV2.onCall(async request => {
  const access = await requireTrustedTenantCompany(request.auth?.uid);
  const requested = String((request.data as any)?.companyId || '').trim();
  const suppliedExpected = (request.data as any)?.expectedDigest;
  const expectedDigest = typeof suppliedExpected === 'string' ? suppliedExpected : undefined;
  if (requested && requested !== access.companyId) {
    throw new httpsV2.HttpsError('permission-denied', 'cross_company');
  }
  const code = await rotateJoinCode(access.companyId, access.uid, undefined, expectedDigest);
  return { companyId: access.companyId, joinCode: code };
});
