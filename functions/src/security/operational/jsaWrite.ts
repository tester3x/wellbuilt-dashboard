/**
 * Secure JSA record + day-status writes. Existing rows require owner+company.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver, isManagerCapability } from '../requireDriverAuth';
import { writeSecurityAudit } from '../audit';
import { decideResourceOwnership } from './resourceOwnership';

const MAX_JSA_JSON = 500_000;

export const submitJsaRecord = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '512MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      jsa?: Record<string, unknown>;
      jsaId?: string;
      dayStatus?: Record<string, unknown>;
      dayStatusId?: string;
      driverHash?: string;
      idempotencyKey?: string;
    };
    if (data.driverHash != null) {
      throw new httpsV2.HttpsError('permission-denied', 'legacy_hash_rejected');
    }
    if (!data.jsa || typeof data.jsa !== 'object') {
      throw new httpsV2.HttpsError('invalid-argument', 'jsa required');
    }
    if (JSON.stringify(data.jsa).length > MAX_JSA_JSON) {
      throw new httpsV2.HttpsError('invalid-argument', 'jsa payload too large');
    }

    const driver = await requireSecureDriver(request);
    const manager = isManagerCapability(driver);

    const jsa = { ...data.jsa };
    jsa.driverId = driver.driverId;
    jsa.companyId = driver.companyId;
    if (driver.displayName) jsa.driverName = driver.displayName;
    jsa.updatedAt = FieldValue.serverTimestamp();
    jsa.authSource = driver.authSource;
    delete (jsa as { isAdmin?: unknown }).isAdmin;
    delete (jsa as { roles?: unknown }).roles;
    delete (jsa as { driverHash?: unknown }).driverHash;

    let jsaId = (data.jsaId || '').trim();
    if (!jsaId && data.idempotencyKey) {
      jsaId = `idem_${String(data.idempotencyKey).replace(/\//g, '_').slice(0, 80)}`;
    }
    const col = admin.firestore().collection('jsas');
    if (jsaId) {
      const ref = col.doc(jsaId);
      const ex = await ref.get();
      if (ex.exists) {
        const prev = ex.data() || {};
        const own = decideResourceOwnership({
          callerDriverId: driver.driverId,
          callerCompanyId: driver.companyId,
          resourceDriverId: prev.driverId,
          resourceCompanyId: prev.companyId,
          isManager: manager,
        });
        if (!own.ok) throw new httpsV2.HttpsError('permission-denied', own.reason);
        jsa.driverId = prev.driverId;
        jsa.companyId = prev.companyId;
        await ref.set(jsa, { merge: true });
      } else {
        jsa.createdAt = FieldValue.serverTimestamp();
        await ref.set(jsa);
      }
    } else {
      jsa.createdAt = FieldValue.serverTimestamp();
      const created = await col.add(jsa);
      jsaId = created.id;
    }

    if (data.dayStatus && typeof data.dayStatus === 'object') {
      const ds = { ...data.dayStatus };
      ds.driverId = driver.driverId;
      ds.companyId = driver.companyId;
      ds.updatedAt = FieldValue.serverTimestamp();
      const dsId =
        (data.dayStatusId || '').trim() ||
        `${driver.driverId}_${String(ds.shiftId || ds.date || 'day')}`;
      const dsRef = admin.firestore().collection('jsa_day_status').doc(dsId);
      const dsEx = await dsRef.get();
      if (dsEx.exists) {
        const prev = dsEx.data() || {};
        const own = decideResourceOwnership({
          callerDriverId: driver.driverId,
          callerCompanyId: driver.companyId,
          resourceDriverId: prev.driverId,
          resourceCompanyId: prev.companyId,
          isManager: manager,
        });
        if (!own.ok) throw new httpsV2.HttpsError('permission-denied', own.reason);
      }
      await dsRef.set(ds, { merge: true });
    }

    await writeSecurityAudit({
      action: 'submitJsaRecord',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { jsaId },
    });
    return { ok: true, jsaId };
  },
);
