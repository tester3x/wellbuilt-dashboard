import { asBblString, asTrimmedString, formatDateDisplay, formatDateTimeDisplay } from './format';
import { resolveHumanAuditLabel } from './identity';
import { splitPhotos } from './photos';
import { acceptedTimeFromInvoice, buildPaperTimeline } from './timeline';
import type { InvoiceSourceRecord, TicketSourceRecord, WaterTicketProjection } from './types';

export function isTicketOnlyWaterTicket(
  ticket: TicketSourceRecord,
  invoice: InvoiceSourceRecord | null,
): boolean {
  const mode = asTrimmedString(invoice?.invoicingMode);
  if (mode === 'ticket_only') return true;
  if (mode === 'invoice_tickets' || mode === 'hybrid') return false;
  const invoiceNumber = asTrimmedString(invoice?.invoiceNumber) || asTrimmedString(ticket.invoiceNumber);
  return invoiceNumber.length === 0;
}

function createdAtMs(ticket: TicketSourceRecord): number | null {
  if (typeof ticket.createdAtMs === 'number' && Number.isFinite(ticket.createdAtMs)) {
    return ticket.createdAtMs;
  }
  const created = ticket.createdAt as { toMillis?: () => number } | string | undefined;
  if (created && typeof created === 'object' && typeof created.toMillis === 'function') {
    return created.toMillis();
  }
  if (typeof created === 'string') {
    const t = Date.parse(created);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function projectWaterTicket(input: {
  ticket: TicketSourceRecord;
  invoice: InvoiceSourceRecord | null;
  legalName?: string;
  displayName?: string;
}): WaterTicketProjection | { ok: false; reason: string; message: string } {
  const { ticket, invoice } = input;
  const ticketDocId = asTrimmedString(ticket.id);
  if (!ticketDocId) {
    return { ok: false, reason: 'ticket_id_required', message: 'Ticket document id is required.' };
  }
  const companyId = asTrimmedString(ticket.companyId) || asTrimmedString(invoice?.companyId);
  if (!companyId) {
    return { ok: false, reason: 'company_required', message: 'Ticket has no companyId.' };
  }
  if (!isTicketOnlyWaterTicket(ticket, invoice)) {
    return { ok: false, reason: 'not_ticket_only', message: 'This slice materializes ticket-only Water Tickets.' };
  }
  const ticketNumber = asTrimmedString(ticket.ticketNumber);
  if (!ticketNumber) {
    return { ok: false, reason: 'ticket_number_required', message: 'Ticket number is required.' };
  }

  const qty = asBblString(ticket.qty) || asBblString(ticket.bbls);
  const pickupBbls = asBblString(ticket.pickupBbls) || qty;
  const dropoffBbls = asBblString(ticket.dropoffBbls) || qty;

  const { photos, jsaUri } = splitPhotos(invoice?.photos);
  const driverDisplayName = resolveHumanAuditLabel({
    legalName: input.legalName,
    displayName: input.displayName,
    driverField: ticket.driver || invoice?.driver,
    submittedBy: ticket.submittedBy,
  });
  const editedRaw = ticket.updatedBy;
  const auditEditedBy = resolveHumanAuditLabel({
    legalName: undefined,
    displayName: undefined,
    driverField: editedRaw,
    submittedBy: ticket.updatedByUid,
  });
  const createdMs = createdAtMs(ticket);

  return {
    artifactType: 'water_ticket',
    ticketDocId,
    ticketNumber,
    companyId,
    dateDisplay: formatDateDisplay(ticket.date),
    acceptedTimeDisplay: invoice ? acceptedTimeFromInvoice(invoice) : '',
    operator: asTrimmedString(ticket.operator) || asTrimmedString(ticket.company) || asTrimmedString(invoice?.operator),
    pickupLocation: asTrimmedString(ticket.location) || asTrimmedString(ticket.wellName) || asTrimmedString(invoice?.wellName),
    dropoffLocation: asTrimmedString(ticket.hauledTo) || asTrimmedString(ticket.disposal) || asTrimmedString(invoice?.hauledTo),
    driverDisplayName,
    truck: asTrimmedString(ticket.truck) || asTrimmedString(invoice?.truckNumber),
    trailer: asTrimmedString(ticket.trailer) || asTrimmedString(invoice?.trailer),
    pickupBbls,
    dropoffBbls,
    tankTop: asTrimmedString(ticket.top),
    tankBottom: asTrimmedString(ticket.bottom),
    timeline: buildPaperTimeline(invoice?.timeline),
    photos,
    jsaUri,
    totalBbl: asBblString(invoice?.totalBBL) || dropoffBbls || qty,
    totalHours: asBblString(invoice?.totalHours) || asBblString(ticket.hours),
    ticketCount: '1',
    auditSubmittedBy: driverDisplayName,
    auditEditedBy: auditEditedBy === 'Unknown driver' ? '' : auditEditedBy,
    auditCreatedAtDisplay: createdMs ? formatDateTimeDisplay(new Date(createdMs).toISOString()) : '',
  };
}
