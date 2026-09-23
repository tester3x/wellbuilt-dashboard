import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
} from './trustedStaffAuthority';
import { LEGACY_WELL_POOL_COMPANY_ID } from './dashboardCatalogProjection';
import {
  DISPATCH_CREATE_ALLOWLIST,
  DISPATCH_UPDATE_ALLOWLIST,
  STAFF_WRITE_DISPATCH_FORBIDDEN_REQUEST_KEYS,
  evaluateStaffWriteDispatch,
  pickDispatchFields,
  serializeStaffDispatchRecord,
  staffWriteDispatchAccessFromTrusted,
  isCanonicalDriverId,
  resolveServerAssignmentIdentity,
  type DispatchDriverProfile,
  type StaffWriteOp,
} from './operational/staffWriteDispatch';
import {
  evaluateCreateIfAbsent,
  parseDispatchId,
  parsePacketRef,
  rejectBindingMutation,
  rejectCallerAuthorityFields,
  resolveCanonicalJobType,
  stampDispatchBinding,
  type BirthIdentity,
} from './operational/dispatchPacketPin';
import {
  loadAuthoritativeWell,
  loadAuthorizedWellCatalog,
  loadVerifiedRevision,
} from './operational/dispatchPinRuntime';
import { packageIndexDocId } from './operational/jobPacketPublish';
import { INDEX_COLLECTION } from './operational/jobPacketRevisionStore';
import {
  authorizeAdminCall,
  PLATFORM_ADMINS_COLLECTION,
  WELLBUILT_ADMIN_CLAIM,
} from '../admin/authority';

const ALLOWED_KEYS = new Set(['op', 'dispatchId', 'record', 'packetRef']);
const COMPANIES_COLLECTION = 'companies';

/**
 * Platform-admin authorization path (ALONGSIDE the trusted company-staff path).
 *
 * Reuses the canonical server gate in admin/authority.ts (authorizeAdminCall):
 * a caller is a platform admin only when the verified token carries
 * wellbuiltAdmin===true AND an enabled platform_admins/{uid} record exists — a
 * server-owned Firestore read, never a bare client claim. The claim is checked
 * first purely to skip the read for ordinary staff; authorizeAdminCall remains
 * the sole decision, so a claim without an enabled record is NOT a shortcut.
 */
async function resolvePlatformAdmin(
  auth: { uid?: string | null; token?: Record<string, unknown> | null } | undefined,
): Promise<{ isAdmin: true; uid: string } | { isAdmin: false }> {
  const uid = auth?.uid ?? null;
  const token = auth?.token ?? null;
  if (!uid || !token || token[WELLBUILT_ADMIN_CLAIM] !== true) return { isAdmin: false };
  const snap = await admin.firestore().collection(PLATFORM_ADMINS_COLLECTION).doc(uid).get();
  const authz = authorizeAdminCall({ uid, token }, snap.exists ? (snap.data() as never) : null);
  return authz.ok ? { isAdmin: true, uid: authz.actorUid } : { isAdmin: false };
}

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
  if (decided.reason === 'unauthenticated') {
    throw new httpsV2.HttpsError('unauthenticated', msg);
  }
  if (
    decided.reason === 'missing_company'
    || decided.reason === 'missing_required_capability'
    || decided.reason === 'no_trusted_authority_record'
    || decided.reason === 'trusted_authority_inactive'
    || decided.reason === 'trusted_authority_malformed'
    || decided.reason === 'trusted_authority_uid_mismatch'
    || decided.reason === 'reserved_capability'
    || decided.reason === 'unknown_capability'
  ) {
    throw new httpsV2.HttpsError('permission-denied', msg);
  }
  if (decided.reason === 'create_conflict') {
    throw new httpsV2.HttpsError('already-exists', msg);
  }
  const code = decided.reason === 'unexpected_field'
    || decided.reason === 'unknown_status'
    || decided.reason === 'caller_authority_field'
    || decided.reason === 'dispatch_id_required'
    || decided.reason === 'invalid_format'
    || decided.reason === 'malformed_dispatch_id'
    ? 'invalid-argument'
    : 'failed-precondition';
  throw new httpsV2.HttpsError(code, msg);
}

