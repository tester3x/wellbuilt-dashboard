/**
 * Thin callable wrappers. Auth identity from request.auth only.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { createHash, randomBytes } from 'crypto';
import { checkRateLimit } from '../security/rateLimit';
import { decideResolve } from '../security/operational/shiftAuthority.js';
import { shiftAuthorityPath, type ShiftAuthorityRecord } from '../security/operational/shiftAuthority.js';
import { buildSsoDeps } from '../sso/ssoCallables.js';
import {
  JsaReceiptError,
  handleComplete,
  handleConsume,
  handleGetContext,
  handlePersist,
  handleRegister,
  type ArtifactDeps,
  type ReceiptTxn,
} from './jsaReceiptHandlers.js';
import { handleResolveCurrentShiftReadEvidence } from './jsaCurrentShiftReadEvidence.js';
import { handleAcknowledgeJob } from './jsaJobAcknowledgment.js';
import { fromStored } from './jsaReceiptCore.js';

const OPTIONS = {
  timeoutSeconds: 30,
  memory: '256MiB' as const,
  enforceAppCheck: false,
};

function toHttps(err: unknown): httpsV2.HttpsError {
  if (err instanceof JsaReceiptError) {
    return new httpsV2.HttpsError(err.http, err.refusal, { reason: err.refusal });
  }
  return new httpsV2.HttpsError('internal', 'unavailable');
}

function authOf(request: httpsV2.CallableRequest) {
  return {
    uid: request.auth?.uid ?? null,
    claims: (request.auth?.token || {}) as Record<string, unknown>,
  };
}

export function buildReceiptDeps(): ArtifactDeps {
  const db = admin.firestore();
  // CANONICAL POLICY READERS — the very same functions SSO issuance uses,
  // taken from its production deps builder rather than re-implemented, so
  // registration and issuance literally share one contract parser and one
  // plan reader and cannot drift.
  const sso = buildSsoDeps();
  return {
    nowMs: () => Date.now(),
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    base64Url: (b) => Buffer.from(b).toString('base64url'),
    getCompanyContract: (companyId) => sso.getCompanyContract(companyId),
    getPlan: (planId) => sso.getPlan(planId),
    async getJsaStylePolicy(companyId) {
      // Completion-STYLE only (never entitlement): which completion
      // interactions the company's JSA workflow offers. Fail closed to
      // the strictest style — read required, no bare acknowledgment.
      try {
        const snap = await db.collection('companies').doc(companyId).get();
        const d = snap.data() || {};
        const jobPolicy = typeof d.jsaJobPolicy === 'string' ? d.jsaJobPolicy : 'read_and_acknowledge';
        const allowAck = d.jsaAllowAcknowledge === true || jobPolicy === 'acknowledge' || jobPolicy === 'read_and_acknowledge';
        return {
          allowRead: jobPolicy !== 'acknowledge',
          allowAcknowledge: allowAck,
        };
      } catch {
        return { allowRead: true, allowAcknowledge: false };
      }
    },
    async readInvoice(jobRef) {
      const snap = await db.collection('invoices').doc(jobRef).get();
      return { exists: snap.exists, data: snap.data() as Record<string, unknown> | undefined };
    },
    async resolveShift(driverId, companyId) {
      try {
        const snap = await db.doc(shiftAuthorityPath(driverId)).get();
        if (!snap.exists) return decideResolve(null, { driverId, companyId });
        const d = snap.data() ?? {};
        if (typeof d.driverId !== 'string' || typeof d.companyId !== 'string'
          || typeof d.initialized !== 'boolean' || typeof d.version !== 'number') {
          return decideResolve(null, { driverId, companyId });
        }
        const rec: ShiftAuthorityRecord = {
          driverId: d.driverId,
          companyId: d.companyId,
          initialized: d.initialized,
          openPeriodId: typeof d.openPeriodId === 'string' ? d.openPeriodId : null,
          originLocalDate: typeof d.originLocalDate === 'string' ? d.originLocalDate : null,
          version: d.version,
        };
        return decideResolve(rec, { driverId, companyId });
      } catch {
        return decideResolve(null, { driverId, companyId });
      }
    },
    async runTransaction(fn) {
      return db.runTransaction(async (t) => {
        const txn: ReceiptTxn = {
          async get(path) {
            const s = await t.get(db.doc(path));
            return { exists: s.exists, data: s.data() as Record<string, unknown> | undefined };
          },
          create(path, data) { t.create(db.doc(path), data); },
          update(path, fields) { t.update(db.doc(path), fields); },
        };
        return fn(txn);
      });
    },
    log(event, extra) {
      // Bounded reason codes only — never identifiers or signature bytes.
      console.log(JSON.stringify({ tag: event, ...extra }));
    },
    sha256Hex(bytes) {
      return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    },
  };
}

function currentShiftReadEvidenceDeps() {
  const db = admin.firestore();
  const base = buildReceiptDeps();
  return {
    resolveShift: (driverId: string, companyId: string) => base.resolveShift(driverId, companyId),
    async listGovernedByPeriod(companyId: string, driverId: string, periodId: string) {
      const snap = await db.collection('jsa_governed_requests')
        .where('companyId', '==', companyId)
        .where('driverId', '==', driverId)
        .where('binding.periodId', '==', periodId)
        .get();
      const out = [];
      for (const doc of snap.docs) {
        const rec = fromStored(doc.data());
        if (!rec) continue;
        out.push({
          companyId: rec.companyId,
          driverId: rec.driverId,
          state: rec.state,
          action: rec.action,
          bindingPeriodId: rec.binding.periodId ?? null,
        });
      }
      return out;
    },
    log: base.log,
  };
}

async function limited(uid: string, bucket: string): Promise<void> {
  const allowed = await checkRateLimit({
    bucket,
    key: uid,
    limit: 30,
    windowMs: 10 * 60 * 1000,
  });
  if (!allowed) throw new httpsV2.HttpsError('resource-exhausted', 'unavailable');
}

export const jsaRegisterReadRequest = httpsV2.onCall(OPTIONS, async (request) => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  await limited(request.auth.uid, 'jsa_register');
  try { return await handleRegister(buildReceiptDeps(), authOf(request), request.data); }
  catch (err) { throw toHttps(err); }
});

export const jsaGetReadRequest = httpsV2.onCall(OPTIONS, async (request) => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  // Higher window than the mutating callables: a crash/resume loop may
  // legitimately re-read several times, and the operation writes nothing.
  const allowed = await checkRateLimit({
    bucket: 'jsa_get',
    key: request.auth.uid,
    limit: 60,
    windowMs: 10 * 60 * 1000,
  });
  if (!allowed) throw new httpsV2.HttpsError('resource-exhausted', 'unavailable');
  try { return await handleGetContext(buildReceiptDeps(), authOf(request), request.data); }
  catch (err) { throw toHttps(err); }
});

export const jsaCompleteReadRequest = httpsV2.onCall(OPTIONS, async (request) => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  await limited(request.auth.uid, 'jsa_complete');
  try { return await handleComplete(buildReceiptDeps(), authOf(request), request.data); }
  catch (err) { throw toHttps(err); }
});

export const jsaConsumeReadResult = httpsV2.onCall(OPTIONS, async (request) => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  await limited(request.auth.uid, 'jsa_consume');
  try { return await handleConsume(buildReceiptDeps(), authOf(request), request.data); }
  catch (err) { throw toHttps(err); }
});

export const jsaPersistGovernedArtifact = httpsV2.onCall(OPTIONS, async (request) => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  await limited(request.auth.uid, 'jsa_persist_artifact');
  try { return await handlePersist(buildReceiptDeps(), authOf(request), request.data); }
  catch (err) { throw toHttps(err); }
});

export const jsaResolveCurrentShiftReadEvidence = httpsV2.onCall(OPTIONS, async (request) => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  await limited(request.auth.uid, 'jsa_shift_read_evidence');
  try {
    return await handleResolveCurrentShiftReadEvidence(
      currentShiftReadEvidenceDeps(),
      authOf(request),
      request.data,
    );
  } catch (err) { throw toHttps(err); }
});

function jobAckDeps() {
  const db = admin.firestore();
  const base = currentShiftReadEvidenceDeps();
  return {
    nowMs: () => Date.now(),
    sha256Hex(input: string) {
      return createHash('sha256').update(input, 'utf8').digest('hex');
    },
    resolveShift: base.resolveShift,
    async readAuthority(driverId: string): Promise<ShiftAuthorityRecord | null> {
      const snap = await db.doc(shiftAuthorityPath(driverId)).get();
      if (!snap.exists) return null;
      const d = snap.data() ?? {};
      if (typeof d.driverId !== 'string' || typeof d.companyId !== 'string'
        || typeof d.initialized !== 'boolean' || typeof d.version !== 'number') {
        return null;
      }
      return {
        driverId: d.driverId,
        companyId: d.companyId,
        initialized: d.initialized,
        openPeriodId: typeof d.openPeriodId === 'string' ? d.openPeriodId : null,
        originLocalDate: typeof d.originLocalDate === 'string' ? d.originLocalDate : null,
        version: d.version,
        lastClosedPeriodId: typeof d.lastClosedPeriodId === 'string' ? d.lastClosedPeriodId : null,
      };
    },
    async readShiftDay(driverId: string, localDate: string) {
      const snap = await db.doc(`driver_shifts/${driverId}_${localDate}`).get();
      if (!snap.exists) return null;
      const d = snap.data() ?? {};
      const raw = Array.isArray(d.events) ? d.events : [];
      const events = [];
      for (const ev of raw) {
        if (!ev || typeof ev !== 'object') continue;
        const e = ev as Record<string, unknown>;
        if (typeof e.type !== 'string' || typeof e.shiftId !== 'string'
          || typeof e.timestamp !== 'string' || typeof e.source !== 'string') {
          continue;
        }
        events.push({
          type: e.type,
          shiftId: e.shiftId,
          timestamp: e.timestamp,
          source: e.source,
        });
      }
      return {
        date: typeof d.date === 'string' ? d.date : localDate,
        currentShiftId: typeof d.currentShiftId === 'string' ? d.currentShiftId : null,
        events,
      };
    },
    async readInvoice(jobRef: string) {
      const snap = await db.collection('invoices').doc(jobRef).get();
      return {
        exists: snap.exists,
        createTimeMs: snap.createTime ? snap.createTime.toMillis() : null,
        data: snap.exists ? (snap.data() as Record<string, unknown>) : null,
      };
    },
    async readDispatch(dispatchId: string) {
      const snap = await db.collection('dispatches').doc(dispatchId).get();
      return {
        exists: snap.exists,
        data: snap.exists ? (snap.data() as Record<string, unknown>) : null,
      };
    },
    listGovernedByPeriod: base.listGovernedByPeriod,
    async runTransaction<T>(fn: (txn: {
      get(path: string): Promise<{ exists: boolean; data?: Record<string, unknown> }>;
      create(path: string, data: Record<string, unknown>): void;
    }) => Promise<T>): Promise<T> {
      return db.runTransaction(async (t) => {
        const txn = {
          async get(path: string) {
            const s = await t.get(db.doc(path));
            return { exists: s.exists, data: s.data() as Record<string, unknown> | undefined };
          },
          create(path: string, data: Record<string, unknown>) { t.create(db.doc(path), data); },
        };
        return fn(txn);
      });
    },
    log: base.log,
  };
}

export const jsaAcknowledgeJob = httpsV2.onCall(OPTIONS, async (request) => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  await limited(request.auth.uid, 'jsa_job_ack');
  try {
    return await handleAcknowledgeJob(jobAckDeps(), authOf(request), request.data);
  } catch (err) { throw toHttps(err); }
});
