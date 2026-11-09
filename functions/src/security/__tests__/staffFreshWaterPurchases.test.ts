import { getFirestore } from 'firebase-admin/firestore';
import { staffFreshWaterPurchases } from '../staffFreshWaterPurchases';
import { requireTrustedCompanyCapability } from '../trustedStaffAuthority';

jest.mock('../trustedStaffAuthority', () => ({ requireTrustedCompanyCapability: jest.fn() }));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(),
  FieldValue: { serverTimestamp: () => 'server-time' },
}));

const authority = jest.mocked(requireTrustedCompanyCapability);
const data = new Map<string, Record<string, unknown>>();
const run = (request: Record<string, unknown>) => staffFreshWaterPurchases.run({
  data: request,
  auth: { uid: 'staff' },
} as Parameters<typeof staffFreshWaterPurchases.run>[0]);

const purchase = {
  op: 'save', ticketId: 'ticket-a', receipt: 'Depot-123', account: 'company',
  amountCents: null, status: 'awaiting_bill', revision: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  data.clear();
  data.set('tickets/ticket-a', {
    type: 'Fresh Water', companyId: 'test-hauler', location: 'Test depot', dispatchId: 'dispatch-a',
  });
  data.set('dispatches/dispatch-a', { companyId: 'test-hauler', freshWaterAccount: 'company' });
  data.set('companies/test-hauler', { assignedOperators: ['Test Operator'] });
  authority.mockResolvedValue({ uid: 'staff', companyId: 'test-hauler' });

  const snapshot = (path: string) => ({ id: path.split('/').at(-1), data: () => data.get(path) });
  const collection = (path: string) => ({
    doc: (id: string) => ({
      id, path: path + '/' + id, get: async () => snapshot(path + '/' + id),
      collection: (name: string) => collection(path + '/' + id + '/' + name),
      set: async (value: Record<string, unknown>) => { data.set(path + '/' + id, value); },
      delete: async () => { data.delete(path + '/' + id); },
    }),
    get: async () => ({ docs: Array.from(data.keys()).filter(key => key.startsWith(path + '/')).map(snapshot) }),
    where: (field: string, _op: string, value: string) => ({
      get: async () => ({ docs: Array.from(data).filter(([key, row]) =>
        key.startsWith(path + '/') && row[field] === value).map(([key]) => snapshot(key)) }),
    }),
  });
  jest.mocked(getFirestore).mockReturnValue({
    collection,
    runTransaction: async (fn: Function) => fn({
      get: async (ref: { path: string }) => snapshot(ref.path),
      set: (ref: { path: string }, value: Record<string, unknown>) => { data.set(ref.path, value); },
    }),
  } as unknown as ReturnType<typeof getFirestore>);
});

test('stores the depot default privately and clears it without changing the customer billing configuration', async () => {
  const save = { op: 'saveDefault', companyId: 'test-hauler', operator: 'Test Operator', account: 'customer' };
  await expect(run({ ...save, companyId: 'another-hauler' })).rejects.toMatchObject({ code: 'permission-denied' });
  await expect(run({ ...save, operator: 'Unknown Operator' })).rejects.toMatchObject({ code: 'not-found' });
  await expect(run(save)).resolves.toEqual({ account: 'customer' });
  expect(authority).toHaveBeenLastCalledWith('staff', 'editBilling');
  const list = { op: 'listDefaults', companyId: 'test-hauler', forDispatch: true };
  await expect(run(list)).resolves.toEqual({ defaults: [{ operator: 'test operator', account: 'customer' }] });
  expect(authority).toHaveBeenLastCalledWith('staff', 'manageDrivers');
  await run({ ...save, account: null });
  await expect(run(list)).resolves.toEqual({ defaults: [] });
  expect(data.get('companies/test-hauler')).toEqual({ assignedOperators: ['Test Operator'] });
});

test('requires trusted billing capability and restricts each read and write to the ticket company', async () => {
  authority.mockResolvedValue({ uid: 'staff', companyId: 'another-hauler' });
  await expect(run({ op: 'list', ticketId: 'ticket-a' })).rejects.toMatchObject({ code: 'not-found' });
  expect(authority).toHaveBeenCalledWith('staff', 'viewBilling');
  await expect(run(purchase)).rejects.toMatchObject({ code: 'not-found' });
  expect(authority).toHaveBeenCalledWith('staff', 'editBilling');
});

test('replays a save without duplication and prevents reuse of the same depot receipt on another ticket', async () => {
  const created = await run(purchase);
  expect(await run({ ...purchase, receipt: 'depot-123' })).toEqual(created);
  const result = await run({ op: 'list', ticketId: 'ticket-a' });
  expect(result).toMatchObject({ plannedAccount: 'company', purchases: [{ revision: 1 }] });
  data.set('tickets/ticket-b', { ...data.get('tickets/ticket-a') });
  await expect(run({ ...purchase, ticketId: 'ticket-b' })).rejects.toMatchObject({ code: 'already-exists' });
});

test('requires an invoice reference to mark a charge billed back and rejects stale edits', async () => {
  const { purchase: created } = await run(purchase) as { purchase: { id: string; revision: number } };
  const edit = { ...purchase, id: created.id, revision: created.revision, amountCents: 1720, status: 'billed_back' };
  await expect(run(edit)).rejects.toMatchObject({ code: 'invalid-argument' });
  const billed = { ...edit, invoiceRef: 'Test Invoice' };
  await expect(run(billed)).resolves.toMatchObject({ purchase: { status: 'billed_back', revision: 2 } });
  await expect(run({ ...billed, invoiceRef: 'Stale Invoice' })).rejects.toMatchObject({ code: 'aborted' });
  await expect(run({ ...billed, account: 'customer' })).rejects.toMatchObject({ code: 'invalid-argument' });
});
