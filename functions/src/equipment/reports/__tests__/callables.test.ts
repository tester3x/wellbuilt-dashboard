jest.mock('firebase-admin', () => ({
  database: jest.fn(), firestore: Object.assign(jest.fn(), {
    FieldValue: { serverTimestamp: jest.fn(() => 'server-time') },
  }), storage: jest.fn(),
}));
jest.mock('../../../security/canonicalDriverAuthority', () => ({
  loadCanonicalDriverAuthority: jest.fn(), productionCanonicalDriverReaders: jest.fn(() => ({})),
}));
jest.mock('../../inspectionProfiles/provenance', () => ({ loadInspectionProfileProvenance: jest.fn() }));
jest.mock('../../auth/requireDashboardEQuipment', () => ({ requireDashboardDvirRead: jest.fn() }));

import * as admin from 'firebase-admin';
import { loadCanonicalDriverAuthority } from '../../../security/canonicalDriverAuthority';
import { driverAuthUid } from '../../../security/tokenMint';
import { digestReport } from '../reportContract';
import { getCapabilities, submitFullReport } from '../callables';
import { beginEvidenceUpload, bindingFor, evidenceIdFor, finalizeEvidenceUpload } from '../evidence';
import { validateFullReport } from '../reportContract';
import { fixture } from './reportFixture';
import { createHash } from 'crypto';

const driverId = '01234567-89ab-4cde-8fab-0123456789ab';
const records = new Map<string, Record<string, unknown>>();
const txCreate = jest.fn((ref: { path: string }, row: Record<string, unknown>) => { records.set(ref.path, row); });
const txUpdate = jest.fn((ref: { path: string }, row: Record<string, unknown>) => {
  records.set(ref.path, { ...records.get(ref.path), ...row });
});
const txSet = jest.fn((ref: { path: string }, row: Record<string, unknown>) => { records.set(ref.path, row); });
const companyGet = jest.fn(async () => ({ exists: true, data: () => ({ status: 'active' }) }));
const bindingGet = jest.fn(async (): Promise<{ val: () => { driverId: string } | null }> => ({ val: () => null }));
const companyDoc = jest.fn((id: string) => ({ get: companyGet, collection: (name: string) => ({
  doc: (documentId: string) => ({ path: `companies/${id}/${name}/${documentId}`,
    get: async () => ({ exists: records.has(`companies/${id}/${name}/${documentId}`),
      data: () => records.get(`companies/${id}/${name}/${documentId}`) }),
  }),
}) }));
const txGet = jest.fn(async (ref: { path: string }) => ({
  exists: records.has(ref.path), data: () => records.get(ref.path),
}));
const runTransaction = jest.fn(async (fn: (tx: { get: typeof txGet; create: typeof txCreate;
  update: typeof txUpdate; set: typeof txSet }) => Promise<void>) =>
  fn({ get: txGet, create: txCreate, update: txUpdate, set: txSet }));
const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11]);
const imageHash = createHash('sha256').update(imageBytes).digest('hex');
const fileMock = {
  getSignedUrl: jest.fn(async () => ['https://signed.example/temporary']),
  getMetadata: jest.fn(async () => [{ contentType: 'image/jpeg', size: String(imageBytes.length),
    metadata: { sha256: imageHash }, generation: '1' }]),
  download: jest.fn(async () => [imageBytes]),
};

function request(report: ReturnType<typeof fixture>, uid = driverAuthUid(driverId)) {
  return { auth: { uid, token: { kind: 'driver', driverId } },
    data: { schemaVersion: 1, report, reportDigest: digestReport(report) } };
}

beforeEach(() => {
  jest.clearAllMocks(); records.clear();
  process.env.WB_EQUIPMENT_FULL_DVIR_ENABLED = 'true';
  delete process.env.WB_EQUIPMENT_DEFECT_EVIDENCE_ENABLED;
  (loadCanonicalDriverAuthority as jest.Mock).mockResolvedValue({ active: true, companyId: 'acme' });
  (admin.firestore as unknown as jest.Mock).mockReturnValue({ collection: (name: string) => {
    if (name !== 'companies') throw new Error(`Unexpected collection ${name}`);
    return { doc: companyDoc };
  }, runTransaction });
  (admin.database as unknown as jest.Mock).mockReturnValue({ ref: (path: string) => ({ once: async () => path.startsWith('drivers/profiles/')
    ? { val: () => ({ driverHash: 'driver1' }) } : bindingGet() }) });
  (admin.storage as unknown as jest.Mock).mockReturnValue({ bucket: () => ({ file: () => fileMock }) });
});

afterAll(() => { delete process.env.WB_EQUIPMENT_FULL_DVIR_ENABLED; });

test('disabled capability reports false and submit fails without a write', async () => {
  delete process.env.WB_EQUIPMENT_FULL_DVIR_ENABLED;
  await expect(getCapabilities({ auth: request(fixture()).auth, data: { schemaVersion: 1 } } as never))
    .resolves.toMatchObject({ enabled: false, companyId: 'acme' });
  await expect(submitFullReport(request(fixture()) as never)).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(runTransaction).not.toHaveBeenCalled();
});

