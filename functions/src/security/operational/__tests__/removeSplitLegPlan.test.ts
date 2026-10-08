import { planSplitLegRemoval } from '../removeSplitLegPlan';

const family = [
  { id: 'a', splitSequence: 1, status: 'pending', wellName: 'AddedTest' },
  { id: 'b', splitSequence: 2, status: 'pending', wellName: 'Gab 1' },
  { id: 'c', splitSequence: 3, status: 'pending', wellName: 'Test Well' },
];

describe('split removal route continuity', () => {
  it('skips B and redirects pending A to former C', () => {
    expect(planSplitLegRemoval(family, 'b')).toEqual({
      ok: true,
      order: [{ id: 'a', splitSequence: 1 }, { id: 'c', splitSequence: 2 }],
      rerouteAnchor: { id: 'a', destination: 'Test Well' },
    });
  });

  it('removing last stop leaves the first destination alone', () => {
    expect(planSplitLegRemoval(family, 'c')).toEqual({
      ok: true,
      order: [{ id: 'a', splitSequence: 1 }, { id: 'b', splitSequence: 2 }],
    });
  });

  it('refuses to redirect an already started anchor', () => {
    expect(planSplitLegRemoval([{ ...family[0], status: 'in_progress' }, ...family.slice(1)], 'b'))
      .toEqual({ ok: false, reason: 'anchor_already_started' });
  });
});
