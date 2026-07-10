import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireDriver } from '../auth/requireDriver';
import { driverDocumentImagePath } from '../storage/paths';
import { ActorRef, DriverActor, DriverProfile } from '../types/actor';
import { buildMetadata, RecordMetadata } from '../types/metadata';

const firestore = admin.firestore();
const storage = admin.storage();
const COLLECTION = 'driver_documents';

const DOCUMENT_TYPES = new Set([
  'cdl', 'medical_card', 'insurance', 'registration', 'dot_inspection',
  'hazmat_cert', 'twic_card', 'ifta_permit', 'drug_test', 'training_cert', 'other',
]);

export type DriverDocumentAction =
  | 'driver.upsert'
  | 'driver.delete'
  | 'driver.list'
  | 'driver.uploadImage';

export interface DocumentRequest {
  actor: DriverActor;
  action: DriverDocumentAction;
  payload?: Record<string, unknown>;
}

interface ServiceContext {
  action: DriverDocumentAction;
  actor: DriverActor;
  driver: DriverProfile;
  actorRef: ActorRef;
  payload: Record<string, unknown>;
}

interface DriverDocumentRecord {
  id: string;
  driverHash: string;
  companyId?: string;
  type: string;
  label: string;
  cloudUri?: string;
  storagePath?: string;
  expirationDate?: string;
  issuedDate?: string;
  documentNumber?: string;
  state?: string;
  notes?: string;
  personal?: boolean;
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
  createdBy: ActorRef;
  updatedBy: ActorRef;
}

// ── Service pipeline ───────────────────────────────────────────────────────

export async function handleDocumentRequest(req: DocumentRequest): Promise<unknown> {
  const ctx = validate(req);
  await authorize(ctx);
  const result = await execute(ctx);
  await emitEvents(ctx, result);
  return returnResult(result);
}

function validate(req: DocumentRequest): ServiceContext {
  if (!req?.actor || req.actor.type !== 'driver') {
    throw new httpsV2.HttpsError('invalid-argument', 'actor.type must be "driver"');
  }
  if (!req.action || !req.action.startsWith('driver.')) {
    throw new httpsV2.HttpsError('invalid-argument', 'Unsupported document action');
  }

  const action = req.action as DriverDocumentAction;
  const allowed: DriverDocumentAction[] = [
    'driver.upsert', 'driver.delete', 'driver.list', 'driver.uploadImage',
  ];
  if (!allowed.includes(action)) {
    throw new httpsV2.HttpsError('invalid-argument', `Unknown action: ${action}`);
  }

  return {
    action,
    actor: req.actor,
    driver: { driverHash: req.actor.driverHash, displayName: '' },
    actorRef: { type: 'driver', driverHash: req.actor.driverHash.trim().toLowerCase() },
    payload: req.payload || {},
  };
}

async function authorize(ctx: ServiceContext): Promise<void> {
  ctx.driver = await requireDriver(ctx.actor);
  ctx.actorRef = {
    type: 'driver',
    driverHash: ctx.driver.driverHash,
    displayName: ctx.driver.displayName,
  };
}

async function execute(ctx: ServiceContext): Promise<unknown> {
  switch (ctx.action) {
    case 'driver.list':
      return listDriverDocuments(ctx);
    case 'driver.uploadImage':
      return uploadDriverImage(ctx);
    case 'driver.upsert':
      return upsertDriverDocument(ctx);
    case 'driver.delete':
      return deleteDriverDocument(ctx);
    default:
      throw new httpsV2.HttpsError('invalid-argument', `Unhandled action: ${ctx.action}`);
  }
}

async function emitEvents(_ctx: ServiceContext, _result: unknown): Promise<void> {
  // Reserved for notification fan-out (defect/DVIR phases).
}

function returnResult(result: unknown): unknown {
  return { ok: true, ...(typeof result === 'object' && result !== null ? result : { data: result }) };
}

// ── Business operations ──────────────────────────────────────────────────────

async function listDriverDocuments(ctx: ServiceContext): Promise<{ documents: DriverDocumentRecord[] }> {
  const snap = await firestore.collection(COLLECTION)
    .where('driverHash', '==', ctx.driver.driverHash)
    .orderBy('updatedAt', 'desc')
    .get();

  const documents = snap.docs.map(d => d.data() as DriverDocumentRecord);
  return { documents };
}

