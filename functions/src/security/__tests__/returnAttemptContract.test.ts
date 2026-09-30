import { createReturnEventHandler } from '../operational/shiftAuthorityCallables';
import { parseReturnAttempt } from '../operational/returnAttemptContract';
import { shiftAuthorityPath, shiftDayPath } from '../operational/shiftAuthority';

const mockDocs = new Map<string, Record<string, any>>();
let mockQueue = Promise.resolve();
jest.mock('firebase-admin', () => ({
  firestore: () => ({
    doc: (path: string) => ({ path }),
    runTransaction: (run: (tx: any) => Promise<unknown>) => {
      // Serial transactions model Firestore's conflict retry: each sees committed events.
      const result = mockQueue.then(() => run({
        get: async (ref: { path: string }) => ({ exists: mockDocs.has(ref.path), data: () => mockDocs.get(ref.path) }),
        set: (ref: { path: string }, data: Record<string, any>) => {
          const old = mockDocs.get(ref.path) || {};
          mockDocs.set(ref.path, { ...old, ...data, events: [...(old.events || []), ...data.events.values] });
        },
      }));
      mockQueue = result.then(() => undefined, () => undefined);
      return result;
    },
  }),
}));
jest.mock('firebase-admin/firestore', () => ({ FieldValue: {
  serverTimestamp: () => 'server-time', arrayUnion: (...values: unknown[]) => ({ values }),
} }));
jest.mock('../canonicalDriverAuthority', () => ({
  loadCanonicalDriverAuthority: async (driverId: string) => ({ driverId, companyId: 'test-company', active: true }),
  productionCanonicalDriverReaders: () => ({}),
}));

const periodId = '2026-09-29_080000';
const driverId = 'test-driver';
const day = shiftDayPath(driverId, '2026-09-29');
const depart = createReturnEventHandler('depart_return');
const abandon = createReturnEventHandler('return_abandoned');
const request = (data: Record<string, unknown>) => ({ data, auth: { uid: 'test', token: { kind: 'driver', driverId } } } as any);
beforeEach(() => {
  mockDocs.clear(); mockQueue = Promise.resolve();
  mockDocs.set(shiftAuthorityPath(driverId), { driverId, companyId: 'test-company', initialized: true, openPeriodId: periodId, originLocalDate: '2026-09-29', version: 1 });
});

test('actual handler accepts Suite v49 wire payload and concurrent retry writes once', async () => {
  const payload = request({ periodId, attemptId: 'ret-first' });
  const results = await Promise.all([depart(payload), depart(payload)]);
  expect(results.map(x => x.recorded).sort()).toEqual([false, true]);
  expect(mockDocs.get(day)?.events).toHaveLength(1);
  expect(mockDocs.get(day)?.events[0]).toMatchObject({ type: 'depart_return', shiftId: periodId, attemptId: 'ret-first' });
  expect(mockDocs.get(shiftAuthorityPath(driverId))?.openPeriodId).toBe(periodId);
});
test('divert and second return in one shift have independent idempotent attempts', async () => {
  await depart(request({ periodId, attemptId: 'ret-first' }));
  expect((await abandon(request({ periodId, attemptId: 'ret-first' }))).recorded).toBe(true);
  expect((await abandon(request({ periodId, attemptId: 'ret-first' }))).recorded).toBe(false);
  await depart(request({ periodId, attemptId: 'ret-second' }));
  expect(mockDocs.get(day)?.events.map((e: any) => e.type)).toEqual(['depart_return', 'return_abandoned', 'depart_return']);
  await expect(depart(request({ periodId, attemptId: 'ret-first' }))).rejects.toThrow('return_attempt_closed');
});
test('legacy period-only return remains compatible and deduplicated', async () => {
  expect((await depart(request({ periodId }))).recorded).toBe(true);
  expect((await depart(request({ periodId }))).recorded).toBe(false);
});
test('wrong period, missing authority, unauthenticated and abandon-before-depart do not write', async () => {
  await expect(depart(request({ periodId: '2026-09-28_080000', attemptId: 'ret-first' }))).rejects.toThrow();
  await expect(abandon(request({ periodId, attemptId: 'ret-first' }))).rejects.toThrow('return_not_started');
  await expect(depart({ data: { periodId, attemptId: 'ret-first' } } as any)).rejects.toThrow('driver_session_required');
  mockDocs.clear();
  await expect(depart(request({ periodId, attemptId: 'ret-first' }))).rejects.toThrow();
  expect(mockDocs.has(day)).toBe(false);
});
test('strict payload rejects identity injection and malformed attempt IDs', async () => {
  for (const attemptId of ['', 'short', 'has spaces', 'x'.repeat(81), null, 42]) {
    await expect(depart(request({ periodId, attemptId }))).rejects.toThrow('malformed_attempt');
  }
  await expect(depart(request({ periodId, attemptId: 'ret-first', driverId: 'other' }))).rejects.toThrow('unknown_fields');
  expect(() => parseReturnAttempt({ periodId }, 'return_abandoned')).toThrow('malformed_attempt');
  expect(mockDocs.has(day)).toBe(false);
});