export const staffWriteDispatch = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    // Authority order: (a) the platform-admin gate (verified wellbuiltAdmin claim
    // AND an enabled platform_admins/{uid} record) → PLATFORM ADMIN; else (b) the
    // UNCHANGED trusted company-staff path. A bare claim is never a shortcut.
    const platform = await resolvePlatformAdmin(request.auth);
    let access: { ok: true; uid: string; companyId: string; isPlatformAdmin: boolean };
    if (platform.isAdmin) {
      // The acting company is resolved+validated per-op below: create takes the
      // server-validated target company; update/cancel use the existing dispatch's
      // own companyId. Never the caller's own company (a platform admin has none).
      access = { ok: true, uid: platform.uid, companyId: '', isPlatformAdmin: true };
    } else {
      const trusted = await requireTrustedCompanyCapability(
        request.auth?.uid,
        TRUSTED_CAPABILITY_MANAGE_DRIVERS,
      );
      const trustedAccess = staffWriteDispatchAccessFromTrusted(trusted);
      if (!trustedAccess.ok) throwDecided(trustedAccess);
      access = trustedAccess;
    }
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if ((STAFF_WRITE_DISPATCH_FORBIDDEN_REQUEST_KEYS as readonly string[]).includes(key)) {
        throwDecided({ ok: false, reason: 'caller_authority_field', field: key });
      }
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
      ? { ...(raw.record as Record<string, unknown>) }
      : {};
    const allow = op === 'update' ? DISPATCH_UPDATE_ALLOWLIST : DISPATCH_CREATE_ALLOWLIST;
    const serialized = serializeStaffDispatchRecord(incoming, allow);
    if (!serialized.ok) throwDecided(serialized);
    const record = serialized.record || {};

    const fs = admin.firestore();

    if (op === 'create') {
      if (access.isPlatformAdmin) {
        // Platform admin selects the customer via record.companyId. Validate the
        // target company on the server (it must exist and not be archived), set the
        // acting company to the validated target, then STRIP the field so the shared
        // caller-authority guard and the stored dispatch never carry a client
        // companyId. Driver/well/packet are all validated against this target below.
        const target = typeof incoming.companyId === 'string' ? incoming.companyId.trim() : '';
        if (!target) {
          throw new httpsV2.HttpsError('failed-precondition', 'target_company_required');
        }
        const companySnap = await fs.collection(COMPANIES_COLLECTION).doc(target).get();
        if (!companySnap.exists) {
          throw new httpsV2.HttpsError('failed-precondition', 'target_company_not_found');
        }
        if ((companySnap.data() || {}).status === 'archived') {
          throw new httpsV2.HttpsError('failed-precondition', 'target_company_archived');
        }
        delete incoming.companyId;
        delete record.companyId;
        access = { ...access, companyId: target };
      }
      const id = parseDispatchId(raw.dispatchId);
      if (!id.ok) throwDecided(id);

      let resolvedPackageId = 'water-hauling';
      if (raw.packetRef && typeof raw.packetRef === 'object' && typeof (raw.packetRef as Record<string, unknown>).packageId === 'string') {
        resolvedPackageId = ((raw.packetRef as Record<string, unknown>).packageId as string).trim() || 'water-hauling';
      } else if (typeof incoming.packageId === 'string' && incoming.packageId.trim()) {
        resolvedPackageId = incoming.packageId.trim();
      }

      if (Object.prototype.hasOwnProperty.call(incoming, 'packageId')) {
        delete incoming.packageId;
      }
      if (Object.prototype.hasOwnProperty.call(record, 'packageId')) {
        delete record.packageId;
      }

      let packetRefInput = raw.packetRef;
      if (!packetRefInput) {
        let resolvedRevision = 1;
        const headDocId = packageIndexDocId(access.companyId, resolvedPackageId);
        const headSnap = await fs.collection(INDEX_COLLECTION).doc(headDocId).get();
        if (headSnap.exists && typeof headSnap.data()?.latestRevision === 'number' && (headSnap.data()?.latestRevision as number) > 0) {
          resolvedRevision = headSnap.data()?.latestRevision as number;
        }
        packetRefInput = { packageId: resolvedPackageId, revision: resolvedRevision };
      }

      const packet = parsePacketRef(packetRefInput);
      if (!packet.ok) throwDecided(packet);
      const authority = rejectCallerAuthorityFields(incoming);
      if (!authority.ok) throwDecided(authority);
      const decided = evaluateStaffWriteDispatch({
        op,
        job: null,
        record,
        callerCompanyId: access.companyId,
        isPlatformAdmin: access.isPlatformAdmin,
      });
      if (!decided.ok) throwDecided(decided);
      const wells = await loadAuthorizedWellCatalog(access.companyId);
      if (!wells.ok) throwDecided(wells);
      const authWell = await loadAuthoritativeWell(record, decided.companyId);
      if (!authWell.ok) throwDecided(authWell);
      const revision = await loadVerifiedRevision(decided.companyId, packet.packetRef);
      if (!revision.ok) throwDecided(revision);
      const jobType = resolveCanonicalJobType(record.jobType, revision.envelope.jobTypes);
      if (!jobType.ok) throwDecided(jobType);
      const fields = pickDispatchFields(record, DISPATCH_CREATE_ALLOWLIST);
      delete fields.packageId;
      await stampServerAuthoritativeIdentity(fields, decided.companyId);
      fields.wellName = authWell.well.wellName;
      fields.ndicWellName = authWell.well.ndicWellName;
      const binding = stampDispatchBinding(revision.envelope);
      const identity: BirthIdentity = {
        companyId: decided.companyId,
        driverId: typeof fields.driverId === 'string' ? fields.driverId : '',
        jobTypeId: jobType.jobTypeId,
        binding,
        well: {
          wellName: authWell.well.wellName,
          ndicWellName: authWell.well.ndicWellName,
        },
      };
      const outcome = await fs.runTransaction(async (tx) => {
        const ref = fs.collection('dispatches').doc(id.dispatchId);
        const snap = await tx.get(ref);
        const existing = snap.exists ? (snap.data() as Record<string, unknown>) : null;
        const replay = evaluateCreateIfAbsent({ existing, expected: identity });
        if (!replay.ok) {
          throwDecided({ ok: false, reason: 'create_conflict', field: 'dispatchId' });
        }
        if (replay.result === 'already_exists') {
          return { result: 'already_exists' as const, dispatchId: id.dispatchId };
        }
        tx.create(ref, {
          ...fields,
          ...binding,
          jobType: jobType.jobTypeId,
          companyId: decided.companyId,
          status: decided.status || 'pending',
          assignedAt: FieldValue.serverTimestamp(),
          assignedBy: fields.assignedBy || access.uid,
          // Attribution for platform-admin (cross-company) creates. Ordinary staff
          // creates are unchanged (no extra fields).
          ...(access.isPlatformAdmin
            ? {
                assignedByUid: access.uid,
                actingPlatformAdminUid: access.uid,
                targetCompanyId: decided.companyId,
              }
            : {}),
        });
        return { result: 'created' as const, dispatchId: id.dispatchId };
      });
      return { ok: true as const, op, ...outcome };
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
        callerCompanyId: access.companyId,
        isPlatformAdmin: access.isPlatformAdmin,
      });
      if (!decided.ok) throwDecided(decided);
      if (decided.idempotent) {
        return { idempotent: true as const, dispatchId };
      }
      const bindGate = rejectBindingMutation(job || {}, incoming);
      if (!bindGate.ok) throwDecided(bindGate);
      if (op === 'cancel') {
        tx.update(ref, {
          status: 'cancelled',
          cancelledAt: FieldValue.serverTimestamp(),
          cancelledBy: access.uid,
          ...(access.isPlatformAdmin
            ? { actingPlatformAdminUid: access.uid, targetCompanyId: decided.companyId }
            : {}),
        });
        return { idempotent: false as const, dispatchId };
      }
      const fields = pickDispatchFields(record, DISPATCH_UPDATE_ALLOWLIST);
      delete fields.companyId;
      delete fields.packageId;
      delete fields.packetRevision;
      delete fields.contentHash;
      delete fields.policyHash;
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
        updatedBy: access.uid,
        ...(access.isPlatformAdmin
          ? { actingPlatformAdminUid: access.uid, targetCompanyId: decided.companyId }
          : {}),
      });
      return { idempotent: false as const, dispatchId };
    });

    return { ok: true as const, op, ...outcome };
  },
);
