import { computeEditDisplay } from '../wbmEditDisplay';

// The recovered Test Well canary's actual editHistory shape.
const canaryEntry = {
  editEventId: 'editevt_16b5a510-d851-42ef-bef7-29af7da688cb',
  editedAt: '2026-09-02T10:17:19.122Z',
  correctionCreatedAtUTC: '2026-09-01T04:08:03.465Z',
  serverAppliedAtUTC: '2026-09-02T10:17:19.122Z',
  sequence: 1,
  fields: [
    { field: 'tankTopInches', previous: 180, next: 192 },
    { field: 'tankLevelFeet', previous: 15, next: 16 },
  ],
};

describe('computeEditDisplay', () => {
  test('1. recovered canary → exact top-level before→after (drops redundant inches)', () => {
    const m = computeEditDisplay([canaryEntry]);
    expect(m.changes).toEqual([{ field: 'topLevelFeet', before: 15, after: 16 }]);
    expect(m.correctionCount).toBe(1);
    expect(m.corrections[0].editEventId).toBe('editevt_16b5a510-d851-42ef-bef7-29af7da688cb');
    expect(m.unavailableBeforeFields).toEqual([]);
  });

  test('3. partial edit shows ONLY the changed field', () => {
    const m = computeEditDisplay([{ ...canaryEntry, fields: [{ field: 'bblsTaken', previous: 140, next: 165 }] }]);
    expect(m.changes).toEqual([{ field: 'bblsTaken', before: 140, after: 165 }]);
  });

  test('4. multiple, OUT-OF-ORDER corrections → chronological net (first before → last after) + evidence kept', () => {
    const later = { editEventId: 'evt_b', correctionCreatedAtUTC: '2026-09-01T05:00:00.000Z', sequence: 2, fields: [{ field: 'tankLevelFeet', previous: 16, next: 18 }] };
    const earlier = { editEventId: 'evt_a', correctionCreatedAtUTC: '2026-09-01T04:00:00.000Z', sequence: 1, fields: [{ field: 'tankLevelFeet', previous: 15, next: 16 }] };
    const m = computeEditDisplay([later, earlier]); // deliberately out of order
    // NET: earliest before (15) → latest after (18)
    expect(m.changes).toEqual([{ field: 'topLevelFeet', before: 15, after: 18 }]);
    // corrections preserved chronologically, earliest first
    expect(m.corrections.map((c) => c.editEventId)).toEqual(['evt_a', 'evt_b']);
    expect(m.correctionCount).toBe(2);
  });

  test('4b. net no-op (changed then reverted) is not shown, but both corrections are preserved', () => {
    const c1 = { editEventId: 'e1', correctionCreatedAtUTC: '2026-09-01T04:00:00.000Z', fields: [{ field: 'bblsTaken', previous: 140, next: 160 }] };
    const c2 = { editEventId: 'e2', correctionCreatedAtUTC: '2026-09-01T05:00:00.000Z', fields: [{ field: 'bblsTaken', previous: 160, next: 140 }] };
    const m = computeEditDisplay([c1, c2]);
    expect(m.changes).toEqual([]);            // 140 → 140 net no-op
    expect(m.corrections).toHaveLength(2);    // evidence NOT erased
  });

  test('5. legacy inches-only entry reconstructs a feet before→after', () => {
    const legacy = { editEventId: 'legacy1', correctionCreatedAtUTC: '2026-05-01T00:00:00.000Z', fields: [{ field: 'tankTopInches', previous: 96, next: 108 }] };
    const m = computeEditDisplay([legacy]);
    expect(m.changes).toEqual([{ field: 'topLevelFeet', before: 8, after: 9 }]); // 96"/12 → 108"/12
  });

  test('6a. genuinely info-less (empty fields) → no fabricated values', () => {
    const m = computeEditDisplay([{ editEventId: 'x', fields: [] }]);
    expect(m.changes).toEqual([]);
    expect(m.correctionCount).toBe(1);
    expect(m.unavailableBeforeFields).toEqual([]);
  });

  test('6b. changed field with an unrecoverable before → reported, never invented', () => {
    const m = computeEditDisplay([{ editEventId: 'y', fields: [{ field: 'bblsTaken', previous: null, next: 140 }] }]);
    expect(m.changes).toEqual([{ field: 'bblsTaken', before: null, after: 140 }]);
    expect(m.unavailableBeforeFields).toEqual(['bblsTaken']); // before is honestly null, flagged
  });

  test('absent/empty history → empty model (caller presents "no detail" honestly)', () => {
    expect(computeEditDisplay(null).changes).toEqual([]);
    expect(computeEditDisplay([]).correctionCount).toBe(0);
  });
});
