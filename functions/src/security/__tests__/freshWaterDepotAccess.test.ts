const mockRead = jest.fn();
const mockSet = jest.fn();
const mockDelete = jest.fn();
const mockAudit = jest.fn();

jest.mock('firebase-admin', () => {
  const collection = (prefix: string, name: string) => ({
    doc: (id: string) => {
      const path = prefix + name + '/' + id;
      return {
        collection: (child: string) => collection(path + '/', child),
        get: () => mockRead(path),
        set: (value: unknown) => mockSet(path, value),
        delete: () => mockDelete(path),
      };
    },
  });
  return { firestore: Object.assign(() => ({ collection: (name: string) => collection('', name) }), {
    FieldValue: { serverTimestamp: () => 'timestamp' },
  }) };
});
jest.mock('firebase-functions/v2/https', () => ({
  onCall: (handler: unknown) => handler,
  HttpsError: class extends Error { constructor(public code: string, message: string) { super(message); } },
}));
jest.mock('../audit', () => ({ writeSecurityAudit: (entry: unknown) => mockAudit(entry) }));

import { staffFreshWaterDepotAccess } from '../freshWaterDepotAccess';

const call = staffFreshWaterDepotAccess as unknown as (request: unknown) => Promise<unknown>;
const staff = { uid: 'dispatch-uid', token: {} };
const selection = { companyId: 'company-a', catalogId: 'nd-dwr:27' };
const privatePath = 'fresh_water_depot_access/company-a/depots/nd-dwr-27';
const credentials = { login: 'fictional-account', passcode: '00123' };

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockImplementation((path: string) => {
    const records: Record<string, Record<string, unknown>> = {
      'trusted_staff_authority/dispatch-uid': {
        schemaVersion: 1, uid: 'dispatch-uid', companyId: 'company-a', active: true, capabilities: ['createDispatch'],
      },
      'companies/company-a': {},
      'freshWaterDepots/nd-dwr-27': { catalogId: 'nd-dwr:27', source: 'ND DWR' },
      [privatePath]: credentials,
    };
    const data = records[path];
    return { exists: !!data, data: () => data, get: (field: string) => data?.[field] };
  });
});

test('driver, anonymous, and cross-company callers cannot reach credentials', async () => {
  const data = { ...selection, action: 'read' };
  await expect(call({ data })).rejects.toMatchObject({ code: 'unauthenticated' });
  await expect(call({ auth: { ...staff, token: { kind: 'driver' } }, data })).rejects.toMatchObject({ code: 'permission-denied' });
  await expect(call({ auth: staff, data: { ...data, companyId: 'company-b' } })).rejects.toMatchObject({ code: 'permission-denied' });
  expect(mockRead).not.toHaveBeenCalledWith(privatePath);
  expect(mockSet).not.toHaveBeenCalled();
});

test('staff may read, update and clear the exact company depot without auditing secrets', async () => {
  await expect(call({ auth: staff, data: { ...selection, action: 'read' } })).resolves.toEqual(credentials);
  await expect(call({ auth: staff, data: { ...selection, action: 'save', ...credentials } })).resolves.toEqual({ ok: true });
  await expect(call({ auth: staff, data: { ...selection, action: 'clear' } })).resolves.toEqual({ ok: true });
  expect(mockSet).toHaveBeenCalledWith(privatePath, expect.objectContaining(credentials));
  expect(mockDelete).toHaveBeenCalledWith(privatePath);
  expect(JSON.stringify(mockAudit.mock.calls)).not.toContain(credentials.passcode);
  expect(JSON.stringify(mockAudit.mock.calls)).not.toContain(credentials.login);
});

test('a noncatalog or unknown depot cannot receive credentials', async () => {
  await expect(call({ auth: staff, data: { ...selection, catalogId: 'nd-dwr:99', action: 'save', ...credentials } }))
    .rejects.toMatchObject({ code: 'not-found' });
  expect(mockSet).not.toHaveBeenCalled();
});
