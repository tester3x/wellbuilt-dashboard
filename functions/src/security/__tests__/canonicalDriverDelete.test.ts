jest.mock('firebase-functions/v2/https', () => ({
  onCall: (_options: unknown, handler: unknown) => handler,
  HttpsError: class extends Error { constructor(public code: string, message: string) { super(message); } },
}));
jest.mock('../adminAuth', () => ({ requireManageDrivers: jest.fn(), requirePlatformAdmin: jest.fn() }));
jest.mock('../audit', () => ({ writeSecurityAudit: jest.fn() }));
jest.mock('../tokenMint', () => ({ driverAuthUid: (id: string) => `driver:${id}` }));
jest.mock('@tester3x/wellbuilt-contracts', () => ({}));
jest.mock('firebase-admin', () => ({ firestore: jest.fn(), database: jest.fn(), auth: jest.fn() }));

import * as admin from 'firebase-admin';
import { requirePlatformAdmin } from '../adminAuth';
import { adminDeleteSecureDriver } from '../driverAuthCallables';

const invoke = (data = { driverId: 'driver-123', confirm: 'DELETE_SECURE_DRIVER' }) =>
  (adminDeleteSecureDriver as unknown as (r: unknown) => Promise<unknown>)({ auth: { uid: 'admin', token: {} }, data });
let remove: jest.Mock, deleteUser: jest.Mock, transactionDelete: jest.Mock;
let owner = 'driver-123';
beforeEach(() => {
  jest.clearAllMocks(); owner = 'driver-123';
  (requirePlatformAdmin as jest.Mock).mockResolvedValue({ uid: 'admin', isPlatformAdmin: true });
  remove = jest.fn().mockResolvedValue(undefined);
  deleteUser = jest.fn().mockResolvedValue(undefined);
  transactionDelete = jest.fn();
  const credentialRef = { update: jest.fn().mockResolvedValue(undefined) };
  (admin.firestore as unknown as jest.Mock).mockReturnValue({
    collection: (collection: string) => ({ doc: (id: string) => ({ collection, id,
      get: async () => ({ exists: true, data: () => ({ displayNameNorm: 'driver' }), ref: credentialRef }),
    }) }),
    runTransaction: async (fn: (tx: unknown) => unknown) => fn({
      get: async () => ({ data: () => ({ driverId: owner }) }), delete: transactionDelete,
    }),
  });
  (admin.database as unknown as jest.Mock).mockReturnValue({ ref: () => ({ remove }) });
  (admin.auth as unknown as jest.Mock).mockReturnValue({ deleteUser });
});
test('non-platform callers cannot delete', async () => {
  (requirePlatformAdmin as jest.Mock).mockRejectedValue(new Error('permission-denied'));
  await expect(invoke()).rejects.toThrow('permission-denied');
  expect(admin.firestore).not.toHaveBeenCalled();
});
test('requires exact confirmation and a single valid ID', async () => {
  await expect(invoke({ driverId: '../profiles', confirm: 'DELETE_SECURE_DRIVER' })).rejects.toThrow();
  await expect(invoke({ driverId: 'driver-123', confirm: '' })).rejects.toThrow();
  expect(admin.firestore).not.toHaveBeenCalled();
});
test('removes only secure records after disabling credentials', async () => {
  await expect(invoke()).resolves.toEqual({ ok: true });
  expect(deleteUser).toHaveBeenCalledWith('driver:driver-123');
  expect(remove).toHaveBeenCalledTimes(1);
  expect(transactionDelete).toHaveBeenCalledTimes(2);
});
test('does not swallow database failure', async () => {
  remove.mockRejectedValue(new Error('database unavailable'));
  await expect(invoke()).rejects.toThrow('database unavailable');
  expect(transactionDelete).not.toHaveBeenCalled();
});
test('does not swallow Auth failure', async () => {
  deleteUser.mockRejectedValue({ code: 'auth/internal-error' });
  await expect(invoke()).rejects.toEqual({ code: 'auth/internal-error' });
  expect(remove).not.toHaveBeenCalled();
});
test('missing Auth user is retryable, another name owner is preserved', async () => {
  deleteUser.mockRejectedValue({ code: 'auth/user-not-found' }); owner = 'someone-else';
  await expect(invoke()).resolves.toEqual({ ok: true });
  expect(transactionDelete).toHaveBeenCalledTimes(1);
});
