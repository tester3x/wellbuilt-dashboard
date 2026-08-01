/**
 * Secure JSA record + day-status writes (Admin SDK).
 * Replaces open Firestore client writes to jsas / jsa_day_status.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver } from '../requireDriverAuth';
import { writeSecurityAudit } from '../audit';

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
    if (!data.jsa || typeof data.jsa !== 'object') {
      throw new httpsV2.HttpsError('invalid-argument', 'jsa required');
    }
    if (JSON.stringify(data.jsa).length > MAX_JSA_JSON) {
      throw new httpsV2.HttpsError('invalid-argument', 'jsa payload too large');
    }

    const driver = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });

    const jsa = { ...data.jsa };
    jsa.driverId = driver.driverId;
    if (driver.displayName) jsa.driverName = driver.displayName;
    if (driver.companyId) jsa.companyId = driver.companyId;
    jsa.updatedAt = FieldValue.serverTimestamp();
    jsa.authSource = driver.authSource;
    delete (jsa as any).isAdmin;
    delete (jsa as any).roles;

    let jsaId = (data.jsaId || '').trim();
    if (!jsaId && data.idempotencyKey) {
      jsaId = `idem_${String(data.idempotencyKey).replace(/[\/]/g, '_').slice(0, 80)}`;
    }
    const col = admin.firestore().collection('jsas');
    if (jsaId) {
      const ref = col.doc(jsaId);
      const ex = await ref.get();
      if (ex.exists) {
        const prev = ex.data() || {};
        if (prev.driverId && prev.driverId !== driver.driverId && prev.driverId !== data.driverHash) {
          throw new httpsV2.HttpsError('permission-denied', 'JSA owned by another driver');
        }
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

    // Optional day status mirror
    if (data.dayStatus && typeof data.dayStatus === 'object') {
      const ds = { ...data.dayStatus };
      ds.driverId = driver.driverId;
      if (driver.companyId) ds.companyId = driver.companyId;
      ds.updatedAt = FieldValue.serverTimestamp();
      const dsId =
        (data.dayStatusId || '').trim() ||
        `${driver.driverId}_${String(ds.shiftId || ds.date || 'day')}`;
      await admin.firestore().collection('jsa_day_status').doc(dsId).set(ds, { merge: true });
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
