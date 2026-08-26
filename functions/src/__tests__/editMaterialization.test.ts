/**
 * Pure chronological materialization — the ordering core of v2 edit precedence.
 * These tests use NO datastore: they prove the deterministic properties the
 * real handler relies on (event-time order, per-field precedence, deterministic
 * tie-break, and — crucially — that the result depends only on the SET of
 * corrections, not the order they are inserted/applied, which is what makes the
 * transactional apply converge under concurrency).
 */
import {
  assertedChangesAgainstBaseline,
  buildEditBaseline,
  classifyEditOutcome,
  extractAssertedEditableValues,
  materializeEditableFields,
  sortEditEventsChronologically,
  type EditableSnapshot,
  type MaterializableEvent,
} from '../editHistory';

const BASELINE: EditableSnapshot = {
  tankTopInches: 120, // 10 ft
  bblsTaken: 160,
  dateTimeUTC: '2026-08-23T16:23:00.000Z',
  dateTime: '8/23/2026 11:23 AM',
  wellDown: false,
};

function ev(id: string, t: string, v: EditableSnapshot): MaterializableEvent {
  return { eventId: id, correctionCreatedAtUTC: t, correctionValues: v };
}

// Every permutation of an array (small n) — used to prove order-independence.
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const out: T[][] = [];
  arr.forEach((x, i) => {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([x, ...p]);
  });
  return out;
}

describe('materializeEditableFields — chronological, per-field precedence', () => {
  it('newer creation time wins the same field, regardless of insertion order', () => {
    const a = ev('a', '2026-08-24T10:30:00.000Z', { tankTopInches: 130 });
    const b = ev('b', '2026-08-24T10:45:00.000Z', { tankTopInches: 145 });
    const forward = materializeEditableFields(BASELINE, [a, b]);
    const reverse = materializeEditableFields(BASELINE, [b, a]);
    expect(forward.fields.tankTopInches).toBe(145); // B (newer) authoritative
    expect(reverse.fields.tankTopInches).toBe(145); // arrival order irrelevant
    expect(forward.authority.tankTopInches).toBe('b');
    expect(reverse.authority.tankTopInches).toBe('b');
  });

  it('partial edits to different fields both survive (A level, B bbls)', () => {
    // B created FIRST arrival but A created earlier; A corrects level only,
    // B corrects bbls only. Both must survive per-field.
    const a = ev('a', '2026-08-24T10:30:00.000Z', { tankTopInches: 132 });
    const b = ev('b', '2026-08-24T10:45:00.000Z', { bblsTaken: 150 });
    const r = materializeEditableFields(BASELINE, [b, a]); // B inserted first
    expect(r.fields.tankTopInches).toBe(132); // A owns level (B didn't touch it)
    expect(r.fields.bblsTaken).toBe(150); // B owns bbls
    expect(r.authority.tankTopInches).toBe('a');
    expect(r.authority.bblsTaken).toBe('b');
    // Fields nobody touched stay at baseline.
    expect(r.fields.dateTimeUTC).toBe(BASELINE.dateTimeUTC);
    expect(r.fields.wellDown).toBe(false);
  });

  it('same-field newer wins even when the earlier edit also touched other fields', () => {
    const a = ev('a', '2026-08-24T10:30:00.000Z', { tankTopInches: 132, bblsTaken: 170 });
    const b = ev('b', '2026-08-24T10:45:00.000Z', { bblsTaken: 150 });
    const r = materializeEditableFields(BASELINE, [a, b]);
    expect(r.fields.tankTopInches).toBe(132); // only A touched level → A
    expect(r.fields.bblsTaken).toBe(150); // B newer on bbls
  });

  it('three edits sort by event-time and the newest is authoritative', () => {
    const e1045 = ev('mid', '2026-08-24T10:45:00.000Z', { bblsTaken: 150 });
    const e1030 = ev('early', '2026-08-24T10:30:00.000Z', { bblsTaken: 140 });
    const e1100 = ev('late', '2026-08-24T11:00:00.000Z', { bblsTaken: 155 });
    const r = materializeEditableFields(BASELINE, [e1045, e1030, e1100]);
    expect(r.orderedEventIds).toEqual(['early', 'mid', 'late']); // chronological
    expect(r.fields.bblsTaken).toBe(155); // 11:00 authoritative
    expect(r.authority.bblsTaken).toBe('late');
  });

  it('equal event-times break ties deterministically by eventId', () => {
    const t = '2026-08-24T10:30:00.000Z';
    const z = ev('zzz', t, { bblsTaken: 200 });
    const a = ev('aaa', t, { bblsTaken: 100 });
    const r1 = materializeEditableFields(BASELINE, [z, a]);
    const r2 = materializeEditableFields(BASELINE, [a, z]);
    // 'zzz' sorts last → authoritative in BOTH insertion orders.
    expect(r1.fields.bblsTaken).toBe(200);
    expect(r2.fields.bblsTaken).toBe(200);
    expect(r1.authority.bblsTaken).toBe('zzz');
    expect(sortEditEventsChronologically([a, z]).map((e) => e.eventId)).toEqual(['aaa', 'zzz']);
  });

  it('is order-independent for EVERY insertion permutation (concurrency convergence)', () => {
    const events = [
      ev('a', '2026-08-24T10:30:00.000Z', { tankTopInches: 132 }),
      ev('b', '2026-08-24T10:45:00.000Z', { bblsTaken: 150 }),
      ev('c', '2026-08-24T11:00:00.000Z', { tankTopInches: 140, wellDown: true }),
      ev('d', '2026-08-24T10:50:00.000Z', { dateTimeUTC: '2026-08-23T17:00:00.000Z' }),
    ];
    const canonical = JSON.stringify(materializeEditableFields(BASELINE, events).fields);
    for (const perm of permutations(events)) {
      expect(JSON.stringify(materializeEditableFields(BASELINE, perm).fields)).toBe(canonical);
    }
    // Sanity on the converged value: c newest on level+wellDown, b on bbls, d on time.
    const f = materializeEditableFields(BASELINE, events).fields;
    expect(f.tankTopInches).toBe(140);
    expect(f.wellDown).toBe(true);
    expect(f.bblsTaken).toBe(150);
    expect(f.dateTimeUTC).toBe('2026-08-23T17:00:00.000Z');
  });

  it('re-applying the same event is idempotent (set semantics)', () => {
    const a = ev('a', '2026-08-24T10:30:00.000Z', { tankTopInches: 132 });
    const once = materializeEditableFields(BASELINE, [a]);
    const twice = materializeEditableFields(BASELINE, [a, a]);
    expect(twice.fields).toEqual(once.fields);
  });

  it('empty correction set returns the baseline unchanged', () => {
    const r = materializeEditableFields(BASELINE, []);
    expect(r.fields).toEqual(BASELINE);
    expect(r.authority).toEqual({});
  });
});

