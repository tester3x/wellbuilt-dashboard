import { asBblString, asTrimmedString, DEFAULT_PAPER_TIMEZONE, formatDateDisplay, formatDateTimeDisplay, timestampMs } from './format';
import { canonicalDriverIdFromRecords, resolveHumanAuditLabel } from './identity';
import { buildPaperTimeline, acceptedTimeFromInvoice } from './timeline';
import type { InvoiceSourceRecord, PaperPhoto, TicketSourceRecord, WaterTicketProjection } from './types';

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

export function projectWaterTicket(input: {
  ticket: TicketSourceRecord;
  invoice: InvoiceSourceRecord | null;
  legalName?: string;
  displayName?: string;
  photos: PaperPhoto[];
  jsaContentHash?: string;
  paperTimeZone?: string;
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
  const timeZone = input.paperTimeZone || asTrimmedString(invoice?.timezone) || DEFAULT_PAPER_TIMEZONE;
  const ownerDriverId = canonicalDriverIdFromRecords({
    ownerDriverId: ticket.ownerDriverId,
    driverId: ticket.driverId,
    submittedBy: ticket.submittedBy,
    invoiceOwnerDriverId: invoice?.ownerDriverId,
    invoiceDriverId: invoice?.driverId,
  });

  const driverDisplayName = resolveHumanAuditLabel({
    legalName: input.legalName,
    displayName: input.displayName,
    historicalLabel: ticket.driver || invoice?.driver,
  });
  const auditEditedBy = resolveHumanAuditLabel({
    historicalLabel: ticket.updatedBy,
  });
  const createdMs = timestampMs(ticket.createdAtMs) || timestampMs(ticket.createdAt);

  return {
    artifactType: 'water_ticket',
    ticketDocId,
    invoiceDocId: asTrimmedString(ticket.invoiceDocId) || asTrimmedString(invoice?.id),
    ticketNumber,
    companyId,
    ownerDriverId,
    paperTimeZone: timeZone,
    dateDisplay: formatDateDisplay(ticket.date),
    acceptedTimeDisplay: invoice ? acceptedTimeFromInvoice(invoice, timeZone) : '',
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
    timeline: buildPaperTimeline(invoice?.timeline, timeZone),
    photos: input.photos,
    jsaContentHash: input.jsaContentHash || '',
    totalBbl: asBblString(invoice?.totalBBL) || dropoffBbls || qty,
    totalHours: asBblString(invoice?.totalHours) || asBblString(ticket.hours),
    ticketCount: '1',
    auditSubmittedBy: driverDisplayName,
    auditEditedBy: auditEditedBy === 'Unknown driver' ? '' : auditEditedBy,
    auditCreatedAtDisplay: createdMs ? formatDateTimeDisplay(new Date(createdMs).toISOString(), timeZone) : '',
  };
}
