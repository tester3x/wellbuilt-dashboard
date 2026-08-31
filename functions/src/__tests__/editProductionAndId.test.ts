// Predeploy gate Blockers 1 & 2 — pure-unit proofs for the cross-date
// production recompute and the deterministic legacy edit id.
import { computeEditProductionBuckets, computeDeleteProductionBuckets, type EditProdRow } from '../editProduction';
import { deriveLegacyEditEventId, normalizeFinalEditMaterial, resolveEditEventId } from '../editHistory';
import { getProductionDate } from '../productionFormulas';

const row = (key: string, iso: string, bbls: number, top: number, fr = 0.2): EditProdRow => ({
  key, ms: new Date(iso).getTime(), flowRateDays: fr, tankLevelFeet: top / 12, bblsTaken: bbls, wellDown: false,
});

describe('computeEditProductionBuckets — Blocker 1', () => {
  const BPF = 20, KEY = 'Gabriel_1';
  // 6am-6am windows: 15:00Z ≈ 10am CDT.
  const oldISO = '2026-08-27T15:00:00.000Z', newISO = '2026-08-25T15:00:00.000Z';

  test('cross-date move: old bucket vacated (null), new bucket created with n=1', () => {
    const rows = [row('p1', oldISO, 140, 168)];
    const out = computeEditProductionBuckets({
      rows, editedKey: 'p1', oldMs: new Date(oldISO).getTime(), newMs: new Date(newISO).getTime(),
      newFlowRateDays: 0.2, newTankLevelFeet: 14, newBblsTaken: 140, newWellDown: false,
      bblPerFoot: BPF, wellKey: KEY, nowIso: 'T', curBuckets: {},
    });
    const oldDate = getProductionDate(new Date(oldISO).getTime());
    const newDate = getProductionDate(new Date(newISO).getTime());
    expect(out.find((b) => b.date === oldDate)?.value).toBeNull();
    expect((out.find((b) => b.date === newDate)?.value as any)?.n).toBe(1);
  });

  test('idempotent: recompute depends only on the post-edit set (same result twice)', () => {
    const rows = [row('p1', oldISO, 140, 168), row('p2', '2026-08-25T20:00:00.000Z', 120, 160)];
    const args = {
      rows, editedKey: 'p1', oldMs: new Date(oldISO).getTime(), newMs: new Date(newISO).getTime(),
      newFlowRateDays: 0.2, newTankLevelFeet: 14, newBblsTaken: 140, newWellDown: false,
      bblPerFoot: BPF, wellKey: KEY, nowIso: 'T', curBuckets: {},
    };
    expect(JSON.stringify(computeEditProductionBuckets(args))).toBe(JSON.stringify(computeEditProductionBuckets(args)));
  });

  test('destination already populated: authoritative n counts surviving rows, latest wins a/w/o', () => {
    const dest = '2026-08-25T20:00:00.000Z'; // later same window as newISO
    const rows = [row('p1', oldISO, 140, 168), row('d1', newISO, 100, 150)];
    const out = computeEditProductionBuckets({
      rows, editedKey: 'p1', oldMs: new Date(oldISO).getTime(), newMs: new Date(dest).getTime(),
      newFlowRateDays: 0.2, newTankLevelFeet: 14, newBblsTaken: 140, newWellDown: false,
      bblPerFoot: BPF, wellKey: KEY, nowIso: 'T', curBuckets: {},
    });
    const newDate = getProductionDate(new Date(dest).getTime());
    expect((out.find((b) => b.date === newDate)?.value as any)?.n).toBe(2);
  });

  test('same-date edit recomputes the single bucket (count preserved)', () => {
    const rows = [row('p1', oldISO, 140, 168)];
    const out = computeEditProductionBuckets({
      rows, editedKey: 'p1', oldMs: new Date(oldISO).getTime(), newMs: new Date(oldISO).getTime(),
      newFlowRateDays: 0.2, newTankLevelFeet: 14, newBblsTaken: 150, newWellDown: false,
      bblPerFoot: BPF, wellKey: KEY, nowIso: 'T', curBuckets: {},
    });
    expect(out).toHaveLength(1);
    expect((out[0].value as any)?.n).toBe(1);
  });
});

