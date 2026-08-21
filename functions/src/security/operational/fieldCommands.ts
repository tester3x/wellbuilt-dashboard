/**
 * Authenticated field commands — complete replacement for public
 * packets/incoming Gen-1 handlers.
 *
 * Drivers never write RTDB. Client identity/company/authority fields are
 * stripped. The server stamps driverId, driverName, companyId, roles, and
 * well-down authority. Legitimate operational context is explicitly schema'd.
 *
 * Pull is create-only. Delete mutates only the authorized originalPacketId.
 * Receipts are scoped to driver+company+type+packet. Mutation and receipt
 * commit as one journaled apply. incoming_version increments in a transaction.
 * Outgoing responses are written so WB-M's waiter/listener can resolve.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver, type SecureDriver } from '../requireDriverAuth';
import { writeSecurityAudit } from '../audit';
import { checkRateLimit, hashIp } from '../rateLimit';
import {
  applyIncomingVersionState,
  decideWellAssignment,
  incrementIncomingVersionValue,
  type FieldApplyStores,
} from './fieldCommandApply';
import {
  canonicalReceiptKey,
  contentDigest,
  decideLease,
  FIELD_COMMAND_LEASE_MS,
  newAttemptToken,
  targetLockKey,
  type FieldReceipt,
} from './fieldCommandLease';
import { runFieldCommandPipeline } from './fieldCommandOrchestrator';
import { type PersistTxn } from './fieldCommandPersist';

export const FIELD_COMMAND_MAX_BYTES = 12 * 1024;
export const WELL_NAME_RE = /^[\p{L}\p{N} .'_-]{2,80}$/u;
export const PACKET_ID_RE = /^[A-Za-z0-9._-]{8,96}$/;
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Client-supplied identity/company/authority — never trusted, always stripped. */
export const IDENTITY_STRIP_KEYS = Object.freeze([
  'driverId',
  'driverName',
  'companyId',
  'companyName',
  'roles',
  'isAdmin',
  'isViewer',
  'uid',
  'authUid',
  'dashboardUid',
  'dashboardRole',
  'hash',
  'driverHash',
  'origin',
  'source',
  'app',
  'lastPullDriverId',
  'lastPullDriverName',
  'ingestedBy',
  'authSource',
] as const);

export const PULL_KEYS = Object.freeze([
  'requestType',
  'packetId',
  'wellName',
  'dateTimeUTC',
  'dateTime',
  'timezone',
  'tankLevelFeet',
  'bblsTaken',
  'wellDown',
  'predictedLevelInches',
  'invoiceDocId',
  'dispatchId',
  'idempotencyKey',
  'jobType',
  'jobOrigin',
  'invoicingMode',
  'originAppContext',
] as const);

export const EDIT_KEYS = Object.freeze([
  'requestType',
  'packetId',
  'originalPacketId',
  'wellName',
  'dateTimeUTC',
  'dateTime',
  'timezone',
  'tankLevelFeet',
  'bblsTaken',
  'wellDown',
  'predictedLevelInches',
  'invoiceDocId',
  'dispatchId',
  'idempotencyKey',
  'jobType',
  'jobOrigin',
  'invoicingMode',
  'originAppContext',
] as const);

export const DELETE_KEYS = Object.freeze([
  'requestType',
  'packetId',
  'originalPacketId',
  'wellName',
  'idempotencyKey',
] as const);

export type FieldCommandType = 'pull' | 'edit' | 'delete';

export type FieldCommandRefuse =
  | 'unauthenticated'
  | 'malformed'
  | 'unknown_field'
  | 'oversized'
  | 'bad_type'
  | 'bad_range'
  | 'cross_company'
  | 'well_not_assigned'
  | 'well_unscoped'
  | 'resource_mismatch'
  | 'not_owner'
  | 'well_down_forbidden'
  | 'rate_limited'
  | 'legacy_hash_rejected'
  | 'packet_collision'
  | 'idempotency_collision';

