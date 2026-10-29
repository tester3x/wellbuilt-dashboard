jest.mock('firebase-functions/v2/https', () => ({
  onCall: (_options: unknown, fn: unknown) => fn,
  HttpsError: class extends Error { constructor(public code: string, message: string) { super(message); } },
}));
const rows = new Map<string, any>();
const writes: Array<[string, any]> = [];
jest.mock('firebase-admin', () => ({ firestore: () => ({
  collection: (name: string) => {const q: any = {name, filters: [], doc: (id: string) => ({path: `${name}/${id}`}), where: (...filter: any[]) => {q.filters.push(filter); return q;}}; return q;},
  runTransaction: (fn: any) => fn({
    get: async (ref: any) => ref.filters ? {docs: [...rows].filter(([path,data]) => path.startsWith(ref.name+'/') && ref.filters.every(([key,op,value]: any[]) => data[key]===value)).map(([path,data]) => ({id:path.split('/')[1],data:()=>data}))} : ({ exists: rows.has(ref.path), data: () => rows.get(ref.path) }),
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

test('declining the next pending load does not change the previous closed invoice', async () => {
  rows.get('dispatches/job').status = 'pending';
  Object.assign(rows.get('invoices/invoice'), { status: 'closed', totalBBL: 140, tickets: ['old-ticket'] });
  await invoke({ dispatchId: 'job', action: 'decline', reason: 'Unavailable' });
  expect(writes).toHaveLength(1);
  expect(writes[0][0]).toBe('dispatches/job');
  expect(writes[0][1]).toMatchObject({ status: 'declined', declineReason: 'Unavailable' });
});

test('return replay cannot refund a pending load twice', async () => {
  Object.assign(rows.get('dispatches/job'), { status: 'pending', invoiceDocId: undefined, loadsCompleted: 0 });
  expect(await invoke({ dispatchId: 'job', invoiceDocId: 'invoice', action: 'return_pending' })).toMatchObject({ result: 'pending' });
  expect(writes).toHaveLength(0);
});

test('completed jobs and transferred water remain terminal/protected', async () => {
  rows.get('dispatches/job').status = 'completed';
  expect(await invoke({ dispatchId: 'job', action: 'cancel' })).toMatchObject({ result: 'completed' });
  expect(writes).toHaveLength(0);
  rows.get('dispatches/job').status = 'in_progress';
  rows.get('invoices/invoice').transferSourceDocId = 'source';
  await expect(invoke({ dispatchId: 'job', action: 'cancel' })).rejects.toThrow('Loaded');
  expect(writes).toHaveLength(0);
});

test('B cannot be cancelled or declined after A completed; no invoice or sibling writes',async()=>{Object.assign(rows.get('dispatches/job'),{splitGroupId:'g',splitSequence:2,status:'pending',invoiceDocId:undefined});rows.set('dispatches/a',{companyId:'company',driverId:'driver',splitGroupId:'g',splitSequence:1,status:'completed'});for(const action of ['cancel','decline'])await expect(invoke({dispatchId:'job',action})).rejects.toThrow('last split');expect(writes).toHaveLength(0);});
test('started B cannot return to queue even before a new departure or measured barrel',async()=>{Object.assign(rows.get('dispatches/job'),{splitGroupId:'g',splitSequence:2});await expect(invoke({dispatchId:'job',action:'return_pending'})).rejects.toThrow('last split');expect(writes).toHaveLength(0);});
test('unloaded A family cleanup still cancels its unstarted B after A is cancelled',async()=>{Object.assign(rows.get('dispatches/job'),{splitGroupId:'g',splitSequence:2,status:'pending',invoiceDocId:undefined});rows.set('dispatches/a',{companyId:'company',driverId:'driver',splitGroupId:'g',splitSequence:1,status:'cancelled'});await expect(invoke({dispatchId:'job',action:'cancel'})).resolves.toMatchObject({result:'cancelled'});expect(writes).toHaveLength(1);});

test('middle B cancellation atomically releases reserved barrels to C, preserving A and destinations',async()=>{
 Object.assign(rows.get('dispatches/job'),{splitGroupId:'g',splitSequence:2});Object.assign(rows.get('invoices/invoice'),{dispatchCarryBbls:120,totalBBL:40});
 rows.set('dispatches/a',{companyId:'company',driverId:'driver',splitGroupId:'g',splitSequence:1,status:'completed'});
 rows.set('dispatches/c',{companyId:'company',driverId:'driver',splitGroupId:'g',splitSequence:3,status:'pending',wellName:'Unchanged destination'});
 const result=await invoke({dispatchId:'job',invoiceDocId:'invoice',action:'cancel_split'});expect(result.splitCancellationCarry).toMatchObject({nextDispatchId:'c',remainingBbls:120,releasedAllocatedBbls:40});
 expect(writes.find(([path])=>path==='dispatches/c')?.[1]).toMatchObject({inheritedBbls:120});expect(writes.find(([path])=>path==='dispatches/c')?.[1]).not.toHaveProperty('wellName');expect(writes.some(([path])=>path==='dispatches/a')).toBe(false);
 for(const [path,patch] of writes)Object.assign(rows.get(path),patch);writes.length=0;
 const replay=await invoke({dispatchId:'job',action:'cancel'});expect(replay.splitCancellationCarry.remainingBbls).toBe(120);expect(writes).toHaveLength(0);rows.get('dispatches/c').status='completed';const late=await invoke({dispatchId:'job',action:'cancel_split'});expect(late.splitCancellationCarry).toBeUndefined();expect(writes).toHaveLength(0);
});
