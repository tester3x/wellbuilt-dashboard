import * as admin from 'firebase-admin';
import * as httpsV2 from 'firebase-functions/v2/https';
import { driverAuthUid } from '../../security/tokenMint';
import { loadCanonicalDriverAuthority, productionCanonicalDriverReaders } from '../../security/canonicalDriverAuthority';
import { isCanonicalDriverId } from '../assignmentIdentity';
import { loadInspectionProfileProvenance } from '../inspectionProfiles/provenance';
import { requireDashboardDvirRead } from '../auth/requireDashboardEQuipment';
import { canonicalReportJson, digestReport, reportDocumentId, validateFullReport } from './reportContract';

const options = { region: 'us-central1', timeoutSeconds: 60, memory: '512MiB' as const };
type Request = httpsV2.CallableRequest<unknown>;
const fail = (code: httpsV2.FunctionsErrorCode, message: string): never => { throw new httpsV2.HttpsError(code, message); };
const input = (request: Request, keys: string[]): Record<string, unknown> => {
  const data = request.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('invalid-argument', 'Invalid request');
  const row = data as Record<string, unknown>;
  if (row.schemaVersion !== 1 || Object.keys(row).some(key => !['schemaVersion', ...keys].includes(key)))
    return fail('invalid-argument', 'Unsupported request');
  return row;
};

async function subject(request: Request): Promise<{ companyId: string; driverId: string; driverHash: string }> {
  const auth = request.auth;
  const driverId = auth?.token?.driverId;
  if (!auth?.uid || auth.token?.kind !== 'driver' || !isCanonicalDriverId(driverId)
    || auth.uid !== driverAuthUid(driverId)) return fail('unauthenticated', 'Canonical driver session required');
  const live = await loadCanonicalDriverAuthority(driverId, productionCanonicalDriverReaders());
  if (!live?.active) return fail('permission-denied', 'Driver inactive or unbound');
  const companyId = live.companyId;
  const company = await admin.firestore().collection('companies').doc(companyId).get();
  if (!company.exists || company.data()?.status === 'inactive') return fail('permission-denied', 'Company inactive');
  const profile = await admin.database().ref(`drivers/profiles/${driverId}`).once('value');
  const data = (profile.val() || {}) as Record<string, unknown>;
  const driverHash = typeof data.driverHash === 'string' ? data.driverHash.toLowerCase() : driverId;
  return { companyId, driverId, driverHash };
}

function enabled(): boolean { return process.env.WB_EQUIPMENT_FULL_DVIR_ENABLED === 'true'; }

export async function getCapabilities(request: Request) {
  input(request, []);
  const actor = await subject(request);
  return { schemaVersion: 1, companyId: actor.companyId, enabled: enabled(),
    reportSchemaVersion: 'dvir-report/2', supportsCombinedAssets: true, supportsProfileProvenance: true };
}

export async function submitFullReport(request: Request) {
  const data = input(request, ['report', 'reportDigest']);
  const actor = await subject(request);
  if (!enabled()) return fail('failed-precondition', 'Full report ingestion is disabled');
  if (typeof data.reportDigest !== 'string' || !/^[a-f0-9]{64}$/.test(data.reportDigest))
    return fail('invalid-argument', 'Invalid reportDigest');
  // Clone using the phone's canonical JSON rules. This also strips undefined
  // object fields before Firestore storage and enforces the 800000-byte bound.
  const report = JSON.parse(canonicalReportJson(data.report)) as Record<string, unknown>;
  const parsed = validateFullReport(report, actor.companyId);
  const digest = digestReport(report);
  if (digest !== data.reportDigest) return fail('invalid-argument', 'Report digest mismatch');
  if (parsed.driverHash.toLowerCase() !== actor.driverHash.toLowerCase()
    && parsed.driverHash !== actor.driverId) {
    const binding = await admin.database().ref(`drivers/identityBindings/byApproved/${parsed.driverHash.toLowerCase()}`).once('value');
    if (binding.val()?.driverId !== actor.driverId) return fail('permission-denied', 'Report driver mismatch');
  }
  const signer = (report.signature as Record<string, unknown>).signerId;
  if (signer !== parsed.driverHash && signer !== actor.driverId)
    return fail('permission-denied', 'Report signer mismatch');
  if (report.inspectionProfile !== undefined) {
    // This validates the historical published revision and exact media graph.
    await loadInspectionProfileProvenance(report.inspectionProfile, actor.companyId);
  }
  const docId = reportDocumentId(actor.companyId, actor.driverId, parsed);
  const ref = admin.firestore().collection('companies').doc(actor.companyId)
    .collection('equipment_inspection_reports').doc(docId);
  const storagePath = ref.path;
  const receipt = { schemaVersion: 1, companyId: actor.companyId, accepted: true,
    inspectionId: parsed.inspectionId, reportId: parsed.reportId,
    inspectionType: parsed.inspectionType, version: parsed.version, reportDigest: digest, storagePath };
  await admin.firestore().runTransaction(async tx => {
    const current = await tx.get(ref);
    if (current.exists) {
      if (current.data()?.reportDigest !== digest) fail('already-exists', 'Signed report identity conflict');
      return;
    }
    tx.create(ref, { ...receipt, driverId: actor.driverId, report,
      createdAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  return receipt;
}

export const getEquipmentInspectionReportCapabilities = httpsV2.onCall(options, getCapabilities);
export const submitEquipmentInspectionReport = httpsV2.onCall(options, submitFullReport);

async function dashboardCompany(request: Request, keys: string[]): Promise<string> {
  const data = input(request, ['companyId', ...keys]);
  if (typeof data.companyId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.companyId))
    return fail('invalid-argument', 'Invalid companyId');
  await requireDashboardDvirRead(request.auth?.uid, data.companyId);
  return data.companyId;
}

export const listEquipmentInspectionReports = httpsV2.onCall(options, async request => {
  const companyId = await dashboardCompany(request, ['limit']);
  const data = request.data as Record<string, unknown>;
  const limit = data.limit === undefined ? 100 : data.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200)
    return fail('invalid-argument', 'Invalid limit');
  const snap = await admin.firestore().collection('companies').doc(companyId)
    .collection('equipment_inspection_reports').orderBy('createdAt', 'desc').limit(limit as number).get();
  return { schemaVersion: 1, companyId, reports: snap.docs.map(doc => {
    const row = doc.data();
    return { documentId: doc.id, inspectionId: row.inspectionId, reportId: row.reportId,
      inspectionType: row.inspectionType, version: row.version, reportDigest: row.reportDigest,
      storagePath: doc.ref.path, driverId: row.driverId,
      noDefects: row.report?.noDefects, completedAt: row.report?.completedAt,
      assetLabels: Array.isArray(row.report?.assets) ? row.report.assets.map((asset: Record<string, unknown>) => asset.label || asset.assetId) : [] };
  }) };
});

export const getEquipmentInspectionReport = httpsV2.onCall(options, async request => {
  const companyId = await dashboardCompany(request, ['documentId']);
  const data = request.data as Record<string, unknown>;
  if (typeof data.documentId !== 'string' || !/^r_[a-f0-9]{64}$/.test(data.documentId))
    return fail('invalid-argument', 'Invalid documentId');
  const snap = await admin.firestore().collection('companies').doc(companyId)
    .collection('equipment_inspection_reports').doc(data.documentId).get();
  if (!snap.exists) return fail('not-found', 'Report not found');
  const row = snap.data()!;
  return { schemaVersion: 1, companyId, documentId: snap.id,
    reportDigest: row.reportDigest, storagePath: snap.ref.path, report: row.report };
});
