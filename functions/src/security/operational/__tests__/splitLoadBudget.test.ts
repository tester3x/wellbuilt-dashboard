import { evaluateSplitLoadBudget } from '../splitLoadBudget';
const row = (id: string, dispatchId: string, totalBBL: number, status = 'closed') => ({ id, data: { dispatchId, totalBBL, status } });
describe('one physical pickup supplies all continuation deliveries', () => {
  it('counts A once as supply and B/C as use', () => {
    expect(evaluateSplitLoadBudget('A', [row('a', 'A', 70), row('b', 'B', 35), row('c', 'C', 35)]))
      .toEqual({ ok: true, pickup: 70, used: 70, remaining: 0 });
  });
  it('rejects exceeding the pickup, including the final stop', () => {
    expect(evaluateSplitLoadBudget('A', [row('a', 'A', 70), row('b', 'B', 35), row('c', 'C', 36)]))
      .toMatchObject({ ok: false, reason: 'split_pickup_exceeded' });
  });
  it('requires the actual confirmed pickup and ignores cancelled/draft work', () => {
    expect(evaluateSplitLoadBudget('A', [row('a', 'A', 70, 'open')]).ok).toBe(false);
    expect(evaluateSplitLoadBudget('A', [row('a', 'A', 70), row('b', 'B', 35), row('c', 'C', 70, 'cancelled'), row('d', 'D', 70, 'open')]))
      .toMatchObject({ ok: true, used: 35, remaining: 35 });
  });
  it('rejects duplicate pickup/delivery invoices and invalid quantities', () => {
    expect(evaluateSplitLoadBudget('A', [row('a', 'A', 70), row('a2', 'A', 70)]).ok).toBe(false);
    expect(evaluateSplitLoadBudget('A', [row('a', 'A', 70), row('b', 'B', 20), row('b2', 'B', 20)]).ok).toBe(false);
    expect(evaluateSplitLoadBudget('A', [row('a', 'A', 70), row('b', 'B', -1)]).ok).toBe(false);
  });
  it('handles zero use, decimal barrels and replacement on retry', () => {
    expect(evaluateSplitLoadBudget('A', [row('a', 'A', 0.3), row('b', 'B', 0.1), row('c', 'C', 0.2)]))
      .toMatchObject({ ok: true, remaining: 0 });
    expect(evaluateSplitLoadBudget('A', [row('a', 'A', 70), row('b', 'B', 0)]))
      .toMatchObject({ ok: true, remaining: 70 });
  });
});