async function uploadDriverImage(ctx: ServiceContext): Promise<{ cloudUri: string; storagePath: string }> {
  const docId = String(ctx.payload.docId || '');
  const imageBase64 = String(ctx.payload.imageBase64 || '');

  if (!docId) {
    throw new httpsV2.HttpsError('invalid-argument', 'docId is required');
  }
  if (!imageBase64) {
    throw new httpsV2.HttpsError('invalid-argument', 'imageBase64 is required');
  }

  const buffer = Buffer.from(imageBase64, 'base64');
  if (buffer.length > 8 * 1024 * 1024) {
    throw new httpsV2.HttpsError('invalid-argument', 'Image exceeds 8MB limit');
  }

  const storagePath = driverDocumentImagePath(ctx.driver.driverHash, docId);
  const bucket = storage.bucket();
  const file = bucket.file(storagePath);
  const downloadToken = crypto.randomUUID();
  await file.save(buffer, {
    contentType: 'image/jpeg',
    resumable: false,
    metadata: {
      metadata: { firebaseStorageDownloadTokens: downloadToken },
    },
  });
  const encodedPath = encodeURIComponent(storagePath);
  const cloudUri = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;

  return { cloudUri, storagePath };
}

async function upsertDriverDocument(ctx: ServiceContext): Promise<{ document: DriverDocumentRecord }> {
  const doc = ctx.payload.document as Record<string, unknown> | undefined;
  if (!doc || typeof doc !== 'object') {
    throw new httpsV2.HttpsError('invalid-argument', 'document payload is required');
  }

  const id = String(doc.id || '');
  const driverHash = String(doc.driverHash || '').trim().toLowerCase();
  const type = String(doc.type || '');
  const label = String(doc.label || '');

  if (!id) throw new httpsV2.HttpsError('invalid-argument', 'document.id is required');
  if (driverHash !== ctx.driver.driverHash) {
    throw new httpsV2.HttpsError('permission-denied', 'document.driverHash must match authenticated driver');
  }
  if (!DOCUMENT_TYPES.has(type)) {
    throw new httpsV2.HttpsError('invalid-argument', `Invalid document type: ${type}`);
  }
  if (!label) {
    throw new httpsV2.HttpsError('invalid-argument', 'document.label is required');
  }

  const ref = firestore.collection(COLLECTION).doc(id);
  const existing = await ref.get();
  const existingData = existing.exists ? existing.data() as DriverDocumentRecord : undefined;

  if (existingData && existingData.driverHash !== ctx.driver.driverHash) {
    throw new httpsV2.HttpsError('permission-denied', 'Cannot modify another driver\'s document');
  }

  const now = new Date().toISOString();
  const meta = buildMetadata(ctx.actorRef, existingData as Partial<RecordMetadata> | undefined);
  const cloudUri = doc.cloudUri ? String(doc.cloudUri) : existingData?.cloudUri;
  const storagePath = doc.storagePath
    ? String(doc.storagePath)
    : (cloudUri ? driverDocumentImagePath(ctx.driver.driverHash, id) : existingData?.storagePath);

  const record: DriverDocumentRecord = {
    id,
    driverHash: ctx.driver.driverHash,
    companyId: doc.companyId ? String(doc.companyId) : (ctx.driver.companyId || existingData?.companyId),
    type,
    label,
    cloudUri: cloudUri || undefined,
    storagePath: storagePath || undefined,
    expirationDate: optionalString(doc.expirationDate) ?? existingData?.expirationDate,
    issuedDate: optionalString(doc.issuedDate) ?? existingData?.issuedDate,
    documentNumber: optionalString(doc.documentNumber) ?? existingData?.documentNumber,
    state: optionalString(doc.state) ?? existingData?.state,
    notes: optionalString(doc.notes) ?? existingData?.notes,
    personal: doc.personal === true,
    syncedAt: now,
    createdAt: existingData?.createdAt || doc.createdAt ? String(doc.createdAt || existingData?.createdAt) : meta.createdAt,
    updatedAt: doc.updatedAt ? String(doc.updatedAt) : now,
    createdBy: meta.createdBy,
    updatedBy: meta.updatedBy,
  };

  await ref.set(record, { merge: false });
  return { document: record };
}

async function deleteDriverDocument(ctx: ServiceContext): Promise<{ deleted: boolean }> {
  const docId = String(ctx.payload.docId || '');
  if (!docId) {
    throw new httpsV2.HttpsError('invalid-argument', 'docId is required');
  }

  const ref = firestore.collection(COLLECTION).doc(docId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { deleted: true };
  }

  const data = snap.data() as DriverDocumentRecord;
  if (data.driverHash !== ctx.driver.driverHash) {
    throw new httpsV2.HttpsError('permission-denied', 'Cannot delete another driver\'s document');
  }

  await ref.delete();

  if (data.storagePath) {
    await storage.bucket().file(data.storagePath).delete().catch(() => {});
  } else {
    await storage.bucket().file(driverDocumentImagePath(ctx.driver.driverHash, docId)).delete().catch(() => {});
  }

  return { deleted: true };
}

function optionalString(val: unknown): string | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  return String(val);
}