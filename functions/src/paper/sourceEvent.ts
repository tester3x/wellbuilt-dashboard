import { asTrimmedString, timestampMs } from './format';
import type { InvoiceSourceRecord, PaperOp, TicketSourceRecord } from './types';

export function deriveGovernedSourceEvent(input: {
  ticket: TicketSourceRecord;
  invoice: InvoiceSourceRecord | null;
  op: PaperOp;
}): { ok: true; sourceEventId: string; eventMs: number } | { ok: false; reason: string; message: string } {
  const ticketDocId = asTrimmedString(input.ticket.id);
  if (!ticketDocId) {
    return { ok: false, reason: 'ticket_id_required', message: 'Ticket document id is required.' };
  }
  if (input.op === 'close') {
    const closedAtMs = timestampMs(input.invoice?.closedAtMs) || timestampMs(input.invoice?.closedAt);
    if (!closedAtMs) {
      return { ok: false, reason: 'event_not_found', message: 'No authoritative close timestamp on the invoice.' };
    }
    return { ok: true, sourceEventId: `close:${ticketDocId}:${closedAtMs}`, eventMs: closedAtMs };
  }
  const updatedAtMs = timestampMs(input.ticket.updatedAt)
    || timestampMs(input.ticket.editedAt)
    || timestampMs(input.ticket.updatedAtMs);
  if (!updatedAtMs) {
    return { ok: false, reason: 'event_not_found', message: 'No authoritative edit timestamp on the ticket.' };
  }
  const createdAtMs = timestampMs(input.ticket.createdAtMs) || timestampMs(input.ticket.createdAt);
  if (createdAtMs && updatedAtMs <= createdAtMs) {
    return { ok: false, reason: 'event_not_found', message: 'Ticket has no governed edit after create.' };
  }
  return { ok: true, sourceEventId: `edit:${ticketDocId}:${updatedAtMs}`, eventMs: updatedAtMs };
}
