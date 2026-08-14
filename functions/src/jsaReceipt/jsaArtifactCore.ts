/**
 * Governed JSA immutable artifact — pure decision core.
 *
 * Persistence of a completed request's bounded driver-authored snapshot.
 * Identity, job, shift, well, and completion come ONLY from server-held
 * records. Clients may send requestId plus a strictly allowlisted
 * authored snapshot. No firebase-admin, no clock I/O.
 */
import {
  isCompletionAction,
  isJobRef,
  isPolicyIntent,
  isRequestId,
  liveState,
  type AuthPrincipal,
  type Decision,
  type InvoiceJobSnapshot,
  type JsaCompletionAction,
  type JsaGovernedRecord,
  type JsaPolicyIntent,
  type JsaShiftState,
  type ReceiptRefusal,
} from './jsaReceiptCore.js';

export const JSA_ARTIFACT_COLLECTION = 'jsa_governed_artifacts';
export const JSA_ARTIFACT_SCHEMA_VERSION = 1;
export const JSA_SIGNATURE_MAX_BYTES = 128 * 1024;
export const JSA_SNAPSHOT_MAX_JSON_CHARS = 180_000;
export const JSA_SIGNATURE_MIME = 'image/png';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const FORBIDDEN_AUTHORITY_KEYS = [
  'uid', 'driverId', 'companyId', 'driverHash', 'passcode', 'hash',
  'shiftId', 'periodId', 'originLocalDate', 'shiftState',
  'name', 'displayName', 'legalName',
  'customToken', 'code', 'codeVerifier', 'verifier',
  'wellName', 'jobType', 'jobRef', 'groupRef', 'intent', 'action',
  'completedAtMs', 'artifactWrittenAtMs', 'schemaVersion',
];

const SNAPSHOT_KEYS = [
  'prepared',
  'locationAcks',
  'locations',
  'stepsAcknowledged',
  'stepAcks',
  'ppeSelected',
  'ppeOtherItems',
  'notes',
  'pusher',
  'otherInfo',
  'printedName',
  'signature',
  'truckNumber',
  'formDate',
] as const;

const FORM_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isMapKey(k: string): boolean {
  return k.length >= 1 && k.length <= 64 && k.trim() === k && !/[\x00-\x1f\x7f]/.test(k);
}
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const LIMITS = {
  notes: 4000,
  pusher: 120,
  otherInfo: 2000,
  printedName: 120,
  truckNumber: 32,
  formDate: 10,
  mapKeys: 40,
  locations: 24,
  locationItem: 120,
  ppeOther: 16,
  ppeOtherItem: 80,
};

export interface JsaSignatureMeta {
  mimeType: typeof JSA_SIGNATURE_MIME;
  byteSize: number;
  sha256: string;
  storagePath: string;
}

export interface JsaAuthoredSnapshot {
  prepared: Record<string, boolean>;
  locationAcks: Record<string, boolean>;
  locations: string[];
  stepsAcknowledged: boolean;
  stepAcks: Record<string, boolean>;
  ppeSelected: Record<string, boolean>;
  ppeOtherItems: string[];
  notes: string;
  pusher: string;
  otherInfo: string;
  printedName: string;
  truckNumber: string;
  formDate: string;
}

export interface JsaGovernedArtifact {
  requestId: string;
  uid: string;
  driverId: string;
  companyId: string;
  jobRef: string;
  groupRef: string | null;
  periodId?: string;
  originLocalDate?: string;
  shiftState: JsaShiftState;
  intent: JsaPolicyIntent;
  action: JsaCompletionAction;
  wellName: string;
  jobType?: string;
  completedAtMs: number;
  artifactWrittenAtMs: number;
  schemaVersion: typeof JSA_ARTIFACT_SCHEMA_VERSION;
  snapshotHash: string;
  signature: JsaSignatureMeta;
  authored: JsaAuthoredSnapshot;
}

export interface PersistView {
  requestId: string;
  reused: boolean;
  schemaVersion: typeof JSA_ARTIFACT_SCHEMA_VERSION;
  snapshotHash: string;
  artifactWrittenAtMs: number;
  signature: JsaSignatureMeta;
}

export interface DecodedSignature {
  mimeType: typeof JSA_SIGNATURE_MIME;
  bytes: Uint8Array;
}