export type FieldCommandDecision =
  | { ok: true; type: FieldCommandType; packetId: string; idempotencyKey: string; originalPacketId?: string }
  | { ok: false; reason: FieldCommandRefuse; detail: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function hasOnly(obj: Record<string, unknown>, allow: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !allow.includes(k));
}

function numIn(n: unknown, min: number, max: number): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
}

export function stripClientIdentity(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if ((IDENTITY_STRIP_KEYS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

export function isManagerCapability(driver: { roles: string[]; isAdmin?: boolean }): boolean {
  if (driver.isAdmin === true) return true;
  return driver.roles.some((r) => r === 'manager' || r === 'admin' || r === 'it');
}

export function decideFieldCommandShape(raw: unknown): FieldCommandDecision {
  if (!isPlainObject(raw)) return { ok: false, reason: 'malformed', detail: 'body' };
  const stripped = stripClientIdentity(raw);
  const bytes = Buffer.byteLength(JSON.stringify(stripped), 'utf8');
  if (bytes > FIELD_COMMAND_MAX_BYTES) {
    return { ok: false, reason: 'oversized', detail: String(bytes) };
  }
  const type = stripped.requestType;
  if (type !== 'pull' && type !== 'edit' && type !== 'delete') {
    return { ok: false, reason: 'malformed', detail: 'requestType' };
  }
  const allow = type === 'pull' ? PULL_KEYS : type === 'edit' ? EDIT_KEYS : DELETE_KEYS;
  const extra = hasOnly(stripped, allow);
  if (extra.length) return { ok: false, reason: 'unknown_field', detail: extra.sort().join(',') };

  const packetId = String(stripped.packetId || '');
  if (!PACKET_ID_RE.test(packetId)) return { ok: false, reason: 'malformed', detail: 'packetId' };
  const wellName = String(stripped.wellName || '');
  if (!WELL_NAME_RE.test(wellName)) return { ok: false, reason: 'malformed', detail: 'wellName' };

  if (type !== 'delete') {
    if (typeof stripped.dateTimeUTC !== 'string' || !ISO_RE.test(stripped.dateTimeUTC)) {
      return { ok: false, reason: 'malformed', detail: 'dateTimeUTC' };
    }
    const ts = Date.parse(stripped.dateTimeUTC);
    if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed', detail: 'dateTimeUTC' };
    const skew = ts - Date.now();
    if (skew > 2 * 60 * 60 * 1000 || skew < -14 * 24 * 60 * 60 * 1000) {
      return { ok: false, reason: 'bad_range', detail: 'dateTimeUTC' };
    }
    if (/[.#$\[\]/]/.test(wellName)) return { ok: false, reason: 'malformed', detail: 'wellName' };
    if (!numIn(stripped.tankLevelFeet, 0, 120)) return { ok: false, reason: 'bad_range', detail: 'tankLevelFeet' };
    if (!numIn(stripped.bblsTaken, 0, 8000)) return { ok: false, reason: 'bad_range', detail: 'bblsTaken' };
    if (stripped.timezone !== undefined && (typeof stripped.timezone !== 'string' || stripped.timezone.length > 64)) {
      return { ok: false, reason: 'bad_type', detail: 'timezone' };
    }
    if (stripped.wellDown !== undefined && typeof stripped.wellDown !== 'boolean') {
      return { ok: false, reason: 'bad_type', detail: 'wellDown' };
    }
    if (
      stripped.predictedLevelInches !== undefined &&
      !numIn(stripped.predictedLevelInches, 0, 2000)
    ) {
      return { ok: false, reason: 'bad_range', detail: 'predictedLevelInches' };
    }
    for (const opKey of ['jobType', 'jobOrigin', 'invoicingMode', 'originAppContext'] as const) {
      if (stripped[opKey] !== undefined) {
        if (typeof stripped[opKey] !== 'string' || stripped[opKey].length > 64) {
          return { ok: false, reason: 'bad_type', detail: opKey };
        }
      }
    }
  }
  let originalPacketId: string | undefined;
  if (type !== 'pull') {
    const orig = String(stripped.originalPacketId || '');
    if (!PACKET_ID_RE.test(orig)) return { ok: false, reason: 'malformed', detail: 'originalPacketId' };
    originalPacketId = orig;
  }
  for (const idKey of ['invoiceDocId', 'dispatchId'] as const) {
    if (stripped[idKey] !== undefined) {
      if (typeof stripped[idKey] !== 'string' || stripped[idKey].length < 6 || stripped[idKey].length > 80) {
        return { ok: false, reason: 'malformed', detail: idKey };
      }
    }
  }
  const idem =
    typeof stripped.idempotencyKey === 'string' && stripped.idempotencyKey.length >= 8
      ? stripped.idempotencyKey.slice(0, 80)
      : packetId;
  return { ok: true, type, packetId, idempotencyKey: idem, originalPacketId };
}

/**
 * Fail-closed well assignment.
 * Missing well company metadata is a denial (well_unscoped), never allow.
 * Assigned routes, when present and nonempty, are enforced.
 */
export { decideWellAssignment } from './fieldCommandApply';

export function decideWellDownAuthority(input: {
  wantsWellDown: boolean;
  isManager: boolean;
  existingDown?: boolean;
}): FieldCommandDecision | { ok: true } {
  // Drivers may report a well down. Only a manager may clear an existing down.
  if (input.wantsWellDown === false && input.existingDown === true && !input.isManager) {
    return { ok: false, reason: 'well_down_forbidden', detail: 'driver_cannot_clear' };
  }
  return { ok: true };
}

export function decideOwnership(input: {
  type: FieldCommandType;
  isManager: boolean;
  callerDriverId: string;
  originalDriverId?: string;
}): FieldCommandDecision | { ok: true } {
  if (input.type === 'pull') return { ok: true };
  if (input.isManager) return { ok: true };
  if (!input.originalDriverId || input.originalDriverId !== input.callerDriverId) {
    return { ok: false, reason: 'not_owner', detail: 'packet' };
  }
  return { ok: true };
}

export function decideResourceCompany(input: {
  resourceCompanyId?: string | null;
  driverCompanyId?: string;
}): FieldCommandDecision | { ok: true } {
  if (!input.resourceCompanyId) return { ok: false, reason: 'resource_mismatch', detail: 'missing' };
  if (!input.driverCompanyId || input.resourceCompanyId !== input.driverCompanyId) {
    return { ok: false, reason: 'resource_mismatch', detail: 'company' };
  }
  return { ok: true };
}

async function loadWellCompany(wellName: string): Promise<string | null> {
  const db = admin.database();
  const a = await db.ref(`well_config/${wellName}/companyId`).once('value');
  if (typeof a.val() === 'string' && a.val()) return a.val();
  const clean = wellName.replace(/\s+/g, '');
  const b = await db.ref(`well_config/${clean}/companyId`).once('value');
  return typeof b.val() === 'string' && b.val() ? b.val() : null;
}

async function loadWellConfig(wellName: string): Promise<Record<string, unknown>> {
  const db = admin.database();
  let snap = await db.ref(`well_config/${wellName}`).once('value');
  if (!snap.exists()) {
    snap = await db.ref(`well_config/${wellName.replace(/\s+/g, '')}`).once('value');
  }
  return (snap.val() || {}) as Record<string, unknown>;
}

async function loadResourceCompany(kind: 'invoices' | 'dispatches', id: string): Promise<string | null> {
  const snap = await admin.firestore().collection(kind).doc(id).get();
  if (!snap.exists) return null;
  const cid = snap.get('companyId');
  return typeof cid === 'string' ? cid : null;
}

export function productionFieldApplyStores(): FieldApplyStores {
  const db = () => admin.database();
  const fs = () => admin.firestore();
  return {
    async getProcessed(packetId) {
      const snap = await db().ref(`packets/processed/${packetId}`).once('value');
      if (!snap.exists()) return null;
      return snap.val() as Record<string, unknown>;
    },
    async createProcessedOnly(packetId, data) {
      const result = await db().ref(`packets/processed/${packetId}`).transaction((curr) => {
        if (curr) return;
        return data;
      });
      if (!result.committed) {
        throw new httpsV2.HttpsError('already-exists', 'packet_collision');
      }
    },
    async updateProcessed(packetId, patch) {
      await db().ref(`packets/processed/${packetId}`).update(patch);
    },
    async listProcessedForWell(wellName, companyId) {
      const snap = await db().ref('packets/processed').orderByChild('companyId').equalTo(companyId).once('value');
      const out: Array<{ id: string; data: Record<string, unknown> }> = [];
      snap.forEach((child) => {
        const data = (child.val() || {}) as Record<string, unknown>;
        if (data.wellName === wellName && data.companyId === companyId) {
          out.push({ id: child.key as string, data });
        }
        return false;
      });
      return out;
    },
    async replaceOutgoingForWell(wellName, companyId, responseId, response) {
      const old = await db().ref('packets/outgoing').orderByChild('companyId').equalTo(companyId).once('value');
      const updates: Record<string, unknown> = {};
      old.forEach((child) => {
        const data = (child.val() || {}) as Record<string, unknown>;
        if (child.key && data.wellName === wellName && data.companyId === companyId && child.key !== responseId) {
          updates[`packets/outgoing/${child.key}`] = null;
        }
        return false;
      });
      updates[`packets/outgoing/${responseId}`] = { ...response, companyId, wellName };
      await db().ref().update(updates);
    },
    async incrementIncomingVersion() {
      await db().ref('packets/incoming_version').transaction((curr) => incrementIncomingVersionValue(curr));
    },
    async incrementIncomingVersionOnce(scopeKey: string) {
      const stateRef = db().ref('packets/incoming_version_state');
      const result = await stateRef.transaction((cur) => applyIncomingVersionState(cur, scopeKey).next);
      const next = result.snapshot.val() as { value?: string } | null;
      if (next?.value != null) {
        await db().ref('packets/incoming_version').set(String(next.value));
      }
    },
    async setWellDown(wellName, isDown) {
      await db().ref(`wells/${wellName}/status/isDown`).set(isDown);
    },
    async getWellDown(wellName) {
      const snap = await db().ref(`wells/${wellName}/status/isDown`).once('value');
      return snap.val() === true;
    },
    async getWellConfig(wellName) {
      return loadWellConfig(wellName);
    },
    async updateLinkedInvoice(invoiceId, patch) {
      const ref = fs().collection('invoices').doc(invoiceId);
      const snap = await ref.get();
      if (!snap.exists) throw Object.assign(new Error('linked_missing'), { code: 'linked_missing' });
      const prev = snap.data() || {};
      if (prev.companyId !== patch.companyId) {
        throw Object.assign(new Error('linked_mismatch'), { code: 'linked_mismatch' });
      }
      await ref.set({
        tankLevelFeet: patch.tankLevelFeet,
        bblsTaken: patch.bblsTaken,
        dateTimeUTC: patch.dateTimeUTC,
        lastPullPacketId: patch.lastPullPacketId,
        lastPullDeleted: patch.lastPullDeleted === true,
      }, { merge: true });
    },
    async updateLinkedDispatch(dispatchId, patch) {
      const ref = fs().collection('dispatches').doc(dispatchId);
      const snap = await ref.get();
      if (!snap.exists) throw Object.assign(new Error('linked_missing'), { code: 'linked_missing' });
      const prev = snap.data() || {};
      if (prev.companyId !== patch.companyId) {
        throw Object.assign(new Error('linked_mismatch'), { code: 'linked_mismatch' });
      }
      await ref.set({
        tankLevelFeet: patch.tankLevelFeet,
        bblsTaken: patch.bblsTaken,
        lastPullPacketId: patch.lastPullPacketId,
        lastPullDeleted: patch.lastPullDeleted === true,
      }, { merge: true });
    },
    async updateLinkedTicket(ticketId, patch) {
      const ref = fs().collection('tickets').doc(ticketId);
      const snap = await ref.get();
      if (!snap.exists) throw Object.assign(new Error('linked_missing'), { code: 'linked_missing' });
      const prev = snap.data() || {};
      if (prev.companyId !== patch.companyId) {
        throw Object.assign(new Error('linked_mismatch'), { code: 'linked_mismatch' });
      }
      await ref.set({
        tankLevelFeet: patch.tankLevelFeet,
        bblsTaken: patch.bblsTaken,
        lastPullPacketId: patch.lastPullPacketId,
        lastPullDeleted: patch.lastPullDeleted === true,
      }, { merge: true });
    },
    async getLinkedInvoice(invoiceId) {
      const snap = await fs().collection('invoices').doc(invoiceId).get();
      return snap.exists ? (snap.data() as Record<string, unknown>) : null;
    },
    async getLinkedDispatch(dispatchId) {
      const snap = await fs().collection('dispatches').doc(dispatchId).get();
      return snap.exists ? (snap.data() as Record<string, unknown>) : null;
    },
    async getLinkedTicket(ticketId) {
      const snap = await fs().collection('tickets').doc(ticketId).get();
      return snap.exists ? (snap.data() as Record<string, unknown>) : null;
    },
    async patchOutgoing(outgoingId, patch) {
      await db().ref(`packets/outgoing/${outgoingId}`).update(patch);
    },
    async getOutgoing(outgoingId) {
      const snap = await db().ref(`packets/outgoing/${outgoingId}`).once('value');
      return snap.exists() ? (snap.val() as Record<string, unknown>) : null;
    },
    async transactProcessed(packetId, apply) {
      let snapshot: Record<string, unknown> | null = null;
      const result = await db().ref(`packets/processed/${packetId}`).transaction((curr) => {
        const next = apply(curr && typeof curr === 'object' ? { ...curr } : curr);
        if (next === undefined) return;
        snapshot = next;
        return next;
      });
      const val = result.snapshot.exists() ? (result.snapshot.val() as Record<string, unknown>) : null;
      return { committed: result.committed === true && snapshot != null, snapshot: val };
    },
    async transactOutgoing(outgoingId, apply) {
      let snapshot: Record<string, unknown> | null = null;
      const result = await db().ref(`packets/outgoing/${outgoingId}`).transaction((curr) => {
        const next = apply(curr && typeof curr === 'object' ? { ...curr } : curr);
        if (next === undefined) return;
        snapshot = next;
        return next;
      });
      const val = result.snapshot.exists() ? (result.snapshot.val() as Record<string, unknown>) : null;
      return { committed: result.committed === true && snapshot != null, snapshot: val };
    },
  };
}

function firestorePersistTxn(): PersistTxn {
  const db = admin.firestore();
  const direct: Omit<PersistTxn, 'runAtomic'> = {
    async get(path) {
      const snap = await db.doc(path).get();
      return snap.exists ? (snap.data() as Record<string, unknown>) : null;
    },
    async set(path, data) {
      await db.doc(path).set(data);
    },
    async update(path, data) {
      await db.doc(path).set(data, { merge: true });
    },
    async delete(path) {
      await db.doc(path).delete();
    },
  };
  return {
    ...direct,
    async runAtomic(fn) {
      return db.runTransaction(async (tx) => {
        const inner: PersistTxn = {
          async get(path) {
            const snap = await tx.get(db.doc(path));
            return snap.exists ? (snap.data() as Record<string, unknown>) : null;
          },
          async set(path, data) {
            tx.set(db.doc(path), data);
          },
          async update(path, data) {
            tx.set(db.doc(path), data, { merge: true });
          },
          async delete(path) {
            tx.delete(db.doc(path));
          },
          async runAtomic(innerFn) {
            return innerFn(inner);
          },
        };
        return fn(inner);
      });
    },
  };
}

export const submitFieldCommand = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as Record<string, unknown>;
    if (data.driverHash != null) {
      throw new httpsV2.HttpsError('permission-denied', 'legacy_hash_rejected');
    }
    const shape = decideFieldCommandShape(data);
    if (!shape.ok) {
      throw new httpsV2.HttpsError('invalid-argument', shape.reason);
    }

    const driver = await requireSecureDriver(request);
    const ip =
      (request.rawRequest?.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      request.rawRequest?.ip;
    const allowed = await checkRateLimit({
      bucket: `field_${shape.type}`,
      key: `${driver.driverId}:${hashIp(ip)}`,
      limit: 40,
      windowMs: 10 * 60 * 1000,
    });
    if (!allowed) {
      throw new httpsV2.HttpsError('resource-exhausted', 'rate_limited');
    }

    const manager = isManagerCapability({
      roles: driver.roles,
      isAdmin: driver.isAdmin === true || driver.roles.includes('admin'),
    });

    const wellName = String(data.wellName);
    const wellCompanyId = await loadWellCompany(wellName);
    const wellCfg = await loadWellConfig(wellName);
    const wellRoute = typeof wellCfg.route === 'string' ? wellCfg.route : null;
    const wellOk = decideWellAssignment({
      driverCompanyId: driver.companyId,
      wellCompanyId,
      assignedRoutes: driver.assignedRoutes,
      assignedWells: driver.assignedWells,
      wellName,
      wellRoute,
    });
    if (!wellOk.ok) throw new httpsV2.HttpsError('permission-denied', wellOk.reason);

    const operational = stripClientIdentity(data);

    if (typeof operational.invoiceDocId === 'string') {
      const invCo = await loadResourceCompany('invoices', operational.invoiceDocId);
      const chk = decideResourceCompany({ resourceCompanyId: invCo, driverCompanyId: driver.companyId });
      if (!chk.ok) throw new httpsV2.HttpsError('permission-denied', chk.reason);
    }
    if (typeof operational.dispatchId === 'string') {
      const dCo = await loadResourceCompany('dispatches', operational.dispatchId);
      const chk = decideResourceCompany({ resourceCompanyId: dCo, driverCompanyId: driver.companyId });
      if (!chk.ok) throw new httpsV2.HttpsError('permission-denied', chk.reason);
    }

    if (operational.wellDown === true) {
      const wd = decideWellDownAuthority({ wantsWellDown: true, isManager: manager });
      if (!wd.ok) throw new httpsV2.HttpsError('permission-denied', wd.reason);
    }

    if (shape.type !== 'pull') {
      const origId = String(operational.originalPacketId);
      const orig = await admin.database().ref(`packets/processed/${origId}`).once('value');
      if (!orig.exists()) {
        throw new httpsV2.HttpsError('permission-denied', 'not_owner');
      }
      const own = decideOwnership({
        type: shape.type,
        isManager: manager,
        callerDriverId: driver.driverId,
        originalDriverId: orig.val()?.driverId,
      });
      if (!own.ok) throw new httpsV2.HttpsError('permission-denied', own.reason);
      const origCo = orig.val()?.companyId;
      const co = decideResourceCompany({
        resourceCompanyId: typeof origCo === 'string' ? origCo : null,
        driverCompanyId: driver.companyId,
      });
      if (!co.ok) throw new httpsV2.HttpsError('permission-denied', co.reason);
    }

    const companyId = driver.companyId;
    const targetPacketId = shape.type === 'pull' ? shape.packetId : String(shape.originalPacketId);
    const digest = contentDigest({
      type: shape.type,
      targetPacketId,
      wellName,
      tankLevelFeet: operational.tankLevelFeet ?? null,
      bblsTaken: operational.bblsTaken ?? null,
      dateTimeUTC: operational.dateTimeUTC ?? null,
      dateTime: operational.dateTime ?? null,
      timezone: operational.timezone ?? null,
      wellDown: operational.wellDown ?? null,
      predictedLevelInches: operational.predictedLevelInches ?? null,
      invoiceDocId: operational.invoiceDocId ?? null,
      dispatchId: operational.dispatchId ?? null,
      jobType: operational.jobType ?? null,
      jobOrigin: operational.jobOrigin ?? null,
      invoicingMode: operational.invoicingMode ?? null,
      originAppContext: operational.originAppContext ?? null,
    });
    const scopeKey = canonicalReceiptKey({
      companyId,
      type: shape.type,
      targetPacketId,
      digest,
    });
    const stores = productionFieldApplyStores();
    const receiptRef = admin.firestore().collection('field_command_receipts').doc(scopeKey);
    const attemptToken = newAttemptToken();
    const lease = await admin.firestore().runTransaction(async (tx) => {
      const snap = await tx.get(receiptRef);
      const existing: FieldReceipt = snap.exists
        ? {
            exists: true,
            ...(snap.data() as Omit<FieldReceipt, 'exists'>),
          }
        : { exists: false };
      const dec = decideLease(existing, {
        driverId: driver.driverId,
        companyId,
        type: shape.type,
        targetPacketId,
        digest,
        nowMs: Date.now(),
      });
      if (dec.action === 'collision') {
        throw new httpsV2.HttpsError('already-exists', 'idempotency_collision');
      }
      if (dec.action === 'duplicate') {
        return { duplicate: true as const, receipt: existing };
      }
      // committed-without-markers and applied/recoverable resume here.
      const nextReceipt: FieldReceipt = {
        exists: true,
        driverId: driver.driverId,
        companyId,
        type: shape.type,
        targetPacketId,
        digest,
        status: existing.status === 'applied' || existing.status === 'committed'
          ? existing.status
          : existing.status === 'recoverable'
            ? 'recoverable'
            : 'leased',
        leaseOwner: attemptToken,
        attemptToken,
        leaseUntil: Date.now() + FIELD_COMMAND_LEASE_MS,
        outgoingId: existing.outgoingId,
        wellDown: existing.wellDown,
        versionIncremented: existing.versionIncremented,
        markersPublished: existing.markersPublished,
        doneEffects: existing.doneEffects || {},
        healCode: existing.healCode,
      };
      tx.set(receiptRef, {
        driverId: nextReceipt.driverId,
        companyId: nextReceipt.companyId,
        type: nextReceipt.type,
        targetPacketId: nextReceipt.targetPacketId,
        digest: nextReceipt.digest,
        status: nextReceipt.status,
        leaseOwner: nextReceipt.leaseOwner,
        attemptToken: nextReceipt.attemptToken,
        leaseUntil: nextReceipt.leaseUntil,
        outgoingId: nextReceipt.outgoingId || null,
        wellDown: nextReceipt.wellDown === true,
        versionIncremented: nextReceipt.versionIncremented === true,
        markersPublished: nextReceipt.markersPublished === true,
        doneEffects: nextReceipt.doneEffects || {},
      }, { merge: true });
      return { duplicate: false as const, receipt: nextReceipt };
    });
    if (lease.duplicate) {
      const prior = (await receiptRef.get()).data() || {};
      return {
        ok: true,
        packetId: shape.packetId,
        duplicate: true,
        committed: true,
        outgoingId: prior.outgoingId || null,
        targetPacketId,
        wellDown: prior.wellDown === true,
      };
    }

    const lockKey = targetLockKey({ companyId, targetPacketId });
    const stamped = stampCommand(shape.type, operational, driver, manager);
    let applied;
    try {
      applied = await runFieldCommandPipeline(
        stores,
        firestorePersistTxn(),
        {
          receiptPath: `field_command_receipts/${scopeKey}`,
          lockPath: `field_command_locks/${lockKey}`,
        },
        {
          type: shape.type,
          packetId: shape.packetId,
          originalPacketId: shape.originalPacketId,
          stamped,
          driver,
          manager,
          receiptKey: scopeKey,
          attemptToken,
          nowFn: () => Date.now(),
        },
      );
    } catch (err) {
      const code = (err as { code?: string }).code || (err as Error).message;
      if (code === 'target_locked' || code === 'stale_fence') {
        throw new httpsV2.HttpsError('already-exists', code);
      }
      throw err;
    }

    if (applied.recoverable) {
      return {
        ok: false,
        recoverable: true,
        committed: false,
        healCode: applied.healCode || 'recoverable',
        packetId: shape.packetId,
        outgoingId: applied.outgoingId,
        targetPacketId: applied.targetPacketId,
        wellDown: applied.wellDown,
      };
    }

    await writeSecurityAudit({
      action: 'submitFieldCommand',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: {
        type: shape.type,
        packetId: shape.packetId,
        outgoingId: applied.outgoingId,
        targetPacketId: applied.targetPacketId,
        wellDown: applied.wellDown,
        committed: applied.committed === true,
      },
    });
    return {
      ok: true,
      packetId: shape.packetId,
      duplicate: applied.duplicate === true,
      committed: applied.committed === true,
      outgoingId: applied.outgoingId,
      targetPacketId: applied.targetPacketId,
      wellDown: applied.wellDown,
    };
  },
);

function stampCommand(
  type: FieldCommandType,
  data: Record<string, unknown>,
  driver: SecureDriver,
  manager: boolean,
): Record<string, unknown> {
  return {
    requestType: type,
    packetId: data.packetId,
    originalPacketId: data.originalPacketId || null,
    wellName: data.wellName,
    dateTimeUTC: data.dateTimeUTC || null,
    dateTime: data.dateTime || null,
    timezone: data.timezone || null,
    tankLevelFeet: data.tankLevelFeet ?? null,
    bblsTaken: data.bblsTaken ?? null,
    ...(typeof data.wellDown === 'boolean' ? { wellDown: data.wellDown } : {}),
    predictedLevelInches: data.predictedLevelInches ?? null,
    invoiceDocId: data.invoiceDocId || null,
    dispatchId: data.dispatchId || null,
    jobType: data.jobType || null,
    jobOrigin: data.jobOrigin || null,
    invoicingMode: data.invoicingMode || null,
    originAppContext: data.originAppContext || null,
    driverId: driver.driverId,
    driverName: driver.displayName || null,
    companyId: driver.companyId || null,
    roles: driver.roles,
    ingestedAt: Date.now(),
    ingestedBy: driver.uid,
    authSource: 'claims',
    processedBy: 'submitFieldCommand',
    managerCapability: manager,
  };
}

export const getFieldCommandStatus = httpsV2.onCall(
  { timeoutSeconds: 15, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    if ((request.data as { driverHash?: unknown } | undefined)?.driverHash != null) {
      throw new httpsV2.HttpsError('permission-denied', 'legacy_hash_rejected');
    }
    const driver = await requireSecureDriver(request);
    const packetId = String((request.data as { packetId?: string } | undefined)?.packetId || '');
    if (!PACKET_ID_RE.test(packetId)) {
      throw new httpsV2.HttpsError('invalid-argument', 'malformed');
    }
    const snap = await admin.firestore().collection('field_command_receipts')
      .where('companyId', '==', driver.companyId)
      .where('targetPacketId', '==', packetId)
      .limit(5)
      .get();
    const receipts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return { ok: true, receipts };
  },
);

export { incrementIncomingVersionValue };
export { outgoingResponseId } from './fieldCommandApply';
export { canonicalReceiptKey, contentDigest, decideLease } from './fieldCommandLease';
