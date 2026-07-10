import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireDriver } from '../auth/requireDriver';
import { dashboardActorRef, requireDashboardEquipmentManager } from '../auth/requireDashboard';
import { driverDocumentImagePath, vehicleDocumentImagePath } from '../storage/paths';
import { ActorRef, DriverActor, DriverProfile, DashboardProfile } from '../types/actor';
import { buildMetadata, RecordMetadata } from '../types/metadata';

const firestore = admin.firestore();
const storage = admin.storage();

const DRIVER_COLLECTION = 'driver_documents';
const VEHICLE_COLLECTION = 'vehicle_documents';

const DRIVER_DOCUMENT_TYPES = new Set([
  'cdl', 'medical_card', 'insurance', 'registration', 'dot_inspection',
  'hazmat_cert', 'twic_card', 'ifta_permit', 'drug_test', 'training_cert', 'other',
]);

const VEHICLE_DOCUMENT_TYPES = new Set([
  'registration', 'insurance', 'dot_inspection', 'ifta_permit', 'other',
]);

const EQUIPMENT_TYPES = new Set(['truck', 'trailer']);

export type DocumentAction =
  | 'driver.upsert'
  | 'driver.delete'
  | 'driver.list'
  | 'driver.uploadImage'
  | 'equipment.uploadDocument'
  | 'equipment.removeDocument';

export interface DocumentRequest {
  actor?: DriverActor;
  action: DocumentAction;
  payload?: Record<string, unknown>;
}

export interface DocumentRequestOptions {
  authUid?: string;
}

type ServiceMode = 'driver' | 'dashboard';

interface ServiceContext {
  mode: ServiceMode;
  action: DocumentAction;
  actor?: DriverActor;
  driver?: DriverProfile;
  dashboard?: DashboardProfile;
  actorRef: ActorRef;
  payload: Record<string, unknown>;
  authUid?: string;
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

interface VehicleDocumentRecord {
  id: string;
  companyId: string;
  equipmentType: string;
  equipmentNumber: string;
  type: string;
  label: string;
  storageUrl: string;
  storagePath: string;
  expirationDate?: string;
  issuedDate?: string;
  documentNumber?: string;
  state?: string;
  notes?: string;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
  createdBy: ActorRef;
  updatedBy: ActorRef;
}

// ── Service pipeline ───────────────────────────────────────────────────────

export async function handleDocumentRequest(
  req: DocumentRequest,
  options: DocumentRequestOptions = {},
): Promise<unknown> {
  const ctx = validate(req, options);
  await authorize(ctx);
  const result = await execute(ctx);
  await publishDomainEvents(ctx, result);
  return returnResult(result);
}

function validate(req: DocumentRequest, options: DocumentRequestOptions): ServiceContext {
  if (!req?.action) {
    throw new httpsV2.HttpsError('invalid-argument', 'action is required');
  }

  const action = req.action as DocumentAction;
  const allowed: DocumentAction[] = [
    'driver.upsert', 'driver.delete', 'driver.list', 'driver.uploadImage',
    'equipment.uploadDocument', 'equipment.removeDocument',
  ];
  if (!allowed.includes(action)) {
    throw new httpsV2.HttpsError('invalid-argument', `Unknown action: ${action}`);
  }

  const isDriverAction = action.startsWith('driver.');
  const isEquipmentAction = action.startsWith('equipment.');

  if (isDriverAction) {
    if (!req.actor || req.actor.type !== 'driver') {
      throw new httpsV2.HttpsError('invalid-argument', 'driver actor is required for driver.* actions');
    }
    return {
      mode: 'driver',
      action,
      actor: req.actor,
      actorRef: { type: 'driver', driverHash: req.actor.driverHash.trim().toLowerCase() },
      payload: req.payload || {},
    };
  }

  if (isEquipmentAction) {
    return {
      mode: 'dashboard',
      action,
      actorRef: { type: 'dashboard', uid: options.authUid || '' },
      payload: req.payload || {},
      authUid: options.authUid,
    };
  }

  throw new httpsV2.HttpsError('invalid-argument', 'Unsupported action');
}

async function authorize(ctx: ServiceContext): Promise<void> {
  if (ctx.mode === 'driver' && ctx.actor) {
    ctx.driver = await requireDriver(ctx.actor);
    ctx.actorRef = {
      type: 'driver',
      driverHash: ctx.driver.driverHash,
      displayName: ctx.driver.displayName,
    };
    return;
  }

  const companyId = String(ctx.payload.companyId || '');
  ctx.dashboard = await requireDashboardEquipmentManager(ctx.authUid, companyId);
  ctx.actorRef = dashboardActorRef(ctx.dashboard);
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
    case 'equipment.uploadDocument':
      return uploadEquipmentDocument(ctx);
    case 'equipment.removeDocument':
      return removeEquipmentDocument(ctx);
    default:
      throw new httpsV2.HttpsError('invalid-argument', `Unhandled action: ${ctx.action}`);
  }
}