export function artifactPath(requestId: string): string {
  return `${JSA_ARTIFACT_COLLECTION}/${requestId}`;
}

export function signatureStoragePath(requestId: string, sha256: string): string {
  return `${JSA_ARTIFACT_COLLECTION}/${requestId}/signature/v1-${sha256}.png`;
}

function fail(refusal: ReceiptRefusal, detail: string): Decision<never> {
  return { ok: false, refusal, detail };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function hasForbiddenKey(keys: string[]): boolean {
  return keys.some((k) => FORBIDDEN_AUTHORITY_KEYS.includes(k));
}

function parseBoolMap(v: unknown, detail: string): Decision<Record<string, boolean>> {
  if (v === undefined) return { ok: true, value: {} };
  if (!isPlainObject(v)) return fail('malformed', detail);
  const keys = Object.keys(v);
  if (keys.length > LIMITS.mapKeys) return fail('malformed', `${detail}_count`);
  const out: Record<string, boolean> = {};
  for (const k of keys) {
    if (!isMapKey(k)) return fail('malformed', `${detail}_key`);
    if (typeof v[k] !== 'boolean') return fail('malformed', `${detail}_value`);
    out[k] = v[k];
  }
  return { ok: true, value: out };
}

function parseStringList(
  v: unknown,
  detail: string,
  maxItems: number,
  maxItem: number,
): Decision<string[]> {
  if (v === undefined) return { ok: true, value: [] };
  if (!Array.isArray(v)) return fail('malformed', detail);
  if (v.length > maxItems) return fail('malformed', `${detail}_count`);
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') return fail('malformed', `${detail}_item`);
    const t = item.trim();
    if (!t || t.length > maxItem) return fail('malformed', `${detail}_item`);
    out.push(t);
  }
  return { ok: true, value: out };
}

function parseBoundedString(
  v: unknown,
  detail: string,
  max: number,
  required: boolean,
): Decision<string> {
  if (v === undefined || v === null) {
    return required ? fail('malformed', detail) : { ok: true, value: '' };
  }
  if (typeof v !== 'string') return fail('malformed', detail);
  if (v.length > max) return fail('malformed', `${detail}_length`);
  const t = v.trim();
  if (required && !t) return fail('malformed', detail);
  return { ok: true, value: required ? t : v.trim() };
}

export function parsePersistInput(data: unknown): Decision<{ requestId: string; snapshot: unknown }> {
  if (!isPlainObject(data)) return fail('malformed', 'root');
  const keys = Object.keys(data);
  if (hasForbiddenKey(keys)) return fail('client_identity', 'forbidden_field');
  if (!keys.every((k) => k === 'requestId' || k === 'snapshot')) {
    return fail('malformed', 'unknown_key');
  }
  if (!isRequestId(data.requestId)) return fail('malformed', 'requestId');
  if (!isPlainObject(data.snapshot)) return fail('malformed', 'snapshot');
  const encoded = JSON.stringify(data.snapshot);
  if (encoded.length > JSA_SNAPSHOT_MAX_JSON_CHARS) return fail('malformed', 'payload_length');
  return { ok: true, value: { requestId: data.requestId, snapshot: data.snapshot } };
}