describe('classifyEditOutcome', () => {
  const a = ev('a', '2026-08-24T10:30:00.000Z', { tankTopInches: 132, bblsTaken: 170 });
  const b = ev('b', '2026-08-24T10:45:00.000Z', { bblsTaken: 150 });
  const authority = materializeEditableFields(BASELINE, [a, b]).authority;

  it('classifies a partially-superseded correction', () => {
    // A owns level, but its bbls was superseded by B.
    const o = classifyEditOutcome('a', a.correctionValues, authority);
    expect(o.outcome).toBe('recorded_partial');
    expect(o.fieldsAffectingCurrent).toEqual(['tankTopInches']);
    expect(o.fieldsSuperseded).toEqual(['bblsTaken']);
  });

  it('classifies a fully-current correction', () => {
    const o = classifyEditOutcome('b', b.correctionValues, authority);
    expect(o.outcome).toBe('recorded_current');
    expect(o.fieldsAffectingCurrent).toEqual(['bblsTaken']);
    expect(o.fieldsSuperseded).toEqual([]);
  });

  it('classifies a fully-superseded correction', () => {
    const c = ev('c', '2026-08-24T09:00:00.000Z', { bblsTaken: 999 }); // oldest, bbls only
    const auth2 = materializeEditableFields(BASELINE, [a, b, c]).authority;
    const o = classifyEditOutcome('c', c.correctionValues, auth2);
    expect(o.outcome).toBe('recorded_superseded');
    expect(o.fieldsAffectingCurrent).toEqual([]);
    expect(o.fieldsSuperseded).toEqual(['bblsTaken']);
  });
});

describe('extractAssertedEditableValues + buildEditBaseline', () => {
  it('captures only present fields; converts feet→inches; omits empty time', () => {
    const wbm = extractAssertedEditableValues({ tankLevelFeet: 11, bblsTaken: 150, dateTimeUTC: '', dateTime: '' });
    expect(wbm).toEqual({ tankTopInches: 132, bblsTaken: 150 }); // no time asserted
    const dash = extractAssertedEditableValues({ tankTopInches: 140, bblsTaken: 155, dateTimeUTC: '2026-08-23T17:00:00.000Z', dateTime: '8/23/2026, 12:00:00 PM' });
    expect(dash.tankTopInches).toBe(140);
    expect(dash.dateTimeUTC).toBe('2026-08-23T17:00:00.000Z');
    expect(dash.dateTime).toBe('8/23/2026, 12:00 PM'); // seconds stripped
    // wellDown only asserted when the key is present.
    expect('wellDown' in extractAssertedEditableValues({ tankLevelFeet: 10, bblsTaken: 1 })).toBe(false);
    expect(extractAssertedEditableValues({ tankLevelFeet: 10, bblsTaken: 1, wellDown: true }).wellDown).toBe(true);
  });

  it('treats only fields that DIFFER from baseline as asserted (full-snapshot wire)', () => {
    // Wire always carries both level + bbls. "Level-only" correction echoes bbls.
    const levelOnly = assertedChangesAgainstBaseline(
      { tankLevelFeet: 11, bblsTaken: 160 }, // bbls == baseline 160
      BASELINE,
    );
    expect(levelOnly).toEqual({ tankTopInches: 132 }); // bbls not asserted
    // "BBLs-only" correction echoes the baseline level.
    const bblsOnly = assertedChangesAgainstBaseline(
      { tankLevelFeet: 10, bblsTaken: 150 }, // level == baseline 120
      BASELINE,
    );
    expect(bblsOnly).toEqual({ bblsTaken: 150 });
    // Composed through the materializer: both survive regardless of order.
    const a = { eventId: 'a', correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', correctionValues: levelOnly };
    const b = { eventId: 'b', correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', correctionValues: bblsOnly };
    const r = materializeEditableFields(BASELINE, [b, a]);
    expect(r.fields.tankTopInches).toBe(132);
    expect(r.fields.bblsTaken).toBe(150);
    // Echoing the whole unchanged snapshot asserts nothing.
    expect(assertedChangesAgainstBaseline({ tankLevelFeet: 10, bblsTaken: 160 }, BASELINE)).toEqual({});
  });

  it('freezes a full baseline snapshot from a processed row', () => {
    const base = buildEditBaseline({
      tankTopInches: 120, tankLevelFeet: 10, bblsTaken: 160,
      dateTimeUTC: '2026-08-23T16:23:00.000Z', dateTime: '8/23/2026 11:23 AM', wellDown: false,
    });
    expect(base).toEqual(BASELINE);
  });
});
