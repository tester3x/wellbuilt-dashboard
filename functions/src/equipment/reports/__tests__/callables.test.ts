jest.mock('firebase-admin', () => ({
  database: jest.fn(), firestore: Object.assign(jest.fn(), {
    FieldValue: { serverTimestamp: jest.fn(() => 'server-time') },
  }),
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
import { fixture } from './reportFixture';

const driverId = '01234567-89ab-4cde-8fab-0123456789ab';
const records = new Map<string, Record<string, unknown>>();
const txCreate = jest.fn((ref: { path: string }, row: Record<string, unknown>) => { records.set(ref.path, row); });
const companyGet = jest.fn(async () => ({ exists: true, data: () => ({ status: 'active' }) }));
const bindingGet = jest.fn(async (): Promise<{ val: () => { driverId: string } | null }> => ({ val: () => null }));
const companyDoc = jest.fn((id: string) => ({ get: companyGet, collection: (name: string) => ({
  doc: (documentId: string) => ({ path: `companies/${id}/${name}/${documentId}` }),
}) }));
const txGet = jest.fn(async (ref: { path: string }) => ({
  exists: records.has(ref.path), data: () => records.get(ref.path),
}));
const runTransaction = jest.fn(async (fn: (tx: { get: typeof txGet; create: typeof txCreate }) => Promise<void>) =>
  fn({ get: txGet, create: txCreate }));

function request(report: ReturnType<typeof fixture>, uid = driverAuthUid(driverId)) {
  return { auth: { uid, token: { kind: 'driver', driverId } },
    data: { schemaVersion: 1, report, reportDigest: digestReport(report) } };
}

beforeEach(() => {
  jest.clearAllMocks(); records.clear();
  process.env.WB_EQUIPMENT_FULL_DVIR_ENABLED = 'true';
  (loadCanonicalDriverAuthority as jest.Mock).mockResolvedValue({ active: true, companyId: 'acme' });
  (admin.firestore as unknown as jest.Mock).mockReturnValue({ collection: (name: string) => {
    if (name !== 'companies') throw new Error(`Unexpected collection ${name}`);
    return { doc: companyDoc };
  }, runTransaction });
  (admin.database as unknown as jest.Mock).mockReturnValue({ ref: (path: string) => ({ once: async () => path.startsWith('drivers/profiles/')
    ? { val: () => ({ driverHash: 'driver1' }) } : bindingGet() }) });
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
