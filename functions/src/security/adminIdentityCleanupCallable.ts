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
  collectAuthUidsFromRecords,
  evaluateCleanupTestIdentity,
  evaluateRejectPendingRegistration,
  isNotFoundError,
  summarizeActionResults,
  type ActionResult,
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

type ScanOutcome = { ok: true; hits: string[] } | { ok: false; failedSurfaces: string[] };

async function fsHit(
  surface: string,
  run: () => Promise<FirebaseFirestore.QuerySnapshot>,
): Promise<{ surface: string; hit: boolean } | { surface: string; failed: true }> {
  try {
    const snap = await run();
    return { surface, hit: !snap.empty };
  } catch {
    return { surface, failed: true };
  }
}

async function scanOperationalHits(input: {
  uid?: string;
  displayName?: string;
  driverHash?: string;
}): Promise<ScanOutcome> {
  const fs = admin.firestore();
  const rtdb = admin.database();
  const hits: string[] = [];
  const failedSurfaces: string[] = [];
  const uid = (input.uid || '').trim();
  const name = (input.displayName || '').trim();
  const hash = (input.driverHash || '').trim();

  const queries: Array<Promise<{ surface: string; hit?: boolean; failed?: true }>> = [];
  if (uid) {
    queries.push(fsHit('dispatches.assignedBy', () => fs.collection('dispatches').where('assignedBy', '==', uid).limit(1).get()));
    queries.push(fsHit('tickets.createdBy', () => fs.collection('tickets').where('createdBy', '==', uid).limit(1).get()));
    queries.push(fsHit('invoices.createdBy', () => fs.collection('invoices').where('createdBy', '==', uid).limit(1).get()));
    queries.push(fsHit('projects.createdBy', () => fs.collection('projects').where('createdBy', '==', uid).limit(1).get()));
    queries.push(fsHit('chat_threads.participants', () => fs.collection('chat_threads').where('participants', 'array-contains', uid).limit(1).get()));
    queries.push(fsHit('billing_invoices', () => fs.collection('billing_invoices').where('createdBy', '==', uid).limit(1).get()));
  }
  if (hash) {
    queries.push(fsHit('dispatches.driverHash', () => fs.collection('dispatches').where('driverHash', '==', hash).limit(1).get()));
    queries.push(fsHit('tickets.driverId', () => fs.collection('tickets').where('driverId', '==', hash).limit(1).get()));
  }

  try {
    const approved = await rtdb.ref('drivers/approved').once('value');
    const rows = Object.values((approved.val() || {}) as Record<string, {
      displayName?: string; dashboardUid?: string; email?: string;
    }>);
    if (name && rows.some((row) => row?.displayName === name)) hits.push('drivers/approved.displayName');
    if (uid && rows.some((row) => row?.dashboardUid === uid)) hits.push('drivers/approved.dashboardUid');
  } catch {
    failedSurfaces.push('drivers/approved');
  }

  if (name) {
    try {
      const idx = await fs.collection('driver_name_index').doc(name.toLowerCase()).get();
      if (idx.exists) hits.push('driver_name_index');
    } catch {
      failedSurfaces.push('driver_name_index');
    }
  }

  const qResults = await Promise.all(queries);
  for (const r of qResults) {
    if ('failed' in r && r.failed) failedSurfaces.push(r.surface);
    else if (r.hit) hits.push(r.surface);
  }

  if (failedSurfaces.length > 0) return { ok: false, failedSurfaces };
  return { ok: true, hits };
}

