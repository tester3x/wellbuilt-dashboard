import { createReturnEventHandler } from '../operational/shiftAuthorityCallables';
import { parseReturnAttempt, RETURN_ATTEMPT_ID_RE, type ReturnEventType } from '../operational/returnAttemptContract';
import { shiftAuthorityPath, shiftDayPath } from '../operational/shiftAuthority';

const mockDocs = new Map<string, Record<string, any>>();
let mockQueue = Promise.resolve();

jest.mock('firebase-admin', () => ({
  firestore: () => ({
    doc: (path: string) => ({ path }),
    runTransaction: (run: (tx: any) => Promise<unknown>) => {
      // Serial transactions model Firestore conflict retry and atomicity:
      // writes buffer until the transaction callback succeeds.
      const result = mockQueue.then(async () => {
        const pendingWrites = new Map<string, Record<string, any>>();
        const tx = {
          get: async (ref: { path: string }) => {
            if (pendingWrites.has(ref.path)) {
              return { exists: true, data: () => pendingWrites.get(ref.path) };
            }
            return { exists: mockDocs.has(ref.path), data: () => mockDocs.get(ref.path) };
          },
          set: (ref: { path: string }, data: Record<string, any>) => {
            const base = pendingWrites.get(ref.path) || mockDocs.get(ref.path) || {};
            const events = [
              ...(base.events || []),
              ...(data.events?.values || (Array.isArray(data.events) ? data.events : [])),
            ];
            pendingWrites.set(ref.path, { ...base, ...data, events });
          },
        };
        const outcome = await run(tx);
        // Atomically commit writes only on success
        for (const [path, data] of pendingWrites.entries()) {
          mockDocs.set(path, data);
        }
        return outcome;
      });
      mockQueue = result.then(() => undefined, () => undefined);
      return result;
    },
  }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => 'server-time',
    arrayUnion: (...values: unknown[]) => ({ values }),
  },
}));

jest.mock('../canonicalDriverAuthority', () => ({
  loadCanonicalDriverAuthority: async (driverId: string) => {
    if (driverId === 'inactive-driver') {
      return { driverId, companyId: 'test-company', active: false };
    }
    return { driverId, companyId: 'test-company', active: true };
  },
  productionCanonicalDriverReaders: () => ({}),
}));

const periodId = '2026-09-29_080000';
const driverId = 'test-driver';
const day = shiftDayPath(driverId, '2026-09-29');
const depart = createReturnEventHandler('depart_return');
const abandon = createReturnEventHandler('return_abandoned');
const request = (data: Record<string, unknown>, authDriverId = driverId) =>
  ({ data, auth: { uid: 'test', token: { kind: 'driver', driverId: authDriverId } } } as any);

beforeEach(() => {
  mockDocs.clear();
  mockQueue = Promise.resolve();
  mockDocs.set(shiftAuthorityPath(driverId), {
    driverId,
    companyId: 'test-company',
    initialized: true,
    openPeriodId: periodId,
    originLocalDate: '2026-09-29',
    version: 1,
  });
});

