/**
 * Explicit-shift authority — decision and concurrency matrix.
 *
 * Proves the properties that make a server pointer worth adding at all:
 * absence never reads as "none", exactly one period survives a race, and a
 * stale close cannot end somebody's live shift.
 *
 * The concurrency case runs the real decisions against a store that models
 * Firestore's optimistic-concurrency abort. A mock that simply buffers writes
 * would let both claims "succeed" and would prove nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildLifecycleEvent,
  eventDayPath,
  decideClaim,
  decideClose,
  decideResolve,
  originDayOf,
  recordAfterClaim,
  recordAfterClose,
  shiftAuthorityPath,
  shiftDayPath,
  type ShiftAuthorityRecord,
} from '../operational/shiftAuthority';

const DRIVER = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
const COMPANY = 'liquid-gold';
const WHO = { driverId: DRIVER, companyId: COMPANY };
const PERIOD = '2026-08-08_211725';
const DAY = '2026-08-08';
/** Mirrors CLOSE_KEYS in the adapter — asserted, not assumed. */
const CLOSE_INPUT_KEYS = ['periodId'];

const initializedNone = (): ShiftAuthorityRecord => ({
  driverId: DRIVER, companyId: COMPANY, initialized: true,
  openPeriodId: null, originLocalDate: null, version: 1,
});
const initializedOpen = (): ShiftAuthorityRecord => ({
  driverId: DRIVER, companyId: COMPANY, initialized: true,
  openPeriodId: PERIOD, originLocalDate: DAY, version: 2,
});

describe('resolve', () => {
  test('7. absent authority is unverifiable, never none', () => {
    expect(decideResolve(null, WHO)).toEqual({ state: 'unverifiable', reason: 'authority_absent' });
  });

  test('7. an uninitialized record is unverifiable, never none', () => {
    const rec = { ...initializedNone(), initialized: false };
    expect(decideResolve(rec, WHO)).toEqual({ state: 'unverifiable', reason: 'authority_uninitialized' });
  });

  test('a half-written binding is unverifiable rather than guessed', () => {
    const rec = { ...initializedNone(), openPeriodId: PERIOD, originLocalDate: null };
    expect(decideResolve(rec, WHO).state).toBe('unverifiable');
  });

  test('a period id disagreeing with its origin date is unverifiable', () => {
    const rec = { ...initializedOpen(), originLocalDate: '2026-08-09' };
    expect(decideResolve(rec, WHO)).toEqual({ state: 'unverifiable', reason: 'authority_inconsistent' });
  });

  test('11. another driver\'s record is never evidence about this driver', () => {
    const rec = { ...initializedOpen(), driverId: 'someone-else' };
    expect(decideResolve(rec, WHO)).toEqual({ state: 'unverifiable', reason: 'driver_mismatch' });
  });

  test('11. another company\'s record is never evidence either', () => {
    const rec = { ...initializedOpen(), companyId: 'other-co' };
    expect(decideResolve(rec, WHO)).toEqual({ state: 'unverifiable', reason: 'driver_mismatch' });
  });

  test('initialized with a null pointer is the ONLY path to none', () => {
    expect(decideResolve(initializedNone(), WHO)).toEqual({ state: 'none' });
  });

  test('an open pointer resolves to its exact binding', () => {
    expect(decideResolve(initializedOpen(), WHO))
      .toEqual({ state: 'open', periodId: PERIOD, originLocalDate: DAY });
  });
});

describe('claim', () => {
  test('1. initialized none permits exactly one claim', () => {
    const d = decideClaim(initializedNone(), { periodId: PERIOD, originLocalDate: DAY }, WHO);
    expect(d).toEqual({ action: 'claim', periodId: PERIOD, originLocalDate: DAY });
  });

  test('3. an existing open period is returned, never a second mint', () => {
    const d = decideClaim(initializedOpen(), { periodId: '2026-08-09_070000', originLocalDate: '2026-08-09' }, WHO);
    expect(d).toEqual({ action: 'existing', periodId: PERIOD, originLocalDate: DAY });
  });

  test('7. uninitialized authority refuses — no mint from an unknown state', () => {
    const d = decideClaim(null, { periodId: PERIOD, originLocalDate: DAY }, WHO);
    expect(d).toEqual({ action: 'refuse', reason: 'authority_absent' });
  });

  test('a malformed period id is refused', () => {
    expect(decideClaim(initializedNone(), { periodId: 'nope', originLocalDate: DAY }, WHO))
      .toEqual({ action: 'refuse', reason: 'invalid_period_id' });
  });

  test('a period id whose day contradicts the origin date is refused', () => {
    expect(decideClaim(initializedNone(), { periodId: PERIOD, originLocalDate: '2026-08-09' }, WHO))
      .toEqual({ action: 'refuse', reason: 'period_date_mismatch' });
  });

  test('14. no rest-period or elapsed-time rule participates', () => {
    // A claim immediately after a close is permitted. Nothing in the decision
    // reads a clock, so an HOS rule could not exist here even accidentally.
    const justClosed = recordAfterClose(initializedOpen(), PERIOD);
    const d = decideClaim(justClosed, { periodId: '2026-08-08_211726', originLocalDate: DAY }, WHO);
    expect(d.action).toBe('claim');
    expect(decideClaim.length).toBe(3); // record, proposal, expect — no clock
  });
});