async function recordAction(
  op: string,
  target: string,
  run: () => Promise<void>,
): Promise<ActionResult> {
  try {
    await run();
    return { op, target, status: 'applied' };
  } catch (err) {
    if (isNotFoundError(err)) return { op, target, status: 'already_absent' };
    return { op, target, status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
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
    const fs = admin.firestore();
    const pendingSnap = await rtdb.ref(`drivers/pending/${pendingKey}`).once('value');
    const pending = pendingSnap.exists() ? pendingSnap.val() as Record<string, unknown> : null;
    const displayName = typeof pending?.displayName === 'string' ? pending.displayName : '';
    const secureId = typeof pending?.securePendingId === 'string' ? pending.securePendingId.trim() : '';

    const pendingSecureSnap = secureId
      ? await rtdb.ref(`drivers/pending_secure/${secureId}`).once('value')
      : null;
    const pendingSecure = pendingSecureSnap?.exists() ? pendingSecureSnap.val() as Record<string, unknown> : null;
    let pendingCredentials: Record<string, unknown> | null = null;
    if (secureId) {
      const credSnap = await fs.collection('pending_credentials').doc(secureId).get();
      pendingCredentials = credSnap.exists ? (credSnap.data() as Record<string, unknown>) : null;
    }

    const nameIdx = displayName
      ? await fs.collection('driver_name_index').doc(displayName.toLowerCase()).get()
      : null;
    const approvedTree = await rtdb.ref('drivers/approved').once('value');
    const approvedMatchCount = displayName
      ? Object.values((approvedTree.val() || {}) as Record<string, { displayName?: string }>).filter((row) => row?.displayName === displayName).length
      : 0;

    let authLookupOk = true;
    const lookedUpAuth: string[] = [];
    if (secureId) {
      try {
        const maybeEmail = typeof pendingSecure?.email === 'string' ? pendingSecure.email : null;
        if (maybeEmail) {
          const rec = await admin.auth().getUserByEmail(maybeEmail);
          if (rec?.uid) lookedUpAuth.push(rec.uid);
        }
      } catch (err) {
        if (!isNotFoundError(err)) authLookupOk = false;
      }
    }
    const linkedAuthUids = collectAuthUidsFromRecords([pending, pendingSecure, pendingCredentials], lookedUpAuth);
    const scan = await scanOperationalHits({ displayName });

    const decided = evaluateRejectPendingRegistration({
      pendingKey,
      pending,
      pendingSecure,
      pendingCredentials,
      approvedMatchCount,
      nameIndexExists: !!(nameIdx && nameIdx.exists),
      linkedAuthUids,
      operationalHits: scan.ok ? scan.hits : [],
      scanOk: scan.ok,
      authLookupOk,
    });
    if (!decided.ok) classified(decided.reason);

    const preview = {
      ok: true as const,
      mode,
      pendingKey,
      displayName: decided.ok && !decided.idempotent ? decided.displayName : displayName || null,
      actions: decided.ok ? decided.actions : [],
      idempotent: decided.ok ? decided.idempotent : false,
      linkedAuthUids,
    };

    if (mode !== 'apply' || preview.idempotent) {
      return preview;
    }

    const results: ActionResult[] = [];
    for (const action of preview.actions) {
      if (action.op === 'removePending' || action.op === 'removePendingSecure') {
        results.push(await recordAction(action.op, action.path, async () => {
          const snap = await rtdb.ref(action.path).once('value');
          if (!snap.exists()) {
            const err = Object.assign(new Error('not-found'), { code: 'not-found' });
            throw err;
          }
          await rtdb.ref(action.path).remove();
        }));
      }
      if (action.op === 'removePendingCredentials') {
        results.push(await recordAction(action.op, action.id, async () => {
          const snap = await fs.collection('pending_credentials').doc(action.id).get();
          if (!snap.exists) {
            const err = Object.assign(new Error('not-found'), { code: 'not-found' });
            throw err;
          }
          await fs.collection('pending_credentials').doc(action.id).delete();
        }));
      }
      if (action.op === 'deleteProvisionalAuth') {
        results.push(await recordAction(action.op, action.uid, async () => {
          await admin.auth().deleteUser(action.uid);
        }));
      }
    }
    const summary = summarizeActionResults(results);
    await writeSecurityAudit({
      action: 'adminRejectPendingRegistration',
      actorUid: caller.uid,
      pendingId: pendingKey,
      detail: {
        reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : 'unauthorized_registration',
        displayName: preview.displayName,
        results,
        summary,
      },
    });
    if (!summary.ok) {
      throw new httpsV2.HttpsError('internal', 'partial_cleanup_failed');
    }
    return { ...preview, results, summary };
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
    let authLookupOk = true;
    try {
      authEmail = (await admin.auth().getUser(uid)).email || null;
    } catch (err) {
      if (!isNotFoundError(err)) authLookupOk = false;
    }
    const driverHash = typeof user?.driverHash === 'string' ? user.driverHash : '';
    const scan = await scanOperationalHits({
      uid,
      displayName: typeof user?.displayName === 'string' ? user.displayName : undefined,
      driverHash,
    });
    const decided = evaluateCleanupTestIdentity({
      uid,
      user,
      authEmail,
      authLookupOk,
      operationalHits: scan.ok ? scan.hits : [],
      scanOk: scan.ok,
    });
    if (!decided.ok) classified(decided.reason);

    const preview = {
      ok: true as const,
      mode,
      uid,
      email: decided.ok && !decided.idempotent ? decided.email : authEmail,
      actions: decided.ok ? decided.actions : [],
      idempotent: decided.ok ? decided.idempotent : false,
      operationalHits: scan.ok ? scan.hits : [],
    };
    if (mode !== 'apply' || preview.idempotent) return preview;

    const results: ActionResult[] = [];
    for (const action of preview.actions) {
      if (action.op === 'removeUserProfile') {
        results.push(await recordAction(action.op, action.path, async () => {
          const snap = await admin.database().ref(action.path).once('value');
          if (!snap.exists()) {
            throw Object.assign(new Error('not-found'), { code: 'not-found' });
          }
          await admin.database().ref(action.path).remove();
        }));
      }
      if (action.op === 'deleteAuth') {
        results.push(await recordAction(action.op, action.uid, async () => {
          await admin.auth().deleteUser(action.uid);
        }));
      }
    }
    const summary = summarizeActionResults(results);
    await writeSecurityAudit({
      action: 'adminCleanupTestIdentity',
      actorUid: caller.uid,
      detail: {
        targetUid: uid,
        email: preview.email,
        reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : 'security_test_identity',
        results,
        summary,
      },
    });
    if (!summary.ok) {
      throw new httpsV2.HttpsError('internal', 'partial_cleanup_failed');
    }
    return { ...preview, results, summary };
  },
);
