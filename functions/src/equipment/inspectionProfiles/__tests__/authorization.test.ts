jest.mock('firebase-admin', () => ({
  database: jest.fn(), firestore: jest.fn(), storage: jest.fn(),
}));
jest.mock('../../../security/canonicalDriverAuthority', () => ({
  loadCanonicalDriverAuthority: jest.fn(), productionCanonicalDriverReaders: jest.fn(() => ({})),
}));

import * as admin from 'firebase-admin';
import { loadCanonicalDriverAuthority } from '../../../security/canonicalDriverAuthority';
import { authorizeProfileActor } from '../service';

const auth = { uid: 'staff1', token: {} };
const request = (companyId: string) => ({ auth, data: { schemaVersion: 1, companyId } });
const fakeDb = (record: Record<string, unknown> | null, companyStatus = 'active') => {
  (admin.database as unknown as jest.Mock).mockReturnValue({ ref: () => ({ once: async () => ({ exists: () => !!record, val: () => record }) }) });
  (admin.firestore as unknown as jest.Mock).mockReturnValue({ collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ status: companyStatus }) }) }) }) });
};

beforeEach(() => jest.clearAllMocks());

test('dashboard company scope comes from live membership, not request companyId', async () => {
  fakeDb({ companyId: 'acme', roles: ['admin'] });
  await expect(authorizeProfileActor(request('other'))).rejects.toMatchObject({ code: 'permission-denied' });
  await expect(authorizeProfileActor(request('acme'))).resolves.toMatchObject({ companyId: 'acme', canManage: true });
});

test('ordinary dashboard viewer cannot edit; inactive company fails closed', async () => {
  fakeDb({ companyId: 'acme', roles: ['viewer'] });
  await expect(authorizeProfileActor(request('acme'))).rejects.toMatchObject({ code: 'permission-denied' });
  fakeDb({ companyId: 'acme', roles: ['admin'] }, 'inactive');
  await expect(authorizeProfileActor(request('acme'))).rejects.toMatchObject({ code: 'permission-denied' });
});

test('driver claims require canonical live company match and live admin role', async () => {
  const driver = { auth: { uid: 'driver_abc', token: { kind: 'driver', driverId: 'abc', companyId: 'acme' } },
    data: { schemaVersion: 1, companyId: 'other' } };
  fakeDb({ companyId: 'acme', roles: ['driver'] });
  (loadCanonicalDriverAuthority as jest.Mock).mockResolvedValue({ active: true, companyId: 'acme' });
  await expect(authorizeProfileActor(driver)).resolves.toMatchObject({ companyId: 'acme', canManage: false });
  fakeDb({ companyId: 'acme', roles: ['admin'] });
  await expect(authorizeProfileActor(driver)).resolves.toMatchObject({ canManage: true });
  (loadCanonicalDriverAuthority as jest.Mock).mockResolvedValue({ active: true, companyId: 'other' });
  await expect(authorizeProfileActor(driver)).rejects.toMatchObject({ code: 'permission-denied' });
});