export function parseAuthoredSnapshot(raw: unknown): Decision<JsaAuthoredSnapshot> {
  if (!isPlainObject(raw)) return fail('malformed', 'snapshot');
  const keys = Object.keys(raw);
  if (hasForbiddenKey(keys)) return fail('client_identity', 'forbidden_field');
  if (!keys.every((k) => (SNAPSHOT_KEYS as readonly string[]).includes(k))) {
    return fail('malformed', 'unknown_key');
  }

  const prepared = parseBoolMap(raw.prepared, 'prepared');
  if (!prepared.ok) return prepared;
  const locationAcks = parseBoolMap(raw.locationAcks, 'locationAcks');
  if (!locationAcks.ok) return locationAcks;
  const stepAcks = parseBoolMap(raw.stepAcks, 'stepAcks');
  if (!stepAcks.ok) return stepAcks;
  const ppeSelected = parseBoolMap(raw.ppeSelected, 'ppeSelected');
  if (!ppeSelected.ok) return ppeSelected;

  const locations = parseStringList(raw.locations, 'locations', LIMITS.locations, LIMITS.locationItem);
  if (!locations.ok) return locations;
  const ppeOtherItems = parseStringList(
    raw.ppeOtherItems, 'ppeOtherItems', LIMITS.ppeOther, LIMITS.ppeOtherItem,
  );
  if (!ppeOtherItems.ok) return ppeOtherItems;

  if (raw.stepsAcknowledged !== undefined && typeof raw.stepsAcknowledged !== 'boolean') {
    return fail('malformed', 'stepsAcknowledged');
  }

  const notes = parseBoundedString(raw.notes, 'notes', LIMITS.notes, false);
  if (!notes.ok) return notes;
  const pusher = parseBoundedString(raw.pusher, 'pusher', LIMITS.pusher, false);
  if (!pusher.ok) return pusher;
  const otherInfo = parseBoundedString(raw.otherInfo, 'otherInfo', LIMITS.otherInfo, false);
  if (!otherInfo.ok) return otherInfo;
  const printedName = parseBoundedString(raw.printedName, 'printedName', LIMITS.printedName, true);
  if (!printedName.ok) return printedName;
  const truckNumber = parseBoundedString(raw.truckNumber, 'truckNumber', LIMITS.truckNumber, false);
  if (!truckNumber.ok) return truckNumber;

  let formDate = '';
  if (raw.formDate !== undefined && raw.formDate !== null && raw.formDate !== '') {
    if (typeof raw.formDate !== 'string' || !FORM_DATE_RE.test(raw.formDate)) {
      return fail('malformed', 'formDate');
    }
    formDate = raw.formDate;
  }

  if (!isPlainObject(raw.signature)) return fail('malformed', 'signature');

  return {
    ok: true,
    value: {
      prepared: prepared.value,
      locationAcks: locationAcks.value,
      locations: locations.value,
      stepsAcknowledged: raw.stepsAcknowledged === true,
      stepAcks: stepAcks.value,
      ppeSelected: ppeSelected.value,
      ppeOtherItems: ppeOtherItems.value,
      notes: notes.value,
      pusher: pusher.value,
      otherInfo: otherInfo.value,
      printedName: printedName.value,
      truckNumber: truckNumber.value,
      formDate,
    },
  };
}

function decodeBase64Strict(encoded: string): Uint8Array | null {
  if (!encoded || encoded.length % 4 !== 0 || !BASE64_RE.test(encoded)) return null;
  try {
    const buf = Buffer.from(encoded, 'base64');
    if (buf.length === 0) return null;
    if (buf.toString('base64') !== encoded) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

export function decodeSignaturePng(signature: unknown): Decision<DecodedSignature> {
  if (!isPlainObject(signature)) return fail('malformed', 'signature');
  const keys = Object.keys(signature);
  if (hasForbiddenKey(keys)) return fail('client_identity', 'forbidden_field');
  if (!keys.every((k) => k === 'mimeType' || k === 'data')) {
    return fail('malformed', 'signature_key');
  }
  const mime = signature.mimeType;
  if (mime !== undefined && mime !== JSA_SIGNATURE_MIME) {
    return fail('malformed', 'signature_type');
  }
  if (typeof signature.data !== 'string' || !signature.data) {
    return fail('malformed', 'signature_data');
  }
  let encoded = signature.data.trim();
  const dataUrl = /^data:([^;,]+);base64,(.+)$/i.exec(encoded);
  if (dataUrl) {
    if (dataUrl[1].toLowerCase() !== JSA_SIGNATURE_MIME) {
      return fail('malformed', 'signature_type');
    }
    encoded = dataUrl[2];
  }
  const bytes = decodeBase64Strict(encoded);
  if (!bytes) return fail('malformed', 'signature_encoding');
  if (bytes.length > JSA_SIGNATURE_MAX_BYTES) return fail('malformed', 'signature_bytes');
  if (bytes.length < PNG_MAGIC.length) return fail('malformed', 'signature_encoding');
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return fail('malformed', 'signature_encoding');
  }
  return { ok: true, value: { mimeType: JSA_SIGNATURE_MIME, bytes } };
}

export function canonicalizeAuthoredSnapshot(
  authored: JsaAuthoredSnapshot,
  signature: Pick<JsaSignatureMeta, 'mimeType' | 'byteSize' | 'sha256'>,
): string {
  const body = {
    formDate: authored.formDate,
    locationAcks: sortRecord(authored.locationAcks),
    locations: authored.locations,
    notes: authored.notes,
    otherInfo: authored.otherInfo,
    ppeOtherItems: authored.ppeOtherItems,
    ppeSelected: sortRecord(authored.ppeSelected),
    prepared: sortRecord(authored.prepared),
    printedName: authored.printedName,
    pusher: authored.pusher,
    signature: {
      byteSize: signature.byteSize,
      mimeType: signature.mimeType,
      sha256: signature.sha256,
    },
    stepAcks: sortRecord(authored.stepAcks),
    stepsAcknowledged: authored.stepsAcknowledged,
    truckNumber: authored.truckNumber,
  };
  return JSON.stringify(body);
}

function sortRecord(rec: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k];
  return out;
}

