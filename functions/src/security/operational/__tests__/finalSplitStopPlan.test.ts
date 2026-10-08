import { planFinalSplitStopRemoval } from '../finalSplitStopPlan';

describe('removing the final split destination', () => {
  it('cancels an unloaded queued A with the final B', () => {
    expect(planFinalSplitStopRemoval({ anchorStatus: 'pending', invoiceStatuses: [], departedPickup: false, hasReplacementDestination: false }))
      .toEqual({ ok: true, action: 'cancel_family' });
  });
  it('cancels an active A before pickup departure, including its invoice', () => {
    expect(planFinalSplitStopRemoval({ anchorStatus: 'in_progress', invoiceStatuses: ['open'], departedPickup: false, hasReplacementDestination: false }))
      .toEqual({ ok: true, action: 'cancel_family' });
  });
  it('requires a destination for water that already departed pickup', () => {
    expect(planFinalSplitStopRemoval({ anchorStatus: 'in_progress', invoiceStatuses: ['open'], departedPickup: true, hasReplacementDestination: false }))
      .toEqual({ ok: false, reason: 'replacement_destination_required' });
    expect(planFinalSplitStopRemoval({ anchorStatus: 'in_progress', invoiceStatuses: ['open'], departedPickup: true, hasReplacementDestination: true }))
      .toEqual({ ok: true, action: 'convert_to_single' });
  });
});
