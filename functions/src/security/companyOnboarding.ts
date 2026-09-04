import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { createHash, randomBytes } from 'crypto';
import { ServerValue } from 'firebase-admin/database';
import { authorizeAdminCall } from '../admin/authority';
import { writeSecurityAudit } from './audit';
import { requireManageDrivers } from './adminAuth';

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
  const caller = await requireManageDrivers(request.auth?.uid, request.auth?.token as Record<string, unknown> | undefined);
  const requested = String((request.data as any)?.companyId || '').trim();
  const companyId = caller.isPlatformAdmin ? requested : caller.companyId || '';
  if (!companyId) throw new httpsV2.HttpsError('invalid-argument', 'companyId required');
  let code = await joinCodeForCompany(companyId);
  if (!code) code = await allocateJoinCode(companyId, caller.uid);
  return { companyId, joinCode: code };
});
