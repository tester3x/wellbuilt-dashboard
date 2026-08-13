/**
 * Thin callable wrappers. Auth identity from request.auth only.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { randomBytes } from 'crypto';
import { checkRateLimit } from '../security/rateLimit';
import { decideResolve } from '../security/operational/shiftAuthority.js';
import { shiftAuthorityPath, type ShiftAuthorityRecord } from '../security/operational/shiftAuthority.js';
import {
  JsaReceiptError,
  handleComplete,
  handleConsume,
  handleRegister,
  type ReceiptDeps,
  type ReceiptTxn,
} from './jsaReceiptHandlers.js';
import type { JsaCompanyPolicy } from './jsaReceiptCore.js';

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

export function buildReceiptDeps(): ReceiptDeps {
  const db = admin.firestore();
  return {
    nowMs: () => Date.now(),
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    base64Url: (b) => Buffer.from(b).toString('base64url'),
    async getJsaPolicy(companyId): Promise<JsaCompanyPolicy> {
      // Authoritative-enough company flags without inventing plan math.
      // requiresActiveShift defaults true unless the company document
      // explicitly stores a free/owner-operator posture. jsaEnabled is
      // true unless jsaMode === 'off'.
      try {
        const snap = await db.collection('companies').doc(companyId).get();
        const d = snap.data() || {};
        const mode = typeof d.jsaMode === 'string' ? d.jsaMode : 'per_job';
        const jobPolicy = typeof d.jsaJobPolicy === 'string' ? d.jsaJobPolicy : 'read_and_acknowledge';
        const allowAck = d.jsaAllowAcknowledge === true || jobPolicy === 'acknowledge' || jobPolicy === 'read_and_acknowledge';
        const freePlan = d.planId === 'free' || d.tier === 'free' || d.ownerOperator === true;
        return {
          jsaEnabled: mode !== 'off',
          requiresActiveShift: !freePlan,
          allowRead: jobPolicy !== 'acknowledge',
          allowAcknowledge: allowAck,
        };
      } catch {
        return {
          jsaEnabled: true,
          requiresActiveShift: true,
          allowRead: true,
          allowAcknowledge: false,
        };
      }
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
      // Bounded reason codes only — never identifiers.
      console.log(JSON.stringify({ tag: event, ...extra }));
    },
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
