import { asTrimmedString, timestampMs } from './format';
import { SYSTEM_PAPER_CALLER } from './paperCaller';
import { materializeWaterTicketPaper } from './engine';
import type { PaperOp } from './types';
import type { PaperStore } from './store';

const MEASUREMENT_KEYS = ['bbls', 'qty', 'top', 'bottom', 'pickupBbls', 'dropoffBbls'] as const;

function fieldStr(rec: Record<string, unknown> | null | undefined, key: string): string {
  if (!rec) return '';
  const v = rec[key];
  if (v == null) return '';
  return String(v);
}

function isClosedStatus(status: unknown): boolean {
  const s = asTrimmedString(status).toLowerCase();
  return s === 'closed' || s === 'complete' || s === 'completed';
}

export function classifyInvoicePaperChange(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): PaperOp | 'none' {
  if (!after) return 'none';
  const closedAfter = timestampMs(after.closedAt) || timestampMs(after.closedAtMs);
  const closedBefore = before ? (timestampMs(before.closedAt) || timestampMs(before.closedAtMs)) : null;
  if (closedAfter && !closedBefore) return 'close';
  if (isClosedStatus(after.status) && !isClosedStatus(before?.status)) return 'close';
  return 'none';
}

export function classifyTicketPaperChange(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): PaperOp | 'none' {
  if (!after || !before) return 'none';
  const updatedAfter = timestampMs(after.updatedAt) || timestampMs(after.editedAt) || timestampMs(after.updatedAtMs);
  const updatedBefore = timestampMs(before.updatedAt) || timestampMs(before.editedAt) || timestampMs(before.updatedAtMs);
  if (!updatedAfter || (updatedBefore != null && updatedAfter <= updatedBefore)) return 'none';
  const changed = MEASUREMENT_KEYS.some((k) => fieldStr(before, k) !== fieldStr(after, k));
  return changed ? 'edit' : 'none';
}

export async function applyInvoicePaperLifecycle(input: {
  store: PaperStore;
  invoiceId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  nowMs: number;
}): Promise<{ op: PaperOp | 'none'; results: unknown[] }> {
  const op = classifyInvoicePaperChange(input.before, input.after);
  if (op === 'none' || !input.after) return { op: 'none', results: [] };
  const tickets = await input.store.findTicketsByInvoiceDocId(input.invoiceId);
  const results = [];
  for (const ticket of tickets) {
    results.push(await materializeWaterTicketPaper({
      store: input.store,
      caller: SYSTEM_PAPER_CALLER,
      ticketDocId: ticket.id,
      op: 'close',
      nowMs: input.nowMs,
    }));
  }
  return { op, results };
}

export async function applyTicketPaperLifecycle(input: {
  store: PaperStore;
  ticketId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  nowMs: number;
}): Promise<{ op: PaperOp | 'none'; result: unknown }> {
  const op = classifyTicketPaperChange(input.before, input.after);
  if (op === 'none' || !input.after) return { op: 'none', result: null };
  const result = await materializeWaterTicketPaper({
    store: input.store,
    caller: SYSTEM_PAPER_CALLER,
    ticketDocId: input.ticketId,
    op: 'edit',
    nowMs: input.nowMs,
  });
  return { op, result };
}
