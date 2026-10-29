import * as admin from 'firebase-admin';
import * as httpsV2 from 'firebase-functions/v2/https';
import { createHash } from 'crypto';
import { canonicalReportJson, reportId, type SignedEvidence, type ValidReport } from './reportContract';
import { validateImageBytes } from '../inspectionProfiles/validation';

export type ReportActor = { companyId: string; driverId: string };
type Obj = Record<string, unknown>;
type Identity = { inspectionId: string; inspectionType: string; reportId: string; version: number };
export type EvidenceBinding = Identity & SignedEvidence & {
  companyId: string; driverId: string; reportDigest: string;
};
const bucket = () => admin.storage().bucket('wellbuilt-sync.firebasestorage.app');
const fail = (code: httpsV2.FunctionsErrorCode, message: string): never => { throw new httpsV2.HttpsError(code, message); };
const evidenceRef = (companyId: string, evidenceId: string) => admin.firestore().collection('companies')
  .doc(companyId).collection('equipment_inspection_evidence').doc(evidenceId);
const quotaRef = (actor: ReportActor, day: string) => admin.firestore().collection('companies')
  .doc(actor.companyId).collection('equipment_inspection_evidence_daily').doc(`${actor.driverId}_${day}`);
const reportRef = (companyId: string, documentId: string) => admin.firestore().collection('companies')
  .doc(companyId).collection('equipment_inspection_reports').doc(documentId);
const digest = (value: unknown): string => createHash('sha256').update(canonicalReportJson(value)).digest('hex');
const hex = (value: unknown, name: string): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  ? value : fail('invalid-argument', `Invalid ${name}`);
const positive = (value: unknown, name: string): number => Number.isSafeInteger(value) && (value as number) >= 1
  ? value as number : fail('invalid-argument', `Invalid ${name}`);

export function enabled(): boolean { return process.env.WB_EQUIPMENT_FULL_DVIR_ENABLED === 'true'
  && process.env.WB_EQUIPMENT_DEFECT_EVIDENCE_ENABLED === 'true'; }
export function bindingFor(actor: ReportActor, identity: Identity, evidence: SignedEvidence, reportDigest: string): EvidenceBinding {
  return { companyId: actor.companyId, driverId: actor.driverId,
    inspectionId: identity.inspectionId, inspectionType: identity.inspectionType,
    reportId: identity.reportId, version: identity.version,
    issueId: evidence.issueId, areaId: evidence.areaId, itemId: evidence.itemId,
    localEvidenceId: evidence.localEvidenceId, sha256: evidence.sha256,
    byteLength: evidence.byteLength, contentType: evidence.contentType, reportDigest };
}
export function evidenceIdFor(binding: EvidenceBinding): string { return `e_${digest(binding)}`; }
const storagePathFor = (binding: EvidenceBinding, evidenceId: string): string =>
  `companies/${binding.companyId}/equipment-inspection-evidence/${binding.driverId}/${evidenceId}.jpg`;

function inputBinding(actor: ReportActor, data: Obj): EvidenceBinding {
  const identityRaw = data.reportIdentity;
  if (!identityRaw || typeof identityRaw !== 'object' || Array.isArray(identityRaw))
    return fail('invalid-argument', 'Invalid reportIdentity');
  const identity = identityRaw as Obj;
  if (Object.keys(identity).some(key => !['inspectionId', 'inspectionType', 'reportId', 'version'].includes(key)))
    return fail('invalid-argument', 'Unsupported reportIdentity field');
  const inspectionType = identity.inspectionType;
  if (!['pre_trip', 'post_trip', 'periodic'].includes(inspectionType as string))
    return fail('invalid-argument', 'Invalid inspectionType');
  const version = positive(identity.version, 'version');
  if (version > 1000) return fail('invalid-argument', 'Invalid version');
  const byteLength = positive(data.byteLength, 'byteLength');
  if (byteLength > 8 * 1024 * 1024 || data.contentType !== 'image/jpeg')
    return fail('invalid-argument', 'Invalid evidence image');
  return bindingFor(actor, {
    inspectionId: reportId(identity.inspectionId, 'inspectionId'),
    inspectionType: inspectionType as string, reportId: reportId(identity.reportId, 'reportId'), version,
  }, {
    issueId: reportId(data.issueId, 'issueId'), areaId: reportId(data.areaId, 'areaId'),
    itemId: reportId(data.itemId, 'itemId'), localEvidenceId: reportId(data.localEvidenceId, 'localEvidenceId'),
    sha256: hex(data.sha256, 'sha256'), byteLength, contentType: 'image/jpeg',
  }, hex(data.reportDigest, 'reportDigest'));
}

