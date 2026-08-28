// Pure v2 convergence reducer — the contract that must hold BEFORE the live v2
// handler is routed through the coordinator (packet 60427). No emulator needed.
import { materializeV2Correction, type V2MaterializationState, type V2IncomingCorrection } from '../v2Materialization';
import type { EditableSnapshot } from '../editHistory';

const baseline: EditableSnapshot = { tankTopInches: 100, bblsTaken: 40, dateTimeUTC: '2026-08-27T12:00:00.000Z', dateTime: '8/27 7:00 AM', wellDown: false };

const corr = (id: string, t: string, v: EditableSnapshot, src = 'wbm'): V2IncomingCorrection => ({
  editEventId: id, correctionCreatedAtUTC: t, correctionValues: v, serverReceivedAtUTC: t, editSource: src,
});

describe('materializeV2Correction — pure convergence reducer', () => {
  test('preserves EVERY prior correction and adds the new one', () => {
    let state: V2MaterializationState = {};
    const r1 = materializeV2Correction(state, baseline, corr('e1', '2026-08-27T13:00:00Z', { bblsTaken: 50 }));
    state = r1;
    const r2 = materializeV2Correction(state, baseline, corr('e2', '2026-08-27T14:00:00Z', { tankTopInches: 120 }));
    expect(Object.keys(r2.editCorrections).sort()).toEqual(['e1', 'e2']);
    expect(r2.editCorrections.e1.v).toEqual({ bblsTaken: 50 }); // e1 preserved verbatim
    expect(r2.fields.bblsTaken).toBe(50);   // from e1
    expect(r2.fields.tankTopInches).toBe(120); // from e2
    expect(r2.editCount).toBe(2);
  });

  test('is deterministic — identical inputs produce byte-identical output', () => {
    const state: V2MaterializationState = { editCorrections: { e1: { t: '2026-08-27T13:00:00Z', v: { bblsTaken: 50 } } }, materializationRev: 1 };
    const a = materializeV2Correction(state, baseline, corr('e2', '2026-08-27T14:00:00Z', { tankTopInches: 120 }));
    const b = materializeV2Correction(state, baseline, corr('e2', '2026-08-27T14:00:00Z', { tankTopInches: 120 }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('same-operation replay is idempotent — set unchanged, materializationRev does NOT advance', () => {
    const first = materializeV2Correction({}, baseline, corr('e1', '2026-08-27T13:00:00Z', { bblsTaken: 50 }));
    expect(first.changed).toBe(true);
    expect(first.materializationRev).toBe(1);
    // Replay the SAME event with the SAME values against the state that already has it.
    const replay = materializeV2Correction(first, baseline, corr('e1', '2026-08-27T13:00:00Z', { bblsTaken: 50 }));
    expect(replay.changed).toBe(false);
    expect(replay.materializationRev).toBe(1);                 // no bump on exact replay
    expect(replay.editCorrections).toEqual(first.editCorrections);
    expect(replay.fields).toEqual(first.fields);
  });

  test('deterministic materializationRev — advances by exactly 1 per real change', () => {
    let s: V2MaterializationState = {};
    s = materializeV2Correction(s, baseline, corr('e1', '2026-08-27T13:00:00Z', { bblsTaken: 50 }));
    expect(s.materializationRev).toBe(1);
    s = materializeV2Correction(s, baseline, corr('e2', '2026-08-27T14:00:00Z', { tankTopInches: 120 }));
    expect(s.materializationRev).toBe(2);
    s = materializeV2Correction(s, baseline, corr('e3', '2026-08-27T15:00:00Z', { wellDown: true }));
    expect(s.materializationRev).toBe(3);
  });

  test('correction conflict on the same field → chronological resolution, BOTH events kept', () => {
    let s: V2MaterializationState = {};
    // Two events both set bblsTaken; the chronologically-later one wins the field,
    // but both remain in the trail.
    s = materializeV2Correction(s, baseline, corr('early', '2026-08-27T13:00:00Z', { bblsTaken: 50 }));
    s = materializeV2Correction(s, baseline, corr('late', '2026-08-27T15:00:00Z', { bblsTaken: 70 }));
    expect(Object.keys(s.editCorrections!).sort()).toEqual(['early', 'late']);
    const r = materializeV2Correction(s, baseline, corr('noop', '2026-08-27T16:00:00Z', {}));
    expect(r.fields.bblsTaken).toBe(70);        // later event wins the field
    expect(r.authority.bblsTaken).toBe('late'); // authority attributes the winner
  });

  test('concurrent edit intent converges order-independently', () => {
    const a = corr('a', '2026-08-27T13:00:00Z', { bblsTaken: 50 });
    const b = corr('b', '2026-08-27T14:00:00Z', { tankTopInches: 120 });
    const order1 = materializeV2Correction(materializeV2Correction({}, baseline, a), baseline, b);
    const order2 = materializeV2Correction(materializeV2Correction({}, baseline, b), baseline, a);
    expect(order1.fields).toEqual(order2.fields);
    expect(order1.editCorrections).toEqual(order2.editCorrections);
  });

  test('operates ONLY on editable material — never invents identity fields', () => {
    const r = materializeV2Correction({}, baseline, corr('e1', '2026-08-27T13:00:00Z', { bblsTaken: 50 }));
    expect(Object.keys(r.fields).sort()).toEqual(['bblsTaken', 'dateTime', 'dateTimeUTC', 'tankTopInches', 'wellDown']);
    expect((r.fields as Record<string, unknown>).packetId).toBeUndefined(); // identity untouched
  });

  test('does not mutate the input state', () => {
    const state: V2MaterializationState = { editCorrections: { e1: { t: 't', v: { bblsTaken: 10 } } }, materializationRev: 1 };
    const snapshot = JSON.stringify(state);
    materializeV2Correction(state, baseline, corr('e2', '2026-08-27T14:00:00Z', { tankTopInches: 99 }));
    expect(JSON.stringify(state)).toBe(snapshot); // unchanged
  });
});
