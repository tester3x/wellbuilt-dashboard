jest.mock('firebase-functions/v2/https', () => ({ onCall: (_options: unknown, handler: unknown) => handler,
  HttpsError: class extends Error { constructor(public code: string, message: string) { super(message); } } }));
jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
jest.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => 'COMMIT_TIME' } }));
jest.mock('../../requireDriverAuth', () => ({ requireSecureDriver: async () => ({ companyId: 'company', driverId: 'driver' }) }));
jest.mock('../dispatchPacketPin', () => ({ parsePacketRef: () => ({ ok: true, packetRef: {} }) }));
jest.mock('../dispatchPinRuntime', () => ({ loadAuthorizedWellNames: async () => [], checkWell: () => ({ ok: true }),
  loadVerifiedRevision: async () => ({ ok: true, envelope: {} }) }));
jest.mock('../createDriverDispatch', () => ({ driverMayJoinProject: () => true, evaluateDriverDispatchBirth: jest.fn() }));
import * as admin from 'firebase-admin';
import { evaluateDriverDispatchBirth } from '../createDriverDispatch';
import { createDriverDispatchIfAbsent } from '../../createDriverDispatchCallable';

test('creation writes assignment and immutable birth in one transaction; lost-ack replay never backfills birth', async () => {
  const writes: any[] = [];
  let exists = false;
  const doc = (collection: string, id: string) => ({ path: `${collection}/${id}` });
  (admin.firestore as unknown as jest.Mock).mockReturnValue({
    collection: (name: string) => ({ doc: (id: string) => doc(name, id) }),
    runTransaction: async (run: any) => run({
      get: async (ref: any) => ({ exists: ref.path === 'dispatches/job' && exists, data: () => ({}) }),
      create: (ref: any, data: any) => writes.push({ path: ref.path, data }),
    }),
  });
  (evaluateDriverDispatchBirth as jest.Mock).mockReturnValue({ ok: true, result: 'created', fields: { status: 'pending' } });
  const invoke = createDriverDispatchIfAbsent as unknown as (request: any) => Promise<any>;
  await invoke({ data: { dispatchId: 'job', record: {}, packetRef: {} } });
  expect(writes).toEqual([
    { path: 'dispatches/job', data: { status: 'pending', assignedAt: 'COMMIT_TIME', driverCreateAssignedAt: 'COMMIT_TIME' } },
    { path: 'driver_dispatch_births/job', data: { dispatchId: 'job', companyId: 'company', driverId: 'driver', assignedAt: 'COMMIT_TIME' } },
  ]);
  writes.length = 0; exists = true;
  (evaluateDriverDispatchBirth as jest.Mock).mockReturnValue({ ok: true, result: 'already_exists' });
  expect(await invoke({ data: { dispatchId: 'job', record: {}, packetRef: {} } })).toMatchObject({ result: 'already_exists' });
  expect(writes).toEqual([]);
});