/** A repeated begin returns the same pending record and a fresh, short-lived PUT URL. */
export async function beginEvidenceUpload(actor: ReportActor, data: Obj) {
  if (!enabled()) return fail('failed-precondition', 'Defect evidence is disabled');
  const binding = inputBinding(actor, data);
  const evidenceId = evidenceIdFor(binding);
  const storagePath = storagePathFor(binding, evidenceId);
  const ref = evidenceRef(actor.companyId, evidenceId);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const quota = quotaRef(actor, day);
  await admin.firestore().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      if (canonicalReportJson(snap.data()?.binding) !== canonicalReportJson(binding)
        || snap.data()?.storagePath !== storagePath)
        fail('already-exists', 'Evidence binding conflict');
      return;
    }
    const usage = await tx.get(quota);
    const count = usage.exists ? usage.data()?.count : 0;
    if (!Number.isSafeInteger(count) || count < 0 || count >= 100)
      fail('resource-exhausted', 'Daily evidence reservation limit reached');
    tx.create(ref, { binding, storagePath, state: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(quota, { count: count + 1, day, driverId: actor.driverId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const [url] = await bucket().file(storagePath).getSignedUrl({ action: 'write', expires: expiresAt,
    contentType: 'image/jpeg', extensionHeaders: {
      'x-goog-if-generation-match': '0', 'x-goog-meta-sha256': binding.sha256,
    } }) as [string];
  return { schemaVersion: 1, companyId: actor.companyId, driverId: actor.driverId,
    evidenceId, binding, upload: { url, expiresAt: expiresAt.toISOString(), method: 'PUT' } };
}

/** No caller-supplied storage path or metadata may authorize a receipt. */
export async function finalizeEvidenceUpload(actor: ReportActor, evidenceId: string) {
  if (!enabled()) return fail('failed-precondition', 'Defect evidence is disabled');
  if (!/^e_[a-f0-9]{64}$/.test(evidenceId)) return fail('invalid-argument', 'Invalid evidenceId');
  const ref = evidenceRef(actor.companyId, evidenceId);
  const snap = await ref.get();
  if (!snap.exists) return fail('not-found', 'Evidence reservation not found');
  const row = snap.data() as Obj;
  const binding = row.binding as EvidenceBinding;
  if (!binding || binding.companyId !== actor.companyId || binding.driverId !== actor.driverId
    || evidenceIdFor(binding) !== evidenceId || row.storagePath !== storagePathFor(binding, evidenceId))
    return fail('permission-denied', 'Evidence owner mismatch');
  const file = bucket().file(row.storagePath as string);
  const [metadata] = await file.getMetadata();
  if (metadata.contentType !== binding.contentType || Number(metadata.size) !== binding.byteLength
    || metadata.metadata?.sha256 !== binding.sha256 || !metadata.generation)
    return fail('failed-precondition', 'Evidence object metadata mismatch');
  const [bytes] = await file.download();
  if (bytes.length !== binding.byteLength || createHash('sha256').update(bytes).digest('hex') !== binding.sha256)
    return fail('failed-precondition', 'Evidence bytes mismatch');
  validateImageBytes(bytes, binding.contentType);
  const generation = String(metadata.generation);
  await admin.firestore().runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists || canonicalReportJson(current.data()?.binding) !== canonicalReportJson(binding))
      fail('failed-precondition', 'Evidence reservation changed');
    if (current.data()?.state === 'verified') {
      if (current.data()?.generation !== generation) fail('already-exists', 'Evidence generation conflict');
      return;
    }
    tx.update(ref, { state: 'verified', generation, verifiedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  return { schemaVersion: 1, companyId: actor.companyId, driverId: actor.driverId,
    evidenceId, receiptId: evidenceId, state: 'verified', binding };
}

/** Transaction reads every verified receipt before the immutable report create. */
export async function verifiedEvidenceForReport(tx: admin.firestore.Transaction, actor: ReportActor,
  report: ValidReport, reportDigest: string, receiptIds: string[]): Promise<Array<{ evidenceId: string; storagePath: string; binding: EvidenceBinding }>> {
  if (receiptIds.length !== report.evidence.length || new Set(receiptIds).size !== receiptIds.length)
    return fail('invalid-argument', 'Evidence receipts do not cover signed report');
  const expected = new Map(report.evidence.map(evidence => {
    const binding = bindingFor(actor, report, evidence, reportDigest);
    return [evidenceIdFor(binding), binding] as const;
  }));
  if (expected.size !== receiptIds.length || receiptIds.some(id => !expected.has(id)))
    return fail('invalid-argument', 'Evidence receipt binding mismatch');
  const verified: Array<{ evidenceId: string; storagePath: string; binding: EvidenceBinding }> = [];
  for (const evidenceId of [...receiptIds].sort()) {
    const snap = await tx.get(evidenceRef(actor.companyId, evidenceId));
    const row = snap.data();
    const binding = expected.get(evidenceId)!;
    if (!snap.exists || row?.state !== 'verified' || !row.generation
      || canonicalReportJson(row.binding) !== canonicalReportJson(binding)
      || row.storagePath !== storagePathFor(binding, evidenceId))
      return fail('failed-precondition', 'Evidence receipt is not verified');
    verified.push({ evidenceId, storagePath: row.storagePath, binding });
  }
  return verified;
}

/** Dashboard access is rechecked before issuing each short-lived read URL. */
export async function readEvidenceUrl(companyId: string, documentId: string, evidenceId: string) {
  if (!/^r_[a-f0-9]{64}$/.test(documentId) || !/^e_[a-f0-9]{64}$/.test(evidenceId))
    return fail('invalid-argument', 'Invalid report or evidence ID');
  const report = await reportRef(companyId, documentId).get();
  if (!report.exists) return fail('not-found', 'Report not found');
  const attached = (report.data()?.verifiedEvidence || []) as Array<{ evidenceId: string; storagePath: string }>;
  const item = attached.find(entry => entry.evidenceId === evidenceId);
  if (!item) return fail('not-found', 'Verified evidence not attached to report');
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const [url] = await bucket().file(item.storagePath).getSignedUrl({ action: 'read', expires: expiresAt }) as [string];
  return { schemaVersion: 1, companyId, documentId, evidenceId, url, expiresAt: expiresAt.toISOString() };
}