describe('computeDeleteProductionBuckets — DELETE production recompute', () => {
  const BPF = 20, KEY = 'Gabriel_1';
  const d = '2026-08-27'; // same production window (6am-6am): 15:00Z, 20:00Z land here
  const isoA = '2026-08-27T15:00:00.000Z', isoB = '2026-08-27T20:00:00.000Z';
  const deletedMs = new Date(isoA).getTime();

  test('other pulls remain on the date: bucket RECOMPUTED, n = surviving count (not blind −1)', () => {
    // deleted = isoA; survivors = [isoB] on the same date.
    const survivors = [row('pB', isoB, 120, 160)];
    const out = computeDeleteProductionBuckets({
      survivingRows: survivors, deletedMs, bblPerFoot: BPF, wellKey: KEY, nowIso: 'T', curBuckets: {},
    });
    const date = getProductionDate(deletedMs);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe(date);
    expect((out[0].value as any)?.n).toBe(1); // one survivor on the date
  });

  test('deleted pull was the LAST on its date: bucket REMOVED (null)', () => {
    const out = computeDeleteProductionBuckets({
      survivingRows: [row('pOther', '2026-08-28T15:00:00.000Z', 100, 150)], // different date
      deletedMs, bblPerFoot: BPF, wellKey: KEY, nowIso: 'T', curBuckets: {},
    });
    expect(out).toHaveLength(1);
    expect(out[0].value).toBeNull();
  });

  test('idempotent: depends only on the surviving set → same result twice (no double decrement)', () => {
    const survivors = [row('pB', isoB, 120, 160), row('pC', '2026-08-27T22:00:00.000Z', 90, 140)];
    const args = { survivingRows: survivors, deletedMs, bblPerFoot: BPF, wellKey: KEY, nowIso: 'T', curBuckets: {} };
    expect(JSON.stringify(computeDeleteProductionBuckets(args))).toBe(JSON.stringify(computeDeleteProductionBuckets(args)));
    expect((computeDeleteProductionBuckets(args)[0].value as any)?.n).toBe(2); // two survivors on the date
  });

  test('unparseable deleted time → no bucket touched ([])', () => {
    expect(computeDeleteProductionBuckets({
      survivingRows: [row('pB', isoB, 120, 160)], deletedMs: NaN, bblPerFoot: BPF, wellKey: KEY, nowIso: 'T', curBuckets: {},
    })).toEqual([]);
  });
});

describe('deterministic legacy edit id — Blocker 2', () => {
  test('same original + equivalent final material → same id (distinct wall-clock keys collapse)', () => {
    const m = { tankTopInches: 168, bblsTaken: 150, wellDown: false, dateTimeUTC: '2026-08-27T15:00:00.000Z' };
    const a = resolveEditEventId({ incomingPacketId: 'edit_1000_G', originalPacketId: 'p1', finalMaterial: m });
    const b = resolveEditEventId({ incomingPacketId: 'edit_2000_G', originalPacketId: 'p1', finalMaterial: m });
    expect(a).toBe(b);
    expect(a).toMatch(/^edit_c_p1_[0-9a-f]{32}$/);
  });

  test('different final material → different id (a distinct evidenced edit)', () => {
    const base = { tankTopInches: 168, wellDown: false, dateTimeUTC: '2026-08-27T15:00:00.000Z' };
    expect(deriveLegacyEditEventId('p1', { ...base, bblsTaken: 150 })).not.toBe(deriveLegacyEditEventId('p1', { ...base, bblsTaken: 145 }));
  });

  test('normalization: feet vs inches equivalent, dateTime formats normalized, wellDown coerced', () => {
    expect(normalizeFinalEditMaterial({ tankTopInches: 168, bblsTaken: 150, wellDown: false, dateTimeUTC: '2026-08-27T15:00:00.000Z' }))
      .toBe(normalizeFinalEditMaterial({ tankLevelFeet: 14, bblsTaken: 150, wellDown: 'false' as unknown as boolean, dateTimeUTC: '2026-08-27T15:00:00Z' }));
  });

  test('an explicit clientEventId always wins over the content fallback', () => {
    expect(resolveEditEventId({ incomingPacketId: 'x', clientEventId: 'client-event-12345', originalPacketId: 'p1', finalMaterial: { bblsTaken: 1 } }))
      .toBe('client-event-12345');
  });

  test('no material + no clientEventId → falls back to the incoming key (unchanged legacy behavior)', () => {
    expect(resolveEditEventId({ incomingPacketId: 'edit_1000_G' })).toBe('edit_1000_G');
  });
});