/** Publish domain events for downstream consumers (alerts, shop queue, audit, etc.). */
async function publishDomainEvents(_ctx: ServiceContext, _result: unknown): Promise<void> {
  // Stub — future: event bus for Dashboard alerts, push, SMS, analytics.
}

function returnResult(result: unknown): unknown {
  return { ok: true, ...(typeof result === 'object' && result !== null ? result : { data: result }) };
}

// ── Driver document operations ───────────────────────────────────────────────

async function listDriverDocuments(ctx: ServiceContext): Promise<{ documents: DriverDocumentRecord[] }> {
  const snap = await firestore.collection(DRIVER_COLLECTION)
    .where('driverHash', '==', ctx.driver!.driverHash)
    .orderBy('updatedAt', 'desc')
    .get();
  return { documents: snap.docs.map(d => d.data() as DriverDocumentRecord) };
}

async function uploadDriverImage(ctx: ServiceContext): Promise<{ cloudUri: string; storagePath: string }> {
  const docId = String(ctx.payload.docId || '');
  const imageBase64 = String(ctx.payload.imageBase64 || '');
  if (!docId) throw new httpsV2.HttpsError('invalid-argument', 'docId is required');
  if (!imageBase64) throw new httpsV2.HttpsError('invalid-argument', 'imageBase64 is required');

  const buffer = Buffer.from(imageBase64, 'base64');
  if (buffer.length > 8 * 1024 * 1024) {
    throw new httpsV2.HttpsError('invalid-argument', 'Image exceeds 8MB limit');
  }

  const path = driverDocumentImagePath(ctx.driver!.driverHash, docId);
  const cloudUri = await saveImageWithDownloadUrl(path, buffer, 'image/jpeg');
  return { cloudUri, storagePath: path };
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
  if (driverHash !== ctx.driver!.driverHash) {
    throw new httpsV2.HttpsError('permission-denied', 'document.driverHash must match authenticated driver');
  }
  if (!DRIVER_DOCUMENT_TYPES.has(type)) {
    throw new httpsV2.HttpsError('invalid-argument', `Invalid document type: ${type}`);
  }
  if (!label) throw new httpsV2.HttpsError('invalid-argument', 'document.label is required');

  const ref = firestore.collection(DRIVER_COLLECTION).doc(id);
  const existing = await ref.get();
  const existingData = existing.exists ? existing.data() as DriverDocumentRecord : undefined;
  if (existingData && existingData.driverHash !== ctx.driver!.driverHash) {
    throw new httpsV2.HttpsError('permission-denied', 'Cannot modify another driver\'s document');
  }

  const now = new Date().toISOString();
  const meta = buildMetadata(ctx.actorRef, existingData as Partial<RecordMetadata> | undefined);
  const cloudUri = doc.cloudUri ? String(doc.cloudUri) : existingData?.cloudUri;
  const storagePath = doc.storagePath
    ? String(doc.storagePath)
    : (cloudUri ? driverDocumentImagePath(ctx.driver!.driverHash, id) : existingData?.storagePath);

  const record: DriverDocumentRecord = {
    id,
    driverHash: ctx.driver!.driverHash,
    companyId: doc.companyId ? String(doc.companyId) : (ctx.driver!.companyId || existingData?.companyId),
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
    createdAt: existingData?.createdAt || (doc.createdAt ? String(doc.createdAt) : meta.createdAt),
    updatedAt: doc.updatedAt ? String(doc.updatedAt) : now,
    createdBy: meta.createdBy,
    updatedBy: meta.updatedBy,
  };

  await ref.set(record, { merge: false });
  return { document: record };
}

async function deleteDriverDocument(ctx: ServiceContext): Promise<{ deleted: boolean }> {
  const docId = String(ctx.payload.docId || '');
  if (!docId) throw new httpsV2.HttpsError('invalid-argument', 'docId is required');

  const ref = firestore.collection(DRIVER_COLLECTION).doc(docId);
  const snap = await ref.get();
  if (!snap.exists) return { deleted: true };

  const data = snap.data() as DriverDocumentRecord;
  if (data.driverHash !== ctx.driver!.driverHash) {
    throw new httpsV2.HttpsError('permission-denied', 'Cannot delete another driver\'s document');
  }

  await ref.delete();
  const path = data.storagePath || driverDocumentImagePath(ctx.driver!.driverHash, docId);
  await storage.bucket().file(path).delete().catch(() => {});
  return { deleted: true };
}

