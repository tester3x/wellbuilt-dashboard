export function planFinalSplitStopRemoval(input: {
  anchorStatus: string;
  invoiceStatuses: string[];
  departedPickup: boolean;
  hasReplacementDestination: boolean;
}): { ok: true; action: 'cancel_family' | 'convert_to_single' } | { ok: false; reason: string } {
  if (input.invoiceStatuses.some(status => ['closed', 'completed'].includes(status))) {
    return { ok: false, reason: 'anchor_invoice_closed' };
  }
  if (!input.departedPickup) {
    if (input.anchorStatus !== 'pending' && input.invoiceStatuses.length !== 1) {
      return { ok: false, reason: 'anchor_invoice_missing' };
    }
    return { ok: true, action: 'cancel_family' };
  }
  if (input.invoiceStatuses.length !== 1) return { ok: false, reason: 'anchor_invoice_missing' };
  if (!input.hasReplacementDestination) return { ok: false, reason: 'replacement_destination_required' };
  return { ok: true, action: 'convert_to_single' };
}
