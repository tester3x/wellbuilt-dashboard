import { asTrimmedString, timestampMs } from './format';
import type { InvoiceSourceRecord, PaperEditSource, PaperOp, TicketSourceRecord } from './types';

export function ticketEditMs(ticket: TicketSourceRecord | Record<string, unknown> | null | undefined): number | null {
  if (!ticket) return null;
  return timestampMs(ticket.updatedAt) || timestampMs(ticket.editedAt) || timestampMs((ticket as { updatedAtMs?: unknown }).updatedAtMs);
}

export function invoiceEditMs(invoice: InvoiceSourceRecord | Record<string, unknown> | null | undefined): number | null {
  if (!invoice) return null;
  return timestampMs(invoice.updatedAt) || timestampMs(invoice.editedAt) || timestampMs((invoice as { updatedAtMs?: unknown }).updatedAtMs);
}

export function inferPaperEditSource(
  ticket: TicketSourceRecord,
  invoice: InvoiceSourceRecord | null,
): PaperEditSource {
  const t = ticketEditMs(ticket);
  const i = invoiceEditMs(invoice);
  if (t && i) return t >= i ? 'ticket' : 'invoice';
  if (i && !t) return 'invoice';
  return 'ticket';
}

export function deriveGovernedSourceEvent(input: {
  ticket: TicketSourceRecord;
  invoice: InvoiceSourceRecord | null;
  op: PaperOp;
  editSource?: PaperEditSource;
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

  const editSource = input.editSource || inferPaperEditSource(input.ticket, input.invoice);
  if (editSource === 'invoice') {
    const updatedAtMs = invoiceEditMs(input.invoice);
    if (!updatedAtMs) {
      return { ok: false, reason: 'event_not_found', message: 'No authoritative edit timestamp on the invoice.' };
    }
    return { ok: true, sourceEventId: `invoice_edit:${ticketDocId}:${updatedAtMs}`, eventMs: updatedAtMs };
  }

  const updatedAtMs = ticketEditMs(input.ticket);
  if (!updatedAtMs) {
    return { ok: false, reason: 'event_not_found', message: 'No authoritative edit timestamp on the ticket.' };
  }
  const createdAtMs = timestampMs(input.ticket.createdAtMs) || timestampMs(input.ticket.createdAt);
  if (createdAtMs && updatedAtMs <= createdAtMs) {
    return { ok: false, reason: 'event_not_found', message: 'Ticket has no governed edit after create.' };
  }
  return { ok: true, sourceEventId: `ticket_edit:${ticketDocId}:${updatedAtMs}`, eventMs: updatedAtMs };
}
