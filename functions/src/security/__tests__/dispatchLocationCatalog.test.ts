const mockGet = jest.fn();
const mockWhere = jest.fn();
const mockTrusted = jest.fn();
jest.mock('firebase-admin', () => ({
  database: () => ({ ref: () => ({ once: async () => ({ val: () => ({
    'Demo Well 1': { companyId: 'wellbuilt-demo', name: 'Demo Well 1' },
    'Other Well': { companyId: 'hauler-a', name: 'Other Well' },
  }) }) }) }),
  firestore: () => ({ collection: (name: string) => ({
  doc: (id: string) => ({ get: () => mockGet(name, id), collection: () => ({ get: async () => ({ docs: [] }), limit: () => ({ get: async () => ({ docs: [] }) }) }) }),
  where: (field: string, op: string, value: string) => { mockWhere(name, field, op, value); return { limit: () => ({ get: async () => ({ docs: [] }) }) }; },
  limit: () => ({ get: async () => ({ docs: [] }) }),
}) }) }));
jest.mock('firebase-functions/v2/https', () => ({
  onCall: (_opts: unknown, handler: unknown) => handler,
  HttpsError: class extends Error { code: string; constructor(code: string, msg: string) { super(msg); this.code = code; } },
}));
jest.mock('../trustedStaffAuthority', () => ({ requireTrustedCompanyCapability: (...args: unknown[]) => mockTrusted(...args) }));
import { getDispatchLocationCatalog } from '../dispatchLocationCatalog';
const invoke = getDispatchLocationCatalog as unknown as (request: unknown) => Promise<unknown>;
beforeEach(() => {
  jest.clearAllMocks();
  mockTrusted.mockResolvedValue({ companyId: 'hauler-a' });
  mockGet.mockImplementation(async (collection, id) => collection === 'platform_admins'
    ? { exists: true, data: () => ({ enabled: true, policyVersion: 1 }) }
    : { exists: id === 'hauler-a', data: () => ({ assignedOperators: ['Assigned Operator'] }) });
});
test('unsigned caller cannot read catalog', async () => {
  await expect(invoke({ data: { companyId: 'hauler-a' } })).rejects.toMatchObject({ code: 'unauthenticated' });
});
test('company staff cannot select another company', async () => {
  await expect(invoke({ auth: { uid: 'staff', token: {} }, data: { companyId: 'hauler-b' } })).rejects.toMatchObject({ code: 'permission-denied' });
});
test('company read uses server-assigned operators and ignores requested operator', async () => {
  await invoke({ auth: { uid: 'staff', token: {} }, data: { companyId: 'hauler-a', operator: 'Unrelated Operator' } });
  expect(mockTrusted).toHaveBeenCalledWith('staff', 'viewDispatch');
  expect(mockWhere).toHaveBeenCalledWith('wells', 'operator', '==', 'Assigned Operator');
  expect(mockWhere).not.toHaveBeenCalledWith('wells', 'operator', '==', 'Unrelated Operator');
});
test('verified enabled platform admin can select a company', async () => {
  await expect(invoke({ auth: { uid: 'platform', token: { wellbuiltAdmin: true } }, data: { companyId: 'hauler-a' } })).resolves.toMatchObject({ companyId: 'hauler-a' });
  expect(mockTrusted).not.toHaveBeenCalled();
});
test('untrusted staff is denied, never falls back to driver or public reads', async () => {
  mockTrusted.mockRejectedValue(new Error('denied'));
  await expect(invoke({ auth: { uid: 'driver', token: {} }, data: { companyId: 'hauler-a' } })).rejects.toThrow('denied');
  expect(mockWhere).not.toHaveBeenCalled();
});

test('shared demo viewer sees only its tenant locations', async () => {
  const auth = { uid: 'wellbuilt-demo-shared-viewer', token: {
    staffRole: 'demo_viewer', staffCompanyId: 'wellbuilt-demo', isDemo: true,
  } };
  const result = await invoke({ auth, data: { companyId: 'wellbuilt-demo' } }) as {
    companyId: string; wells: Array<{ well_name: string }>;
  };
  expect(result.companyId).toBe('wellbuilt-demo');
  expect(result.wells.map(well => well.well_name)).toContain('Demo Well 1');
  expect(result.wells.map(well => well.well_name)).not.toContain('Other Well');
  expect(mockWhere).not.toHaveBeenCalled();
  expect(mockTrusted).not.toHaveBeenCalled();
  await expect(invoke({ auth, data: { companyId: 'hauler-a' } }))
    .rejects.toMatchObject({ code: 'permission-denied' });
});