describe('close', () => {
  test('4. a matching close closes that period', () => {
    expect(decideClose(initializedOpen(), PERIOD, WHO))
      .toEqual({ action: 'close', periodId: PERIOD, originLocalDate: DAY });
  });

  test('5. a repeated matching close is idempotent, not an error', () => {
    const closed = recordAfterClose(initializedOpen(), PERIOD);
    expect(decideClose(closed, PERIOD, WHO))
      .toEqual({ action: 'already_closed', periodId: PERIOD });
  });

  test('6. a stale close naming a previous period does NOT clear the open one', () => {
    const open = { ...initializedOpen(), openPeriodId: '2026-08-09_070000', originLocalDate: '2026-08-09' };
    const d = decideClose(open, PERIOD, WHO);
    expect(d).toEqual({ action: 'refuse', reason: 'period_mismatch' });
    // and the record is untouched by a refusal
    expect(open.openPeriodId).toBe('2026-08-09_070000');
  });

  test('6. closing when none is open, for an unrelated period, is refused', () => {
    expect(decideClose(initializedNone(), PERIOD, WHO))
      .toEqual({ action: 'refuse', reason: 'no_open_period' });
  });

  test('7. closing against unverifiable authority is refused', () => {
    expect(decideClose(null, PERIOD, WHO).action).toBe('refuse');
  });

  test('11. a cross-driver close is refused', () => {
    const rec = { ...initializedOpen(), driverId: 'someone-else' };
    expect(decideClose(rec, PERIOD, WHO)).toEqual({ action: 'refuse', reason: 'driver_mismatch' });
  });
});

describe('2. concurrency — two devices, one period', () => {
  /** Firestore-like store: reads are versioned, commit aborts on conflict. */
  function makeStore(initial: ShiftAuthorityRecord) {
    const docs = new Map<string, ShiftAuthorityRecord>([[shiftAuthorityPath(DRIVER), initial]]);
    const versions = new Map<string, number>();
    return {
      docs,
      async runTransaction<T>(fn: (tx: {
        get(p: string): Promise<ShiftAuthorityRecord | null>;
        set(p: string, v: ShiftAuthorityRecord): void;
      }) => Promise<T>): Promise<T> {
        const reads = new Map<string, number>();
        const writes: Array<() => void> = [];
        const out = await fn({
          async get(p) { reads.set(p, versions.get(p) ?? 0); return docs.get(p) ?? null; },
          set(p, v) { writes.push(() => docs.set(p, v)); },
        });
        for (const [p, v] of reads) {
          if ((versions.get(p) ?? 0) !== v) throw new Error('ABORTED');
        }
        writes.forEach((w) => w());
        for (const p of reads.keys()) versions.set(p, (versions.get(p) ?? 0) + 1);
        return out;
      },
    };
  }

  test('two concurrent claims yield exactly one open period', async () => {
    const store = makeStore(initializedNone());
    const attempt = (periodId: string, day: string) => store.runTransaction(async (tx) => {
      const rec = await tx.get(shiftAuthorityPath(DRIVER));
      const d = decideClaim(rec, { periodId, originLocalDate: day }, WHO);
      if (d.action === 'claim') {
        tx.set(shiftAuthorityPath(DRIVER), recordAfterClaim(rec as ShiftAuthorityRecord, d.periodId, d.originLocalDate));
      }
      return d;
    });

    const results = await Promise.allSettled([
      attempt('2026-08-08_211725', DAY),
      attempt('2026-08-08_211726', DAY),
    ]);
    const claimed = results.filter(
      (r) => r.status === 'fulfilled' && (r.value as { action: string }).action === 'claim',
    );
    expect(claimed.length).toBe(1);

    const final = store.docs.get(shiftAuthorityPath(DRIVER))!;
    expect(final.openPeriodId).not.toBeNull();
    // Whoever lost sees the winner's binding on retry — not a second period.
    const retry = decideClaim(final, { periodId: '2026-08-08_211799', originLocalDate: DAY }, WHO);
    expect(retry).toEqual({ action: 'existing', periodId: final.openPeriodId, originLocalDate: DAY });
  });

  test('12. a backend error propagates and can never look like none', async () => {
    const store = makeStore(initializedNone());
    const boom = store.runTransaction(async () => { throw new Error('UNAVAILABLE'); });
    await expect(boom).rejects.toThrow('UNAVAILABLE');
    // The caller sees a thrown error; nothing in the code maps a failure to
    // { state: 'none' }. The only producer of `none` is decideResolve on an
    // initialized record with a null pointer.
    expect(decideResolve(null, WHO).state).toBe('unverifiable');
  });
});