// ── Equipment document operations (transitional vehicle_documents) ───────────

async function uploadEquipmentDocument(ctx: ServiceContext): Promise<{ document: VehicleDocumentRecord }> {
  const companyId = String(ctx.payload.companyId || '');
  const equipmentType = String(ctx.payload.equipmentType || '');
  const equipmentNumber = String(ctx.payload.equipmentNumber || '').trim().toUpperCase();
  const imageBase64 = String(ctx.payload.imageBase64 || '');
  const metadata = (ctx.payload.metadata || {}) as Record<string, unknown>;

  if (!companyId) throw new httpsV2.HttpsError('invalid-argument', 'companyId is required');
  if (!EQUIPMENT_TYPES.has(equipmentType)) {
    throw new httpsV2.HttpsError('invalid-argument', 'equipmentType must be truck or trailer');
  }
  if (!equipmentNumber) throw new httpsV2.HttpsError('invalid-argument', 'equipmentNumber is required');
  if (!imageBase64) throw new httpsV2.HttpsError('invalid-argument', 'imageBase64 is required');

  const docType = String(metadata.type || '');
  if (!VEHICLE_DOCUMENT_TYPES.has(docType)) {
    throw new httpsV2.HttpsError('invalid-argument', `Invalid vehicle document type: ${docType}`);
  }

  const buffer = Buffer.from(imageBase64, 'base64');
  if (buffer.length > 8 * 1024 * 1024) {
    throw new httpsV2.HttpsError('invalid-argument', 'Image exceeds 8MB limit');
  }

  const docRef = firestore.collection(VEHICLE_COLLECTION).doc();
  const docId = docRef.id;
  const storagePath = vehicleDocumentImagePath(companyId, equipmentType, equipmentNumber, docId);
  const contentType = String(ctx.payload.contentType || 'image/jpeg');
  const storageUrl = await saveImageWithDownloadUrl(storagePath, buffer, contentType);

  const now = new Date().toISOString();
  const meta = buildMetadata(ctx.actorRef);
  const label = String(metadata.label || docType);

  const record: VehicleDocumentRecord = {
    id: docId,
    companyId,
    equipmentType,
    equipmentNumber,
    type: docType,
    label,
    storageUrl,
    storagePath,
    expirationDate: optionalString(metadata.expirationDate),
    issuedDate: optionalString(metadata.issuedDate),
    documentNumber: optionalString(metadata.documentNumber),
    state: optionalString(metadata.state),
    notes: optionalString(metadata.notes),
    uploadedBy: String(metadata.uploadedBy || ctx.dashboard!.displayName),
    createdAt: now,
    updatedAt: now,
    createdBy: meta.createdBy,
    updatedBy: meta.updatedBy,
  };

  await docRef.set(record);
  return { document: record };
}

async function removeEquipmentDocument(ctx: ServiceContext): Promise<{ deleted: boolean }> {
  const companyId = String(ctx.payload.companyId || '');
  const docId = String(ctx.payload.docId || '');
  if (!companyId) throw new httpsV2.HttpsError('invalid-argument', 'companyId is required');
  if (!docId) throw new httpsV2.HttpsError('invalid-argument', 'docId is required');

  const ref = firestore.collection(VEHICLE_COLLECTION).doc(docId);
  const snap = await ref.get();
  if (!snap.exists) return { deleted: true };

  const data = snap.data() as VehicleDocumentRecord;
  if (data.companyId !== companyId) {
    throw new httpsV2.HttpsError('permission-denied', 'Document does not belong to this company');
  }

  await ref.delete();
  if (data.storagePath) {
    await storage.bucket().file(data.storagePath).delete().catch(() => {});
  }
  return { deleted: true };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function saveImageWithDownloadUrl(
  storagePath: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const bucket = storage.bucket();
  const file = bucket.file(storagePath);
  const downloadToken = crypto.randomUUID();
  await file.save(buffer, {
    contentType,
    resumable: false,
    metadata: {
      metadata: { firebaseStorageDownloadTokens: downloadToken },
    },
  });
  const encodedPath = encodeURIComponent(storagePath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
}

function optionalString(val: unknown): string | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  return String(val);
}