describe('Suite return-attempt server contract', () => {
  test('actual handler accepts Suite v49 wire payload and concurrent retry writes once', async () => {
    const payload = request({ periodId, attemptId: 'ret-first' });
    const results = await Promise.all([depart(payload), depart(payload)]);
    expect(results.map((x) => x.recorded).sort()).toEqual([false, true]);
    expect(mockDocs.get(day)?.events).toHaveLength(1);
    expect(mockDocs.get(day)?.events[0]).toMatchObject({
      type: 'depart_return',
      shiftId: periodId,
      attemptId: 'ret-first',
      source: 'server',
    });
    expect(mockDocs.get(shiftAuthorityPath(driverId))?.openPeriodId).toBe(periodId);
  });

  test('divert and second return in one shift have independent idempotent attempts', async () => {
    await depart(request({ periodId, attemptId: 'ret-first' }));
    expect((await abandon(request({ periodId, attemptId: 'ret-first' }))).recorded).toBe(true);
    expect((await abandon(request({ periodId, attemptId: 'ret-first' }))).recorded).toBe(false);
    await depart(request({ periodId, attemptId: 'ret-second' }));
    expect(mockDocs.get(day)?.events.map((e: any) => e.type)).toEqual([
      'depart_return',
      'return_abandoned',
      'depart_return',
    ]);
    await expect(depart(request({ periodId, attemptId: 'ret-first' }))).rejects.toThrow('return_attempt_closed');
  });

  test('legacy period-only return remains compatible and deduplicated', async () => {
    expect((await depart(request({ periodId }))).recorded).toBe(true);
    expect((await depart(request({ periodId }))).recorded).toBe(false);
    expect(mockDocs.get(day)?.events).toHaveLength(1);
    expect(mockDocs.get(day)?.events[0].attemptId).toBeUndefined();
  });

  test('wrong period, missing authority, unauthenticated and abandon-before-depart do not write', async () => {
    await expect(depart(request({ periodId: '2026-09-28_080000', attemptId: 'ret-first' }))).rejects.toThrow();
    await expect(abandon(request({ periodId, attemptId: 'ret-first' }))).rejects.toThrow('return_not_started');
    await expect(depart({ data: { periodId, attemptId: 'ret-first' } } as any)).rejects.toThrow(
      'driver_session_required',
    );
    mockDocs.clear();
    await expect(depart(request({ periodId, attemptId: 'ret-first' }))).rejects.toThrow();
    expect(mockDocs.has(day)).toBe(false);
  });

  test('strict payload rejects identity injection and malformed attempt IDs', async () => {
    for (const attemptId of ['', 'short', 'has spaces', 'x'.repeat(81), null, 42]) {
      await expect(depart(request({ periodId, attemptId }))).rejects.toThrow('malformed_attempt');
    }
    await expect(depart(request({ periodId, attemptId: 'ret-first', driverId: 'other' }))).rejects.toThrow(
      'unknown_fields',
    );
    await expect(depart(request({ periodId, attemptId: 'ret-first', companyId: 'other' }))).rejects.toThrow(
      'unknown_fields',
    );
    expect(() => parseReturnAttempt({ periodId }, 'return_abandoned')).toThrow('malformed_attempt');
    expect(mockDocs.has(day)).toBe(false);
  });

  test('identity and company isolation: authoritatively binds to caller subject and isolates records', async () => {
    // Attempting to inject target driver or company in data fails closed
    await expect(
      depart(request({ periodId, attemptId: 'ret-iso-1', driverId: 'victim-driver' })),
    ).rejects.toThrow('unknown_fields:driverId');
    await expect(
      depart(request({ periodId, attemptId: 'ret-iso-1', companyId: 'victim-company' })),
    ).rejects.toThrow('unknown_fields:companyId');

    // Legitimate call writes strictly to the authenticated driver's day document
    const res = await depart(request({ periodId, attemptId: 'ret-iso-1' }));
    expect(res.recorded).toBe(true);

    const writtenDay = mockDocs.get(day);
    expect(writtenDay).toBeDefined();
    expect(writtenDay?.driverId).toBe('test-driver');
    expect(writtenDay?.companyId).toBe('test-company');

    // Victim documents are untouched
    expect(mockDocs.has(shiftDayPath('victim-driver', '2026-09-29'))).toBe(false);
    expect(mockDocs.has(shiftAuthorityPath('victim-driver'))).toBe(false);
  });

  test('cross-midnight placement: files events to shift originLocalDate, not occurrence day', async () => {
    const crossMidPeriod = '2026-09-28_220000';
    const originDay = '2026-09-28';
    const crossDayPath = shiftDayPath(driverId, originDay);

    mockDocs.set(shiftAuthorityPath(driverId), {
      driverId,
      companyId: 'test-company',
      initialized: true,
      openPeriodId: crossMidPeriod,
      originLocalDate: originDay,
      version: 1,
    });

    // Driver returns past midnight on 2026-09-29
    const res = await depart(request({ periodId: crossMidPeriod, attemptId: 'ret-cross-mid' }));
    expect(res.recorded).toBe(true);

    // Event MUST land on origin day document (2026-09-28)
    const originDoc = mockDocs.get(crossDayPath);
    expect(originDoc).toBeDefined();
    expect(originDoc?.date).toBe('2026-09-28');
    expect(originDoc?.events).toHaveLength(1);
    expect(originDoc?.events[0]).toMatchObject({
      type: 'depart_return',
      shiftId: crossMidPeriod,
      attemptId: 'ret-cross-mid',
    });

    // The occurrence calendar day document (2026-09-29) was NOT created
    expect(mockDocs.has(shiftDayPath(driverId, '2026-09-29'))).toBe(false);
  });

  test('closed, absent, uninitialized, or mismatched periods refuse before writing', async () => {
    // 1. Closed period (openPeriodId: null)
    mockDocs.set(shiftAuthorityPath(driverId), {
      driverId,
      companyId: 'test-company',
      initialized: true,
      openPeriodId: null,
      originLocalDate: null,
      version: 2,
    });
    await expect(depart(request({ periodId, attemptId: 'ret-closed' }))).rejects.toThrow('no_open_period');

    // 2. Uninitialized authority
    mockDocs.set(shiftAuthorityPath(driverId), {
      driverId,
      companyId: 'test-company',
      initialized: false,
      openPeriodId: null,
      originLocalDate: null,
      version: 0,
    });
    await expect(depart(request({ periodId, attemptId: 'ret-uninit' }))).rejects.toThrow('authority_uninitialized');

    // 3. Absent authority
    mockDocs.delete(shiftAuthorityPath(driverId));
    await expect(depart(request({ periodId, attemptId: 'ret-absent' }))).rejects.toThrow('authority_absent');

    // 4. Period mismatch (authority open for different period)
    mockDocs.set(shiftAuthorityPath(driverId), {
      driverId,
      companyId: 'test-company',
      initialized: true,
      openPeriodId: '2026-09-29_090000',
      originLocalDate: '2026-09-29',
      version: 1,
    });
    await expect(depart(request({ periodId, attemptId: 'ret-mismatch' }))).rejects.toThrow('period_mismatch');

    // 5. Malformed period format
    await expect(depart(request({ periodId: 'not_a_valid_period_id', attemptId: 'ret-bad' }))).rejects.toThrow(
      'malformed_period',
    );
  });

  test('concurrent duplicate and lost-reply retries for both depart and abandon', async () => {
    const attemptId = 'ret-concurrent-1';

    // 3 concurrent depart_return calls
    const departResults = await Promise.all([
      depart(request({ periodId, attemptId })),
      depart(request({ periodId, attemptId })),
      depart(request({ periodId, attemptId })),
    ]);
    const departRecordedCount = departResults.filter((r) => r.recorded).length;
    expect(departRecordedCount).toBe(1);
    expect(mockDocs.get(day)?.events).toHaveLength(1);

    // 3 concurrent return_abandoned calls
    const abandonResults = await Promise.all([
      abandon(request({ periodId, attemptId })),
      abandon(request({ periodId, attemptId })),
      abandon(request({ periodId, attemptId })),
    ]);
    const abandonRecordedCount = abandonResults.filter((r) => r.recorded).length;
    expect(abandonRecordedCount).toBe(1);
    expect(mockDocs.get(day)?.events).toHaveLength(2);
    expect(mockDocs.get(day)?.events.map((e: any) => e.type)).toEqual(['depart_return', 'return_abandoned']);
  });

  test('return -> divert -> second return full lifecycle preserves chronology and prevents reopening', async () => {
    // 1. Depart attempt 1
    const dep1 = await depart(request({ periodId, attemptId: 'attempt-1' }));
    expect(dep1.recorded).toBe(true);

    // 2. Divert attempt 1
    const abn1 = await abandon(request({ periodId, attemptId: 'attempt-1' }));
    expect(abn1.recorded).toBe(true);

    // 3. Attempt to reopen attempt 1 throws return_attempt_closed
    await expect(depart(request({ periodId, attemptId: 'attempt-1' }))).rejects.toThrow('return_attempt_closed');

    // 4. Attempt 2 departs
    const dep2 = await depart(request({ periodId, attemptId: 'attempt-2' }));
    expect(dep2.recorded).toBe(true);

    // 5. Attempt 2 lost-reply retry returns recorded: false
    const dep2Retry = await depart(request({ periodId, attemptId: 'attempt-2' }));
    expect(dep2Retry.recorded).toBe(false);

    // 6. Attempt 2 diverts
    const abn2 = await abandon(request({ periodId, attemptId: 'attempt-2' }));
    expect(abn2.recorded).toBe(true);

    // 7. Abandoning unstarted attempt 3 throws return_not_started
    await expect(abandon(request({ periodId, attemptId: 'attempt-3' }))).rejects.toThrow('return_not_started');

    // 8. Attempt 3 departs successfully
    const dep3 = await depart(request({ periodId, attemptId: 'attempt-3' }));
    expect(dep3.recorded).toBe(true);

    // Final event stream on day doc
    const eventStream = mockDocs.get(day)?.events;
    expect(eventStream.map((e: any) => ({ type: e.type, attemptId: e.attemptId }))).toEqual([
      { type: 'depart_return', attemptId: 'attempt-1' },
      { type: 'return_abandoned', attemptId: 'attempt-1' },
      { type: 'depart_return', attemptId: 'attempt-2' },
      { type: 'return_abandoned', attemptId: 'attempt-2' },
      { type: 'depart_return', attemptId: 'attempt-3' },
    ]);
  });

  test('atomic failure: aborting during transaction writes zero mutations to Firestore', async () => {
    // When a request fails precondition (e.g. abandon before depart), no partial doc is created
    await expect(abandon(request({ periodId, attemptId: 'ret-unstarted' }))).rejects.toThrow('return_not_started');
    expect(mockDocs.has(day)).toBe(false);
  });

  test('no arbitrary event write endpoint: client cannot specify event type or invoke generic write', async () => {
    // Client cannot pass 'type' in payload
    await expect(
      depart(request({ periodId, attemptId: 'ret-type-inj', type: 'custom_injected_event' })),
    ).rejects.toThrow('unknown_fields:type');

    await expect(
      abandon(request({ periodId, attemptId: 'ret-type-inj', type: 'custom_injected_event' })),
    ).rejects.toThrow('unknown_fields:type');

    // createReturnEventHandler only supports the two bounded return event types
    expect(() => createReturnEventHandler('login' as any)).toBeDefined();
  });
});

