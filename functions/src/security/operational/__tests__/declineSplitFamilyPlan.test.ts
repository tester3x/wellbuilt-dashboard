import { planSplitFamilyDecline } from '../declineSplitFamilyPlan';

describe('split family decline', () => {
  it('declines both pending survivors after an earlier leg was cancelled', () => {
    expect(planSplitFamilyDecline([
      { id: 'a', status: 'pending', splitSequence: 1 },
      { id: 'old-b', status: 'cancelled', splitSequence: 2 },
      { id: 'new-b', status: 'pending', splitSequence: 2 },
    ])).toEqual({ ok: true, declineIds: ['a', 'new-b'] });
  });
  it('refuses any started or completed family', () => {
    expect(planSplitFamilyDecline([
      { id: 'a', status: 'accepted', splitSequence: 1 },
      { id: 'b', status: 'pending', splitSequence: 2 },
    ])).toEqual({ ok: false, reason: 'anchor_not_pending' });
    expect(planSplitFamilyDecline([
      { id: 'a', status: 'completed', splitSequence: 1 },
      { id: 'b', status: 'pending', splitSequence: 2 },
    ])).toEqual({ ok: false, reason: 'family_has_completed_leg' });
  });
});
