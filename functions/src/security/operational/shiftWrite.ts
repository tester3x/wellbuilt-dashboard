/**
 * Secure driver shift write — replaces client REST to driver_shifts/{id}.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver } from '../requireDriverAuth';
import { writeSecurityAudit } from '../audit';

const ALLOWED_FIELDS = new Set([
  'shiftId',
  'driverId',
  'driverName',
  'companyId',
  'date',
  'startedAt',
  'endedAt',
  'status',
  'odometerStart',
  'odometerEnd',
  'location',
  'notes',
  'idempotencyKey',
]);

export const upsertDriverShift = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      shift?: Record<string, unknown>;
      shiftDocId?: string;
      driverHash?: string;
    };
    if (!data.shift || typeof data.shift !== 'object') {
      throw new httpsV2.HttpsError('invalid-argument', 'shift required');
    }

    const driver = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });

    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data.shift)) {
      if (ALLOWED_FIELDS.has(k)) cleaned[k] = v;
    }
    cleaned.driverId = driver.driverId;
    if (driver.companyId) cleaned.companyId = driver.companyId;
    if (driver.displayName) cleaned.driverName = driver.displayName;
    cleaned.updatedAt = FieldValue.serverTimestamp();
    cleaned.authSource = driver.authSource;

    // Doc id: prefer client shiftDocId if it encodes ownership, else compose
    let docId = (data.shiftDocId || '').trim();
    if (!docId) {
      const date = String(cleaned.date || new Date().toISOString().slice(0, 10));
      docId = `${driver.driverId}_${date}`;
    }
    // Ownership: doc id must start with driverId or equal
    if (!docId.startsWith(driver.driverId) && !docId.includes(driver.driverId)) {
      // For legacy hash ids during dual-run, allow if authSource legacy
      if (driver.authSource !== 'legacy_hash') {
        throw new httpsV2.HttpsError('permission-denied', 'Shift id must be owned by driver');
      }
    }

    const ref = admin.firestore().collection('driver_shifts').doc(docId);
    const existing = await ref.get();
    if (existing.exists) {
      const prev = existing.data() || {};
      if (prev.driverId && prev.driverId !== driver.driverId && prev.driverId !== data.driverHash) {
        throw new httpsV2.HttpsError('permission-denied', 'Cannot overwrite another driver shift');
      }
      // Terminal state guard
      if (prev.status === 'finalized' && cleaned.status && cleaned.status !== 'finalized') {
        throw new httpsV2.HttpsError('failed-precondition', 'Cannot reopen finalized shift');
      }
      await ref.set(cleaned, { merge: true });
    } else {
      cleaned.createdAt = FieldValue.serverTimestamp();
      await ref.set(cleaned);
    }

    await writeSecurityAudit({
      action: 'upsertDriverShift',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { docId },
    });
    return { ok: true, shiftDocId: docId };
  },
);