test('rejects wrong auth, inactive driver and foreign company before a write', async () => {
  await expect(submitFullReport(request(fixture(), 'driver_wrong') as never)).rejects.toMatchObject({ code: 'unauthenticated' });
  (loadCanonicalDriverAuthority as jest.Mock).mockResolvedValueOnce({ active: false, companyId: 'acme' });
  await expect(submitFullReport(request(fixture()) as never)).rejects.toMatchObject({ code: 'permission-denied' });
  const foreign = fixture(); foreign.companyId = 'other';
  await expect(submitFullReport(request(foreign) as never)).rejects.toMatchObject({ code: 'invalid-argument' });
  expect(runTransaction).not.toHaveBeenCalled();
});

test('historical driver hash needs the approved binding for this canonical driver', async () => {
  const legacy = fixture(); legacy.driver.driverHash = 'legacy1'; legacy.signature.signerId = 'legacy1';
  await expect(submitFullReport(request(legacy) as never)).rejects.toMatchObject({ code: 'permission-denied' });
  expect(runTransaction).not.toHaveBeenCalled();
  bindingGet.mockResolvedValueOnce({ val: () => ({ driverId }) });
  await expect(submitFullReport(request(legacy) as never)).resolves.toMatchObject({ accepted: true });
  expect(txCreate).toHaveBeenCalledTimes(1);
});

test('same signed report retries to the same receipt; changed body conflicts', async () => {
  const first = fixture();
  const receipt = await submitFullReport(request(first) as never);
  expect(receipt).toMatchObject({ accepted: true, companyId: 'acme', reportDigest: digestReport(first) });
  expect(txCreate).toHaveBeenCalledTimes(1);
  await expect(submitFullReport(request(first) as never)).resolves.toEqual(receipt);
  expect(txCreate).toHaveBeenCalledTimes(1);
  const changed = fixture(); changed.timezone = 'UTC';
  await expect(submitFullReport(request(changed) as never)).rejects.toMatchObject({ code: 'already-exists' });
  expect(txCreate).toHaveBeenCalledTimes(1);
  expect(records.size).toBe(1);
});

test('verified sidecar must cover exact signed issue and digest; retries remain immutable', async () => {
  process.env.WB_EQUIPMENT_DEFECT_EVIDENCE_ENABLED = 'true';
  const report = fixture();
  (report.issues[0].evidence as object[]).push({ localDraftRef: 'photo1', sha256: 'a'.repeat(64),
    byteLength: 123, contentType: 'image/jpeg' });
  const parsed = validateFullReport(report, 'acme', { allowOwnedEvidence: true });
  const binding = bindingFor({ companyId: 'acme', driverId }, parsed, parsed.evidence[0], digestReport(report));
  const evidenceId = evidenceIdFor(binding);
  const path = `companies/acme/equipment_inspection_evidence/${evidenceId}`;
  const storagePath = `companies/acme/equipment-inspection-evidence/${driverId}/${evidenceId}.jpg`;
  const withReceipts = { ...request(report), data: { ...request(report).data, evidenceReceiptIds: [evidenceId] } };
  await expect(submitFullReport(withReceipts as never)).rejects.toMatchObject({ code: 'failed-precondition' });
  records.set(path, { binding, storagePath, state: 'verified', generation: '1' });
  const receipt = await submitFullReport(withReceipts as never);
  expect(receipt).toMatchObject({ accepted: true });
  await expect(submitFullReport(withReceipts as never)).resolves.toEqual(receipt);
  const other = { ...request(report), data: { ...request(report).data, evidenceReceiptIds: ['e_'+ 'b'.repeat(64)] } };
  await expect(submitFullReport(other as never)).rejects.toMatchObject({ code: 'invalid-argument' });
  const reportDocPath = receipt.storagePath;
  records.delete(reportDocPath);
  records.set(path, { binding: { ...binding, issueId: 'substituted' }, storagePath,
    state: 'verified', generation: '1' });
  await expect(submitFullReport(withReceipts as never)).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(txCreate).toHaveBeenCalledTimes(1);
});

test('evidence begin is idempotent and finalize verifies real bytes before receipt', async () => {
  process.env.WB_EQUIPMENT_DEFECT_EVIDENCE_ENABLED = 'true';
  const actor = { companyId: 'acme', driverId };
  const data = { reportIdentity: { inspectionId: 'inspection1', inspectionType: 'pre_trip',
    reportId: 'inspection1', version: 1 }, reportDigest: 'a'.repeat(64), issueId: 'issue1',
    areaId: 'tank', itemId: 'valves', localEvidenceId: 'photo1', sha256: imageHash,
    byteLength: imageBytes.length, contentType: 'image/jpeg' };
  const first = await beginEvidenceUpload(actor, data);
  const second = await beginEvidenceUpload(actor, data);
  expect(second.evidenceId).toBe(first.evidenceId);
  expect(txCreate).toHaveBeenCalledTimes(1);
  await expect(finalizeEvidenceUpload({ companyId: 'acme', driverId: 'another-driver' }, first.evidenceId))
    .rejects.toMatchObject({ code: 'permission-denied' });
  fileMock.getMetadata.mockResolvedValueOnce([{ contentType: 'image/jpeg', size: String(imageBytes.length),
    metadata: { sha256: '0'.repeat(64) }, generation: '1' }]);
  await expect(finalizeEvidenceUpload(actor, first.evidenceId)).rejects.toMatchObject({ code: 'failed-precondition' });
  const receipt = await finalizeEvidenceUpload(actor, first.evidenceId);
  expect(receipt).toMatchObject({ state: 'verified', receiptId: first.evidenceId });
  await expect(finalizeEvidenceUpload(actor, first.evidenceId)).resolves.toEqual(receipt);
  expect(txUpdate).toHaveBeenCalledTimes(1);
});
