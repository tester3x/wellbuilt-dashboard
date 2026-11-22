import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
} from './trustedStaffAuthority';
import { externalDeliveryProvider } from './externalDeliveryProvider';
import { externalDriverAccessMode, OUTSIDE_DRIVER_ACCESS_COLLECTION } from './operational/outsideDriverAccess';
import {
  applyExternalProviderResult,
  deliveryIdForKey,
  hashExternalDeliveryKey,
  parseExternalDriverWrite,
  planExternalAssignmentCancellation,
  planExternalAssignmentRevision,
  validateIdempotencyKey,
  type ExternalDeliveryChannel,
  type ExternalDeliveryRevision,
  type ExternalDeliveryRoot,
  type ExternalDriverRecord,
} from './operational/externalAssignmentDelivery';

const ROOT_COLLECTION = 'external_assignment_deliveries';
const ROSTER_COLLECTION = 'external_drivers';
const ALLOWED_KEYS = new Set([
  'op',
  'driver',
  'dispatchId',
  'deliveryId',
  'externalDriverId',
  'channel',
  'idempotencyKey',
]);

type CallableFailure = { ok: false; reason: string; field?: string };

function throwFailure(result: CallableFailure): never {
  const message = result.field ? `${result.reason}:${result.field}` : result.reason;
  if (result.reason === 'cross_company' || result.reason === 'missing_required_capability') {
    throw new httpsV2.HttpsError('permission-denied', message);
  }
  if (result.reason.endsWith('_not_found')) throw new httpsV2.HttpsError('not-found', message);
  if (result.reason === 'idempotency_conflict') throw new httpsV2.HttpsError('already-exists', message);
  throw new httpsV2.HttpsError('failed-precondition', message);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asChannel(value: unknown): ExternalDeliveryChannel | null {
  return value === 'sms' || value === 'whatsapp' ? value : null;
}

function rosterRef(fs: FirebaseFirestore.Firestore, companyId: string, externalDriverId: string) {
  return fs.collection('companies').doc(companyId).collection(ROSTER_COLLECTION).doc(externalDriverId);
}

function parseStoredDriver(raw: FirebaseFirestore.DocumentData | undefined): ExternalDriverRecord | null {
  if (!raw) return null;
  const channels = Array.isArray(raw.channels)
    ? raw.channels.filter((channel: unknown) => channel === 'sms' || channel === 'whatsapp')
    : [];
  if (
    typeof raw.externalDriverId !== 'string'
    || typeof raw.companyId !== 'string'
    || typeof raw.displayName !== 'string'
    || typeof raw.phoneE164 !== 'string'
    || typeof raw.active !== 'boolean'
    || (raw.phoneE164 === '' && channels.length > 0)
  ) return null;
  return { ...raw, channels } as ExternalDriverRecord;
}

function parseStoredRoot(raw: FirebaseFirestore.DocumentData | undefined): ExternalDeliveryRoot | null {
  if (!raw) return null;
  if (
    raw.schemaVersion !== 1
    || typeof raw.deliveryId !== 'string'
    || typeof raw.companyId !== 'string'
    || typeof raw.dispatchId !== 'string'
    || typeof raw.currentRevision !== 'number'
    || !['queued', 'sent', 'delivered', 'accepted', 'declined', 'failed'].includes(raw.currentStatus)
    || !['active', 'cancelled'].includes(raw.assignmentState)
    || typeof raw.externalDriverId !== 'string'
    || !['sms', 'whatsapp'].includes(raw.channel)
    || typeof raw.lastIdempotencyKeyHash !== 'string'
    || typeof raw.updatedAt !== 'string'
    || typeof raw.updatedBy !== 'string'
  ) return null;
  return raw as ExternalDeliveryRoot;
}

async function finalizeProviderAttempt(input: {
  fs: FirebaseFirestore.Firestore;
  revision: ExternalDeliveryRevision;
  driver: ExternalDriverRecord;
}): Promise<ExternalDeliveryRevision> {
  const provider = externalDeliveryProvider();
  const result = await provider.send({
    deliveryId: input.revision.deliveryId,
    revision: input.revision.revision,
    channel: input.revision.channel,
    phoneE164: input.driver.phoneE164,
    dispatchId: input.revision.dispatchId,
  });
  const at = new Date().toISOString();
  const finalized = applyExternalProviderResult(input.revision, result.kind === 'sent'
    ? { kind: 'sent', at, providerMessageId: result.providerMessageId }
    : result.kind === 'failed'
      ? { kind: 'failed', at, code: result.code }
      : { kind: 'unconfigured', at });
  const rootRef = input.fs.collection(ROOT_COLLECTION).doc(finalized.deliveryId);
  const revisionRef = rootRef.collection('revisions').doc(String(finalized.revision));
  await input.fs.runTransaction(async tx => {
    const currentSnap = await tx.get(rootRef);
    const current = parseStoredRoot(currentSnap.data());
    if (!current || current.currentRevision !== finalized.revision || current.currentStatus !== 'queued') return;
    tx.set(revisionRef, finalized);
    tx.update(rootRef, {
      currentStatus: finalized.status,
      updatedAt: at,
      failureCode: finalized.failureCode || admin.firestore.FieldValue.delete(),
    });
  });
  return finalized;
}

export const staffExternalAssignmentDelivery = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const authority = await requireTrustedCompanyCapability(
      request.auth?.uid,
      TRUSTED_CAPABILITY_MANAGE_DRIVERS,
    );
    const raw = (request.data && typeof request.data === 'object' && !Array.isArray(request.data))
      ? request.data as Record<string, unknown>
      : {};
    const unexpected = Object.keys(raw).find(key => !ALLOWED_KEYS.has(key));
    if (unexpected) throw new httpsV2.HttpsError('invalid-argument', `unexpected_field:${unexpected}`);
    const op = text(raw.op);
    const fs = admin.firestore();
    // The company ID comes only from trusted staff authority. Package assignment
    // is an operational entitlement independent of the commercial subscription tier.
    const [companySnap, accessSnap] = await Promise.all([
      fs.collection('companies').doc(authority.companyId).get(),
      fs.collection(OUTSIDE_DRIVER_ACCESS_COLLECTION).doc(authority.companyId).get(),
    ]);
    const accessMode = externalDriverAccessMode(companySnap.data(), accessSnap.data());
    if (op === 'getAccess') return { ok: true, enabled: accessMode !== null, mode: accessMode, companyId: authority.companyId };
    if (!accessMode) {
      throw new httpsV2.HttpsError('permission-denied', 'external_driver_access_inactive');
    }

    if (op === 'listRoster') {
      const snap = await fs.collection('companies').doc(authority.companyId).collection(ROSTER_COLLECTION).get();
      return {
        ok: true,
        drivers: snap.docs.map(doc => parseStoredDriver(doc.data())).filter(Boolean),
      };
    }

    if (op === 'upsertDriver') {
      const parsed = parseExternalDriverWrite(raw.driver, authority.companyId);
      if (!parsed.ok) throwFailure(parsed);
      const nowIso = new Date().toISOString();
      await rosterRef(fs, authority.companyId, parsed.externalDriverId).set({
        ...parsed,
        companyId: authority.companyId,
        updatedAt: nowIso,
        updatedBy: authority.uid,
      }, { merge: true });
      return { ok: true, driver: { ...parsed, companyId: authority.companyId } };
    }

    if (op === 'listDeliveries') {
      const snap = await fs.collection(ROOT_COLLECTION)
        .where('companyId', '==', authority.companyId)
        .limit(100)
        .get();
      const deliveries = snap.docs
        .map(doc => parseStoredRoot(doc.data()))
        .filter((row): row is ExternalDeliveryRoot => row !== null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { ok: true, deliveries };
    }

    const idempotency = validateIdempotencyKey(raw.idempotencyKey);
    if (!idempotency.ok) throwFailure(idempotency);
    const suppliedDeliveryId = text(raw.deliveryId);

    if (op === 'cancel') {
      if (!suppliedDeliveryId) throwFailure({ ok: false, reason: 'delivery_not_found', field: 'deliveryId' });
      const outcome = await fs.runTransaction(async tx => {
        const ref = fs.collection(ROOT_COLLECTION).doc(suppliedDeliveryId);
        const snap = await tx.get(ref);
        const existing = parseStoredRoot(snap.data());
        if (!existing) throwFailure({ ok: false, reason: 'delivery_not_found', field: 'deliveryId' });
        const keyHash = hashExternalDeliveryKey(authority.companyId, idempotency.key);
        if (existing.companyId === authority.companyId && existing.lastIdempotencyKeyHash === keyHash) {
          return { idempotent: true as const, root: existing };
        }
        const planned = planExternalAssignmentCancellation({
          existing,
          companyId: authority.companyId,
          actorUid: authority.uid,
          nowIso: new Date().toISOString(),
          idempotencyKey: idempotency.key,
        });
        if (!planned.ok) throwFailure(planned);
        tx.set(ref.collection('revisions').doc(String(planned.revision.revision)), planned.revision);
        tx.set(ref, planned.root);
        return { idempotent: false as const, root: planned.root };
      });
      return { ok: true, ...outcome };
    }

    if (!['queue', 'retry', 'reassign'].includes(op)) {
      throw new httpsV2.HttpsError('invalid-argument', 'op must be listRoster, upsertDriver, listDeliveries, queue, retry, reassign, or cancel');
    }
    const dispatchId = text(raw.dispatchId);
    const externalDriverId = text(raw.externalDriverId);
    const channel = asChannel(raw.channel);
    if (!dispatchId) throwFailure({ ok: false, reason: 'invalid_dispatch_id', field: 'dispatchId' });
    if (!externalDriverId) throwFailure({ ok: false, reason: 'external_driver_not_found', field: 'externalDriverId' });
    if (!channel) throwFailure({ ok: false, reason: 'invalid_channel', field: 'channel' });
    const targetDeliveryId = op === 'queue'
      ? deliveryIdForKey(authority.companyId, idempotency.key)
      : suppliedDeliveryId;
    if (!targetDeliveryId) throwFailure({ ok: false, reason: 'delivery_not_found', field: 'deliveryId' });

    const planned = await fs.runTransaction(async tx => {
      const rootRef = fs.collection(ROOT_COLLECTION).doc(targetDeliveryId);
      const dispatchRef = fs.collection('dispatches').doc(dispatchId);
      const driverDocRef = rosterRef(fs, authority.companyId, externalDriverId);
      const [rootSnap, dispatchSnap, driverSnap] = await Promise.all([
        tx.get(rootRef),
        tx.get(dispatchRef),
        tx.get(driverDocRef),
      ]);
      const existing = parseStoredRoot(rootSnap.data());
      const keyHash = hashExternalDeliveryKey(authority.companyId, idempotency.key);
      if (existing && existing.companyId === authority.companyId && existing.lastIdempotencyKeyHash === keyHash) {
        return { idempotent: true as const, root: existing, revision: null, driver: null };
      }
      if (op === 'queue' && existing) throwFailure({ ok: false, reason: 'idempotency_conflict', field: 'idempotencyKey' });
      if (op !== 'queue' && !existing) throwFailure({ ok: false, reason: 'delivery_not_found', field: 'deliveryId' });
      const dispatch = dispatchSnap.exists ? dispatchSnap.data() : null;
      if (!dispatch) throwFailure({ ok: false, reason: 'dispatch_not_found', field: 'dispatchId' });
      if (dispatch.companyId !== authority.companyId) throwFailure({ ok: false, reason: 'cross_company', field: 'dispatchId' });
      if (existing && existing.dispatchId !== dispatchId) throwFailure({ ok: false, reason: 'dispatch_immutable', field: 'dispatchId' });
      const driver = parseStoredDriver(driverSnap.data());
      if (!driver) throwFailure({ ok: false, reason: 'external_driver_not_found', field: 'externalDriverId' });
      const result = planExternalAssignmentRevision({
        companyId: authority.companyId,
        actorUid: authority.uid,
        nowIso: new Date().toISOString(),
        idempotencyKey: idempotency.key,
        dispatchId,
        externalDriver: driver,
        channel,
        action: op === 'queue' ? 'assigned' : op === 'retry' ? 'retried' : 'reassigned',
        existing,
      });
      if (!result.ok) throwFailure(result);
      tx.set(rootRef, result.root);
      tx.set(rootRef.collection('revisions').doc(String(result.revision.revision)), result.revision);
      return { idempotent: false as const, root: result.root, revision: result.revision, driver };
    });

    if (planned.idempotent || !planned.revision || !planned.driver) {
      return { ok: true, idempotent: true, delivery: planned.root };
    }
    const finalized = await finalizeProviderAttempt({ fs, revision: planned.revision, driver: planned.driver });
    return {
      ok: true,
      idempotent: false,
      delivery: {
        ...planned.root,
        currentStatus: finalized.status,
        failureCode: finalized.failureCode,
      },
      provider: finalized.failureCode === 'provider_unconfigured'
        ? { configured: false, sent: false, reason: 'provider_unconfigured' }
        : { configured: true, sent: finalized.status === 'sent' },
    };
  },
);
