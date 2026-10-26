/** One pickup supplies a split family. A records pickup, B/C/... record use. */
export type SplitBudgetInvoice = { id: string; data: Record<string, unknown> };
const closed = (data: Record<string, unknown>) => ['closed', 'complete', 'completed'].includes(String(data.status || '').toLowerCase());
export function evaluateSplitLoadBudget(anchorDispatchId: string, invoices: SplitBudgetInvoice[]) {
  const anchors = invoices.filter(row => closed(row.data) && row.data.dispatchId === anchorDispatchId);
  if (anchors.length !== 1) return { ok: false as const, reason: 'split_pickup_not_confirmed' };
  const pickup = Number(anchors[0].data.totalBBL);
  if (!Number.isFinite(pickup) || pickup <= 0) return { ok: false as const, reason: 'split_pickup_not_confirmed' };
  let used = 0;
  const seen = new Set<string>();
  for (const row of invoices) {
    if (!closed(row.data) || row.data.dispatchId === anchorDispatchId) continue;
    const dispatchId = String(row.data.dispatchId || '');
    const amount = Number(row.data.totalBBL);
    if (!dispatchId || seen.has(dispatchId)) return { ok: false as const, reason: 'split_duplicate_delivery' };
    if (!Number.isFinite(amount) || amount < 0) return { ok: false as const, reason: 'split_invalid_delivery' };
    seen.add(dispatchId);
    used = Math.round((used + amount) * 100) / 100;
  }
  if (used > pickup) return { ok: false as const, reason: 'split_pickup_exceeded' };
  return { ok: true as const, pickup, used, remaining: Math.round((pickup - used) * 100) / 100 };
}
