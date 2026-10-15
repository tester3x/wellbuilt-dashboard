jest.mock('firebase-functions/v2/https', () => ({
  onCall: (_options: unknown, fn: unknown) => fn,
  HttpsError: class extends Error { constructor(public code: string, message: string) { super(message); } },
}));
const rows = new Map<string, any>();
const writes: Array<[string, any]> = [];
jest.mock('firebase-admin', () => ({ firestore: () => ({
  collection: (name: string) => ({ doc: (id: string) => ({ path: `${name}/${id}` }) }),
  runTransaction: (fn: any) => fn({
    get: async (ref: any) => ({ exists: rows.has(ref.path), data: () => rows.get(ref.path) }),
    update: (ref: any, value: any) => writes.push([ref.path, value]),
  }),
}) }));
jest.mock('firebase-admin/firestore', () => ({ FieldValue: { delete: () => 'DELETE', serverTimestamp: () => 'NOW' } }));
jest.mock('../../requireDriverAuth', () => ({ requireSecureDriver: async () => ({ driverId: 'driver', companyId: 'company' }) }));
import { resolveDriverJobCancellation } from '../resolveDriverJobCancellation';
const invoke = (data: any) => (resolveDriverJobCancellation as any)({ data });
beforeEach(() => {
  rows.clear(); writes.length = 0;
  rows.set('dispatches/job', { companyId: 'company', driverId: 'driver', invoiceDocId: 'invoice', status: 'in_progress', loadsCompleted: 1 });
  rows.set('invoices/invoice', { companyId: 'company', dispatchId: 'job', status: 'open', totalBBL: 0, tickets: [] });
});
test('cancel persists optional blank reason and terminalizes invoice without deleting data', async () => {
  expect(await invoke({ dispatchId: 'job', invoiceDocId: 'invoice', action: 'cancel', reason: '' })).toMatchObject({ result: 'cancelled' });
  expect(writes.find(([path]) => path === 'dispatches/job')?.[1]).toMatchObject({ status: 'cancelled', cancelReason: '', declineReason: '' });
  expect(writes.find(([path]) => path === 'invoices/invoice')?.[1]).toMatchObject({ status: 'cancelled' });
});
test('return to pending detaches previous invoice and restores unstarted load count', async () => {
  await invoke({ dispatchId: 'job', invoiceDocId: 'invoice', action: 'return_pending', reason: 'Changed plans' });
  expect(writes.find(([path]) => path === 'dispatches/job')?.[1]).toMatchObject({ status: 'pending', invoiceDocId: 'DELETE', loadsCompleted: 0, driverStage: 'DELETE' });
});
test('ownership and invoice mismatch fail before writes', async () => {
  await expect(invoke({ dispatchId: 'job', action: 'cancel', invoiceDocId: 'old' })).rejects.toThrow('earlier invoice');
  rows.get('dispatches/job').driverId = 'other';
  await expect(invoke({ dispatchId: 'job', action: 'cancel' })).rejects.toThrow('ownership');
  expect(writes).toHaveLength(0);
});
test('loaded and transferred work cannot be cancelled', async () => {
  rows.get('invoices/invoice').totalBBL = 140;
  await expect(invoke({ dispatchId: 'job', action: 'cancel' })).rejects.toThrow('Loaded');
  expect(writes).toHaveLength(0);
});
test('removed and terminal jobs are acknowledged without recreation', async () => {
  rows.delete('dispatches/job');
  expect(await invoke({ dispatchId: 'job', action: 'cancel' })).toMatchObject({ result: 'removed' });
  expect(writes).toHaveLength(0);
});
test('remaining multi-load work cycles pending without refunding cancelled load', async () => {
  rows.get('dispatches/job').loadCount = 3;
  await invoke({ dispatchId: 'job', action: 'cancel_or_cycle' });
  expect(writes.find(([path]) => path === 'dispatches/job')?.[1]).toMatchObject({ status: 'pending', loadsCompleted: 1 });
});
