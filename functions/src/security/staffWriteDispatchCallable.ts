import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireManageDrivers } from './adminAuth';
import { LEGACY_WELL_POOL_COMPANY_ID } from './dashboardCatalogProjection';
import {
  DISPATCH_CREATE_ALLOWLIST,
  DISPATCH_UPDATE_ALLOWLIST,
  evaluateStaffWriteDispatch,
  pickDispatchFields,
  serializeStaffDispatchRecord,
  isCanonicalDriverId,
  resolveServerAssignmentIdentity,
  type DispatchDriverProfile,
  type StaffWriteOp,
} from './operational/staffWriteDispatch';

const ALLOWED_KEYS = new Set(['op', 'dispatchId', 'record']);

/**
 * Read a driver's AUTHORITATIVE profile from RTDB drivers/profiles/{canonicalId}.
 * The server resolves the driver's real name + company here — the client is never
 * trusted for the stored identity. A profile's own displayName can literally be the
 * login string; the real name is legalName → displayName (resolveServerAssignmentIdentity).
 */
async function readDriverProfile(canonicalId: string): Promise<DispatchDriverProfile> {
  const snap = await admin.database().ref(`drivers/profiles/${canonicalId}`).once('value');
  if (!snap.exists()) {
    return { exists: false, active: false, companyId: null, legalName: null, displayName: null };
  }
  const v = (snap.val() || {}) as Record<string, unknown>;
  const str = (x: unknown): string | null => (typeof x === 'string' && x.trim().length > 0 ? x.trim() : null);
  return {
    exists: true,
    active: v.active !== false,
    companyId: str(v.companyId),
    legalName: str(v.legalName),
    displayName: str(v.displayName),
  };
}

/**
 * Overwrite driverId/driverHash/driverName on the record with the SERVER-resolved
 * canonical identity (validated against the driver's company profile). Throws on a
 * cross-company mismatch. No-op when the record carries no driver identity.
 */
async function stampServerAuthoritativeIdentity(
  fields: Record<string, unknown>,
  dispatchCompanyId: string,
): Promise<void> {
  const clientDriverId = typeof fields.driverId === 'string' ? fields.driverId.trim() : '';
  const clientDriverHash = typeof fields.driverHash === 'string' ? fields.driverHash.trim() : '';
  if (!clientDriverId && !clientDriverHash) return; // no identity on this write (field-only patch)
  const canonical = isCanonicalDriverId(clientDriverId)
    ? clientDriverId
    : isCanonicalDriverId(clientDriverHash)
      ? clientDriverHash
      : '';
  const profile = canonical ? await readDriverProfile(canonical) : null;
  const res = resolveServerAssignmentIdentity({
    clientDriverId,
    clientDriverHash,
    clientDriverName: fields.driverName,
    profile,
    dispatchCompanyId,
    legacyWellPoolCompanyId: LEGACY_WELL_POOL_COMPANY_ID,
  });
  if (!res.ok) {
    const msg = res.field ? `${res.reason}:${res.field}` : res.reason;
    throw new httpsV2.HttpsError('failed-precondition', msg);
  }
  delete fields.driverId;
  delete fields.driverHash;
  delete fields.driverName;
  if (res.fields.driverId !== undefined) fields.driverId = res.fields.driverId;
  if (res.fields.driverHash !== undefined) fields.driverHash = res.fields.driverHash;
  if (res.fields.driverName !== undefined) fields.driverName = res.fields.driverName;
}

function throwDecided(decided: { ok: false; reason: string; field?: string }): never {
  const msg = decided.field ? `${decided.reason}:${decided.field}` : decided.reason;
  const code = decided.reason === 'unexpected_field' || decided.reason === 'unknown_status'
    ? 'invalid-argument'
    : 'failed-precondition';
  throw new httpsV2.HttpsError(code, msg);
}

export const staffWriteDispatch = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    const op = raw.op as StaffWriteOp;
    if (op !== 'create' && op !== 'update' && op !== 'cancel') {
      throw new httpsV2.HttpsError('invalid-argument', 'op must be create, update, or cancel');
    }
    const dispatchId = typeof raw.dispatchId === 'string' ? raw.dispatchId.trim() : '';
    const incoming = (raw.record && typeof raw.record === 'object' && !Array.isArray(raw.record))
      ? (raw.record as Record<string, unknown>)
      : {};
    const allow = op === 'update' ? DISPATCH_UPDATE_ALLOWLIST : DISPATCH_CREATE_ALLOWLIST;
    const serialized = serializeStaffDispatchRecord(incoming, allow);
    if (!serialized.ok) throwDecided(serialized);
    const record = serialized.record || {};

    const fs = admin.firestore();

    if (op === 'create') {
      const decided = evaluateStaffWriteDispatch({
        op,
        job: null,
        record,
        callerCompanyId: caller.companyId,
        isPlatformAdmin: caller.isPlatformAdmin,
      });
      if (!decided.ok) throwDecided(decided);
      const fields = pickDispatchFields(record, DISPATCH_CREATE_ALLOWLIST);
      // Server-authoritative driver identity (canonical driverId + driverHash + real name).
      await stampServerAuthoritativeIdentity(fields, decided.companyId);
      const docRef = await fs.collection('dispatches').add({
        ...fields,
        companyId: decided.companyId,
        status: decided.status || 'pending',
        assignedAt: FieldValue.serverTimestamp(),
        assignedBy: fields.assignedBy || caller.uid,
      });
      return { ok: true as const, op, dispatchId: docRef.id };
    }

    if (!dispatchId) throw new httpsV2.HttpsError('invalid-argument', 'dispatchId required');

    const outcome = await fs.runTransaction(async (tx) => {
      const ref = fs.collection('dispatches').doc(dispatchId);
      const snap = await tx.get(ref);
      const job = snap.exists ? (snap.data() as Record<string, unknown>) : null;
      const decided = evaluateStaffWriteDispatch({
        op,
        job,
        record,
        callerCompanyId: caller.companyId,
        isPlatformAdmin: caller.isPlatformAdmin,
      });
      if (!decided.ok) throwDecided(decided);
      if (decided.idempotent) {
        return { idempotent: true as const, dispatchId };
      }
      if (op === 'cancel') {
        tx.update(ref, {
          status: 'cancelled',
          cancelledAt: FieldValue.serverTimestamp(),
          cancelledBy: caller.uid,
        });
        return { idempotent: false as const, dispatchId };
      }
      const fields = pickDispatchFields(record, DISPATCH_UPDATE_ALLOWLIST);
      delete fields.companyId;
      // Reassign carries new driver identity — resolve it server-authoritatively too.
      await stampServerAuthoritativeIdentity(fields, decided.companyId);
      if (typeof record.status === 'string' && record.status.trim()) {
        fields.status = decided.status;
      } else {
        delete fields.status;
      }
      tx.update(ref, {
        ...fields,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: caller.uid,
      });
      return { idempotent: false as const, dispatchId };
    });

    return { ok: true as const, op, ...outcome };
  },
);