function invoiceCompanyOf(inv: InvoiceJobSnapshot): string | null {
  if (typeof inv.companyId === 'string' && inv.companyId.trim()) return inv.companyId.trim();
  if (typeof inv.company === 'string' && inv.company.trim()) return inv.company.trim();
  return null;
}

function invoiceDriverMatches(inv: InvoiceJobSnapshot, expectedDriverId: string): boolean {
  return [inv.driverId, inv.assignedDriverId, inv.driverHash]
    .some((id) => typeof id === 'string' && id === expectedDriverId);
}

function invoiceHasDriverIdentifier(inv: InvoiceJobSnapshot): boolean {
  return [inv.driverId, inv.assignedDriverId, inv.driverHash]
    .some((id) => typeof id === 'string' && id.length > 0);
}

function boundedDisplay(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

export interface InvoiceArtifactFields {
  wellName: string;
  jobType?: string;
}

/**
 * Re-verify the request-bound invoice before an artifact write.
 * Distinct refusal classes (unlike the get-view existence hide) so a
 * completed request cannot persist against a foreign or unbound job.
 */
export function decideInvoiceArtifactBinding(input: {
  requestJobRef: string;
  loadedJobRef: string;
  requestCompanyId: string;
  requestDriverId: string;
  invoice: InvoiceJobSnapshot;
}): Decision<InvoiceArtifactFields> {
  if (!isJobRef(input.requestJobRef) || input.loadedJobRef !== input.requestJobRef) {
    return fail('job_mismatch', 'jobRef');
  }
  if (!input.invoice.exists) return fail('not_found', 'job');
  const company = invoiceCompanyOf(input.invoice);
  if (!company) return fail('authority_unverifiable', 'invoice_company');
  if (company !== input.requestCompanyId) return fail('binding_mismatch', 'invoice_company');
  if (!invoiceHasDriverIdentifier(input.invoice)) {
    return fail('authority_unverifiable', 'invoice_driver');
  }
  if (!invoiceDriverMatches(input.invoice, input.requestDriverId)) {
    return fail('binding_mismatch', 'invoice_driver');
  }
  const wellName = boundedDisplay(input.invoice.wellName, 120);
  if (!wellName) return fail('authority_unverifiable', 'wellName');
  const rawType = input.invoice.commodityType;
  if (rawType === undefined || rawType === null || rawType === '') {
    return { ok: true, value: { wellName } };
  }
  const jobType = boundedDisplay(rawType, 64);
  if (!jobType) return fail('authority_unverifiable', 'jobType');
  return { ok: true, value: { wellName, jobType } };
}

export function requiredRequestBindings(record: JsaGovernedRecord): Decision<true> {
  if (!isRequestId(record.requestId)) return fail('authority_unverifiable', 'requestId');
  if (typeof record.driverId !== 'string' || !record.driverId) {
    return fail('authority_unverifiable', 'driverId');
  }
  if (typeof record.companyId !== 'string' || !record.companyId) {
    return fail('authority_unverifiable', 'companyId');
  }
  if (!isJobRef(record.jobRef)) return fail('authority_unverifiable', 'jobRef');
  if (!isPolicyIntent(record.intent)) return fail('authority_unverifiable', 'intent');
  if (!record.action || !isCompletionAction(record.action)) {
    return fail('authority_unverifiable', 'action');
  }
  if (typeof record.completedAtMs !== 'number' || !Number.isFinite(record.completedAtMs)) {
    return fail('authority_unverifiable', 'completedAtMs');
  }
  const shift = record.binding?.shiftState;
  if (shift !== 'open' && shift !== 'none') return fail('authority_unverifiable', 'shiftState');
  if (shift === 'open') {
    if (typeof record.binding.periodId !== 'string' || !record.binding.periodId) {
      return fail('authority_unverifiable', 'periodId');
    }
    if (typeof record.binding.originLocalDate !== 'string' || !record.binding.originLocalDate) {
      return fail('authority_unverifiable', 'originLocalDate');
    }
  }
  return { ok: true, value: true };
}

export function decidePersist(input: {
  existingRequest: JsaGovernedRecord | null;
  existingArtifact: JsaGovernedArtifact | null;
  requestId: string;
  principal: AuthPrincipal;
  snapshotHash: string;
  signatureSha256: string;
  nowMs: number;
  uid: string;
  wellName: string;
  jobType?: string;
  authored: JsaAuthoredSnapshot;
  signature: JsaSignatureMeta;
}): Decision<{ artifact: JsaGovernedArtifact; write: 'create' | 'reuse' }> {
  if (!input.existingRequest) return fail('not_found', 'unregistered');
  if (input.existingRequest.requestId !== input.requestId) return fail('not_found', 'id');
  if (!input.uid) return fail('unauthenticated', 'uid');
  if (input.existingRequest.driverId !== input.principal.driverId
    || input.existingRequest.companyId !== input.principal.companyId) {
    return fail('binding_mismatch', 'actor');
  }
  if (input.principal.uid !== input.uid) return fail('binding_mismatch', 'uid');

  const state = liveState(input.existingRequest, input.nowMs);
  if (state === 'expired') return fail('expired', 'ttl');
  if (state !== 'completed') return fail('pending', 'incomplete');

  const bindings = requiredRequestBindings(input.existingRequest);
  if (!bindings.ok) return bindings;

  if (!SHA256_HEX_RE.test(input.snapshotHash) || !SHA256_HEX_RE.test(input.signatureSha256)) {
    return fail('malformed', 'hash');
  }
  if (input.signature.sha256 !== input.signatureSha256) return fail('malformed', 'signature_hash');
  if (input.signature.storagePath !== signatureStoragePath(input.requestId, input.signatureSha256)) {
    return fail('malformed', 'storage_path');
  }

  if (input.existingArtifact) {
    if (input.existingArtifact.requestId !== input.requestId) return fail('conflict', 'artifact_id');
    if (input.existingArtifact.snapshotHash === input.snapshotHash
      && input.existingArtifact.signature.sha256 === input.signatureSha256) {
      return { ok: true, value: { artifact: input.existingArtifact, write: 'reuse' } };
    }
    return fail('conflict', 'immutable');
  }

  const rec = input.existingRequest;
  const artifact: JsaGovernedArtifact = {
    requestId: rec.requestId,
    uid: input.uid,
    driverId: rec.driverId,
    companyId: rec.companyId,
    jobRef: rec.jobRef,
    groupRef: rec.groupRef,
    ...(rec.binding.periodId ? { periodId: rec.binding.periodId } : {}),
    ...(rec.binding.originLocalDate ? { originLocalDate: rec.binding.originLocalDate } : {}),
    shiftState: rec.binding.shiftState,
    intent: rec.intent,
    action: rec.action as JsaCompletionAction,
    wellName: input.wellName,
    ...(input.jobType ? { jobType: input.jobType } : {}),
    completedAtMs: rec.completedAtMs as number,
    artifactWrittenAtMs: input.nowMs,
    schemaVersion: JSA_ARTIFACT_SCHEMA_VERSION,
    snapshotHash: input.snapshotHash,
    signature: input.signature,
    authored: input.authored,
  };
  return { ok: true, value: { artifact, write: 'create' } };
}

export function persistView(artifact: JsaGovernedArtifact, reused: boolean): PersistView {
  return {
    requestId: artifact.requestId,
    reused,
    schemaVersion: artifact.schemaVersion,
    snapshotHash: artifact.snapshotHash,
    artifactWrittenAtMs: artifact.artifactWrittenAtMs,
    signature: artifact.signature,
  };
}

export function toStoredArtifact(artifact: JsaGovernedArtifact): Record<string, unknown> {
  return {
    requestId: artifact.requestId,
    uid: artifact.uid,
    driverId: artifact.driverId,
    companyId: artifact.companyId,
    jobRef: artifact.jobRef,
    groupRef: artifact.groupRef,
    ...(artifact.periodId ? { periodId: artifact.periodId } : {}),
    ...(artifact.originLocalDate ? { originLocalDate: artifact.originLocalDate } : {}),
    shiftState: artifact.shiftState,
    intent: artifact.intent,
    action: artifact.action,
    wellName: artifact.wellName,
    ...(artifact.jobType ? { jobType: artifact.jobType } : {}),
    completedAtMs: artifact.completedAtMs,
    artifactWrittenAtMs: artifact.artifactWrittenAtMs,
    schemaVersion: artifact.schemaVersion,
    snapshotHash: artifact.snapshotHash,
    signature: artifact.signature,
    authored: artifact.authored,
  };
}

export function fromStoredArtifact(v: unknown): JsaGovernedArtifact | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  if (!isRequestId(o.requestId) || !isJobRef(o.jobRef) || !isPolicyIntent(o.intent)) return null;
  if (typeof o.uid !== 'string' || !o.uid) return null;
  if (typeof o.driverId !== 'string' || typeof o.companyId !== 'string') return null;
  if (o.shiftState !== 'open' && o.shiftState !== 'none') return null;
  if (!isCompletionAction(o.action)) return null;
  if (typeof o.wellName !== 'string' || !o.wellName) return null;
  if (typeof o.completedAtMs !== 'number' || typeof o.artifactWrittenAtMs !== 'number') return null;
  if (o.schemaVersion !== JSA_ARTIFACT_SCHEMA_VERSION) return null;
  if (typeof o.snapshotHash !== 'string' || !SHA256_HEX_RE.test(o.snapshotHash)) return null;
  const sig = o.signature as JsaSignatureMeta | undefined;
  if (!sig || sig.mimeType !== JSA_SIGNATURE_MIME || typeof sig.byteSize !== 'number') return null;
  if (typeof sig.sha256 !== 'string' || !SHA256_HEX_RE.test(sig.sha256)) return null;
  if (typeof sig.storagePath !== 'string' || !sig.storagePath) return null;
  const authored = o.authored as JsaAuthoredSnapshot | undefined;
  if (!authored || typeof authored !== 'object') return null;
  return {
    requestId: o.requestId,
    uid: o.uid,
    driverId: o.driverId,
    companyId: o.companyId,
    jobRef: o.jobRef,
    groupRef: typeof o.groupRef === 'string' ? o.groupRef : null,
    ...(typeof o.periodId === 'string' ? { periodId: o.periodId } : {}),
    ...(typeof o.originLocalDate === 'string' ? { originLocalDate: o.originLocalDate } : {}),
    shiftState: o.shiftState,
    intent: o.intent,
    action: o.action,
    wellName: o.wellName,
    ...(typeof o.jobType === 'string' ? { jobType: o.jobType } : {}),
    completedAtMs: o.completedAtMs,
    artifactWrittenAtMs: o.artifactWrittenAtMs,
    schemaVersion: JSA_ARTIFACT_SCHEMA_VERSION,
    snapshotHash: o.snapshotHash,
    signature: {
      mimeType: JSA_SIGNATURE_MIME,
      byteSize: sig.byteSize,
      sha256: sig.sha256,
      storagePath: sig.storagePath,
    },
    authored: {
      prepared: isPlainObject(authored.prepared) ? authored.prepared as Record<string, boolean> : {},
      locationAcks: isPlainObject(authored.locationAcks) ? authored.locationAcks as Record<string, boolean> : {},
      locations: Array.isArray(authored.locations) ? authored.locations : [],
      stepsAcknowledged: authored.stepsAcknowledged === true,
      stepAcks: isPlainObject(authored.stepAcks) ? authored.stepAcks as Record<string, boolean> : {},
      ppeSelected: isPlainObject(authored.ppeSelected) ? authored.ppeSelected as Record<string, boolean> : {},
      ppeOtherItems: Array.isArray(authored.ppeOtherItems) ? authored.ppeOtherItems : [],
      notes: typeof authored.notes === 'string' ? authored.notes : '',
      pusher: typeof authored.pusher === 'string' ? authored.pusher : '',
      otherInfo: typeof authored.otherInfo === 'string' ? authored.otherInfo : '',
      printedName: typeof authored.printedName === 'string' ? authored.printedName : '',
      truckNumber: typeof authored.truckNumber === 'string' ? authored.truckNumber : '',
      formDate: typeof authored.formDate === 'string' ? authored.formDate : '',
    },
  };
}
