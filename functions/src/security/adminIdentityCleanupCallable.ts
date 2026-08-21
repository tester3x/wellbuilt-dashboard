/**
 * Platform-admin pending-registration reject and test-identity cleanup.
 * NOT deployed this pass. Dry-run is the default; apply requires confirmKey.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requirePlatformAdmin } from './adminAuth';
import { writeSecurityAudit } from './audit';
import {
  IdentityCleanupError,
  assertConfirm,
  assertExactPendingKey,
  assertExactUid,
  evaluateCleanupTestIdentity,
  evaluateRejectPendingRegistration,
  type ClassifiedReason,
} from './operational/identityCleanup';

const REJECT_KEYS = new Set(['pendingKey', 'mode', 'confirmKey', 'reason']);
const CLEANUP_KEYS = new Set(['uid', 'mode', 'confirmKey', 'reason']);

function classified(reason: ClassifiedReason | string): never {
  const code = reason === 'confirm_required' || reason === 'confirm_mismatch'
    || reason.endsWith('malformed') || reason.endsWith('required') || reason === 'wildcard_or_bulk_rejected'
    ? 'invalid-argument'
    : reason === 'not_platform_admin'
      ? 'permission-denied'
      : 'failed-precondition';
  throw new httpsV2.HttpsError(code, reason);
}

function wrapEval<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof IdentityCleanupError) classified(err.reason);
    throw err;
  }
}

async function scanOperationalHits(uid: string, displayName?: string): Promise<string[]> {
  const hits: string[] = [];
  const fs = admin.firestore();
  const rtdb = admin.database();
  const name = (displayName || '').trim();

  const [dispatchBy, ticketBy, invoiceBy] = await Promise.all([
    fs.collection('dispatches').where('assignedBy', '==', uid).limit(1).get().catch(() => null),
    fs.collection('tickets').where('createdBy', '==', uid).limit(1).get().catch(() => null),
    fs.collection('invoices').where('createdBy', '==', uid).limit(1).get().catch(() => null),
  ]);
  if (dispatchBy && !dispatchBy.empty) hits.push('dispatches');
  if (ticketBy && !ticketBy.empty) hits.push('tickets');
  if (invoiceBy && !invoiceBy.empty) hits.push('invoices');

  if (name) {
    const approved = await rtdb.ref('drivers/approved').once('value');
    const rows = Object.values((approved.val() || {}) as Record<string, { displayName?: string }>);
    if (rows.some((row) => row?.displayName === name)) hits.push('drivers/approved');
  }
  return hits;
}

export const adminRejectPendingRegistration = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requirePlatformAdmin(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!REJECT_KEYS.has(key)) throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
    }
    const pendingKey = wrapEval(() => assertExactPendingKey(raw.pendingKey));
    const mode = raw.mode === 'apply' ? 'apply' : 'dry-run';
    if (mode === 'apply') wrapEval(() => assertConfirm({ confirmKey: raw.confirmKey, expected: pendingKey }));

    const rtdb = admin.database();
    const pendingSnap = await rtdb.ref(`drivers/pending/${pendingKey}`).once('value');
    const pending = pendingSnap.exists() ? pendingSnap.val() as Record<string, unknown> : null;
    const displayName = typeof pending?.displayName === 'string' ? pending.displayName : '';
    const secureId = typeof pending?.securePendingId === 'string' ? pending.securePendingId : '';
    const pendingSecureSnap = secureId
      ? await rtdb.ref(`drivers/pending_secure/${secureId}`).once('value')
      : null;
    const nameIdx = displayName
      ? await admin.firestore().collection('driver_name_index').doc(displayName.toLowerCase()).get().catch(() => null)
      : null;
    const approvedTree = await rtdb.ref('drivers/approved').once('value');
    const approvedMatchCount = displayName
      ? Object.values((approvedTree.val() || {}) as Record<string, { displayName?: string }>).filter((row) => row?.displayName === displayName).length
      : 0;
    const operationalHits = await scanOperationalHits('', displayName);

    const decided = evaluateRejectPendingRegistration({
      pendingKey,
      pending,
      pendingSecure: pendingSecureSnap?.exists() ? pendingSecureSnap.val() as Record<string, unknown> : null,
      approvedMatchCount,
      nameIndexExists: !!(nameIdx && nameIdx.exists),
      linkedAuthUids: [],
      operationalHits,
    });
    if (!decided.ok) classified(decided.reason);

    const preview = {
      ok: true as const,
      mode,
      pendingKey,
      displayName: decided.ok && !decided.idempotent ? decided.displayName : displayName || null,
      actions: decided.ok ? decided.actions : [],
      idempotent: decided.ok ? decided.idempotent : false,
    };

    if (mode !== 'apply' || preview.idempotent) {
      return preview;
    }

    const updates: Record<string, null> = {};
    for (const action of preview.actions) {
      if (action.op === 'removePending' || action.op === 'removePendingSecure') updates[action.path] = null;
    }
    if (Object.keys(updates).length) await rtdb.ref().update(updates);
    for (const action of preview.actions) {
      if (action.op === 'removePendingCredentials') {
        await admin.firestore().collection('pending_credentials').doc(action.id).delete().catch(() => undefined);
      }
    }

    await writeSecurityAudit({
      action: 'adminRejectPendingRegistration',
      actorUid: caller.uid,
      pendingId: pendingKey,
      detail: {
        reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : 'unauthorized_registration',
        displayName: preview.displayName,
        actions: preview.actions.map((a) => a.op),
      },
    });
    return preview;
  },
);

export const adminCleanupTestIdentity = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requirePlatformAdmin(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!CLEANUP_KEYS.has(key)) throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
    }
    const uid = wrapEval(() => assertExactUid(raw.uid));
    const mode = raw.mode === 'apply' ? 'apply' : 'dry-run';
    if (mode === 'apply') wrapEval(() => assertConfirm({ confirmKey: raw.confirmKey, expected: uid }));

    const userSnap = await admin.database().ref(`users/${uid}`).once('value');
    const user = userSnap.exists() ? userSnap.val() as Record<string, unknown> : null;
    let authEmail: string | null = null;
    try {
      authEmail = (await admin.auth().getUser(uid)).email || null;
    } catch {
      authEmail = null;
    }
    const operationalHits = await scanOperationalHits(uid, typeof user?.displayName === 'string' ? user.displayName : undefined);
    const decided = evaluateCleanupTestIdentity({ uid, user, authEmail, operationalHits });
    if (!decided.ok) classified(decided.reason);

    const preview = {
      ok: true as const,
      mode,
      uid,
      email: decided.ok && !decided.idempotent ? decided.email : authEmail,
      actions: decided.ok ? decided.actions : [],
      idempotent: decided.ok ? decided.idempotent : false,
      operationalHits,
    };
    if (mode !== 'apply' || preview.idempotent) return preview;

    for (const action of preview.actions) {
      if (action.op === 'removeUserProfile') {
        await admin.database().ref(action.path).remove();
      }
      if (action.op === 'deleteAuth') {
        await admin.auth().deleteUser(action.uid).catch(() => undefined);
      }
    }
    await writeSecurityAudit({
      action: 'adminCleanupTestIdentity',
      actorUid: caller.uid,
      detail: {
        targetUid: uid,
        email: preview.email,
        reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : 'security_test_identity',
        actions: preview.actions.map((a) => a.op),
      },
    });
    return preview;
  },
);