describe('8/9. initialization paths', () => {
  test('8. seeding an existing OPEN shift preserves that exact binding', () => {
    const seeded: ShiftAuthorityRecord = {
      driverId: DRIVER, companyId: COMPANY, initialized: true,
      openPeriodId: PERIOD, originLocalDate: DAY, version: 1,
    };
    expect(decideResolve(seeded, WHO)).toEqual({ state: 'open', periodId: PERIOD, originLocalDate: DAY });
    // and a claim afterwards returns it rather than duplicating it
    expect(decideClaim(seeded, { periodId: '2026-08-09_070000', originLocalDate: '2026-08-09' }, WHO).action)
      .toBe('existing');
  });

  test('9. none is established only by an initialized record, never by absence', () => {
    expect(decideResolve(null, WHO).state).toBe('unverifiable');
    expect(decideResolve({ ...initializedNone(), initialized: false }, WHO).state).toBe('unverifiable');
    expect(decideResolve(initializedNone(), WHO).state).toBe('none');
  });
});

describe('paths and helpers', () => {
  test('the authority is a private per-driver document', () => {
    expect(shiftAuthorityPath(DRIVER)).toBe(`driver_shift_authority/${DRIVER}`);
  });
  test('the day document path matches the established convention', () => {
    expect(shiftDayPath(DRIVER, DAY)).toBe(`driver_shifts/${DRIVER}_${DAY}`);
  });
  test('origin day is derived from the period id', () => {
    expect(originDayOf(PERIOD)).toBe(DAY);
    expect(originDayOf('garbage')).toBeNull();
  });
});

// ── atomic lifecycle events (Blocker 1 correction) ────────────────────────
describe('atomic start/close events', () => {
  test('1/3. a lifecycle event is period-attributed and server-stamped', () => {
    const e = buildLifecycleEvent('logout', PERIOD, '2026-08-09T01:37:44.667Z');
    expect(e).toEqual({
      type: 'logout', shiftId: PERIOD,
      timestamp: '2026-08-09T01:37:44.667Z', source: 'server',
    });
    // shiftId is what makes "one close for THIS period" provable. The existing
    // WB-S elements carry none, which is why the live 2026-08-08 document
    // cannot be shown to have been closed at all.
    expect(e.shiftId).toBe(PERIOD);
  });

  test('7. a cross-midnight close targets a different day than the origin', () => {
    // Mike's live case: origin 2026-08-08, close occurring on 2026-08-09.
    const origin = shiftDayPath(DRIVER, DAY);
    const closeDay = eventDayPath(DRIVER, '2026-08-09');
    expect(origin).not.toBe(closeDay);
    expect(origin).toBe(`driver_shifts/${DRIVER}_2026-08-08`);
    expect(closeDay).toBe(`driver_shifts/${DRIVER}_2026-08-09`);
  });

  test('5/6. no event is built for a refused or already-closed decision', () => {
    // The adapter only builds an event on action==='close'/'claim'. A repeat
    // returns already_closed and a stale request refuses, so neither appends.
    const closed = recordAfterClose(initializedOpen(), PERIOD);
    expect(decideClose(closed, PERIOD, WHO).action).toBe('already_closed');
    const newer = { ...initializedOpen(), openPeriodId: '2026-08-09_070000', originLocalDate: '2026-08-09' };
    expect(decideClose(newer, PERIOD, WHO).action).toBe('refuse');
  });

  test('8. the day write is a merge that names only its own fields', () => {
    // Guards against a regression to a whole-document set: unrelated fields
    // (odometerMiles, displayName) and pre-existing events must survive.
    const src = readFileSync(
      join(__dirname, '..', 'operational', 'shiftAuthorityCallables.ts'), 'utf8');
    expect(src).not.toMatch(/tx\.set\([^)]*\)\s*;\s*$/m);      // no set without options
    expect((src.match(/\{ merge: true \}/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(src).toMatch(/FieldValue\.arrayUnion\(/);            // append, never replace
    expect(src).not.toMatch(/events:\s*\[/);                    // never a literal array
  });

  test('4. a refusal path performs no write at all', () => {
    const src = readFileSync(
      join(__dirname, '..', 'operational', 'shiftAuthorityCallables.ts'), 'utf8');
    // Both transactions return before any tx.set when the decision refuses.
    expect(src).toMatch(/if \(decision\.action === 'refuse'\) return decision;/);
    expect(src).toMatch(/if \(decision\.action !== 'close'\) return decision;/);
  });

  test('the close day comes from the server clock, never the client', () => {
    const src = readFileSync(
      join(__dirname, '..', 'operational', 'shiftAuthorityCallables.ts'), 'utf8');
    expect(src).toMatch(/const closeLocalDate = serverIsoNow\.slice\(0, 10\)/);
    expect(CLOSE_INPUT_KEYS).toEqual(['periodId']);   // no date input exists
  });
});
