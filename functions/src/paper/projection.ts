import { asBblString, asTrimmedString, DEFAULT_PAPER_TIMEZONE, formatDateDisplay, formatDateTimeDisplay, timestampMs } from './format';
import { canonicalDriverIdFromRecords, resolveHumanAuditLabel } from './identity';
import { splitLivePhotos } from './photos';
import { buildPaperTimeline, acceptedTimeFromInvoice } from './timeline';
import type { InvoiceSourceRecord, PaperPhotoMeta, TicketSourceRecord, WaterTicketProjection } from './types';

type SourceRec = Record<string, unknown> | null | undefined;

function rec(v: SourceRec): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function rawTimeline(raw: unknown): Array<{ type: string; timestamp: string; locationName: string; reason: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && typeof e === 'object' && !Array.isArray(e))
    .map((e) => {
      const row = e as Record<string, unknown>;
      return {
        type: asTrimmedString(row.type),
        timestamp: asTrimmedString(row.timestamp),
        locationName: asTrimmedString(row.locationName),
        reason: asTrimmedString(row.reason),
      };
    })
    .filter((e) => e.timestamp)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.type.localeCompare(b.type));
}

/**
 * Single paper-source contract. Projection, fingerprint, and change
 * classification all read these fields so lists cannot drift.
 */
export function collectPaperSource(
  ticket: TicketSourceRecord | SourceRec,
  invoice: InvoiceSourceRecord | SourceRec,
): {
  ticketNumber: string;
  companyId: string;
  invoiceDocId: string;
  invoiceNumber: string;
  invoicingMode: string;
  dateRaw: string;
  operator: string;
  pickupLocation: string;
  dropoffLocation: string;
  driverLabel: string;
  ownerDriverId: string;
  submittedBy: string;
  updatedBy: string;
  truck: string;
  trailer: string;
  pickupBbls: string;
  dropoffBbls: string;
  tankTop: string;
  tankBottom: string;
  totalBbl: string;
  totalHours: string;
  invoiceStartedAt: string;
  startTime: string;
  timezone: string;
  createdAtMs: number | null;
  timeline: Array<{ type: string; timestamp: string; locationName: string; reason: string }>;
  photos: Array<{ uri: string; type: string; location: string; takenAt: string }>;
  jsaUri: string;
} {
  const t = rec(ticket as SourceRec);
  const inv = rec(invoice as SourceRec);
  const qty = asBblString(t.qty) || asBblString(t.bbls);
  const pickupBbls = asBblString(t.pickupBbls) || qty;
  const dropoffBbls = asBblString(t.dropoffBbls) || qty;
  const live = splitLivePhotos(inv.photos);
  return {
    ticketNumber: asTrimmedString(t.ticketNumber),
    companyId: asTrimmedString(t.companyId) || asTrimmedString(inv.companyId),
    invoiceDocId: asTrimmedString(t.invoiceDocId) || asTrimmedString(inv.id),
    invoiceNumber: asTrimmedString(inv.invoiceNumber) || asTrimmedString(t.invoiceNumber),
    invoicingMode: asTrimmedString(inv.invoicingMode),
    dateRaw: asTrimmedString(t.date),
    operator: asTrimmedString(t.operator) || asTrimmedString(t.company) || asTrimmedString(inv.operator),
    pickupLocation: asTrimmedString(t.location) || asTrimmedString(t.wellName) || asTrimmedString(inv.wellName),
    dropoffLocation: asTrimmedString(t.hauledTo) || asTrimmedString(t.disposal) || asTrimmedString(inv.hauledTo),
    driverLabel: asTrimmedString(t.driver) || asTrimmedString(inv.driver),
    ownerDriverId: canonicalDriverIdFromRecords({
      ownerDriverId: t.ownerDriverId,
      driverId: t.driverId,
      submittedBy: t.submittedBy,
      invoiceOwnerDriverId: inv.ownerDriverId,
      invoiceDriverId: inv.driverId,
    }),
    submittedBy: asTrimmedString(t.submittedBy),
    updatedBy: asTrimmedString(t.updatedBy),
    truck: asTrimmedString(t.truck) || asTrimmedString(inv.truckNumber),
    trailer: asTrimmedString(t.trailer) || asTrimmedString(inv.trailer),
    pickupBbls,
    dropoffBbls,
    tankTop: asTrimmedString(t.top),
    tankBottom: asTrimmedString(t.bottom),
    totalBbl: asBblString(inv.totalBBL) || dropoffBbls || qty,
    totalHours: asBblString(inv.totalHours) || asBblString(t.hours),
    invoiceStartedAt: asTrimmedString(inv.invoiceStartedAt),
    startTime: asTrimmedString(inv.startTime),
    timezone: asTrimmedString(inv.timezone),
    createdAtMs: timestampMs(t.createdAtMs) || timestampMs(t.createdAt),
    timeline: rawTimeline(inv.timeline),
    photos: live.photos.map((p) => ({ uri: p.uri, type: p.type, location: p.location, takenAt: p.takenAt })),
    jsaUri: live.jsaUri,
  };
}

export function paperSourceFingerprint(
  ticket: TicketSourceRecord | SourceRec,
  invoice: InvoiceSourceRecord | SourceRec,
): string {
  return JSON.stringify(collectPaperSource(ticket, invoice));
}

export function isTicketOnlyWaterTicket(
  ticket: TicketSourceRecord | SourceRec,
  invoice: InvoiceSourceRecord | SourceRec,
): boolean {
  const t = rec(ticket as SourceRec);
  const inv = rec(invoice as SourceRec);
  const mode = asTrimmedString(inv.invoicingMode);
  if (mode === 'ticket_only') return true;
  if (mode === 'invoice_tickets' || mode === 'hybrid') return false;
  const invoiceNumber = asTrimmedString(inv.invoiceNumber) || asTrimmedString(t.invoiceNumber);
  return invoiceNumber.length === 0;
}

export function projectWaterTicket(input: {
  ticket: TicketSourceRecord;
  invoice: InvoiceSourceRecord | null;
  legalName?: string;
  displayName?: string;
  photos: PaperPhotoMeta[];
  jsaContentHash?: string;
  jsaPath?: string;
  paperTimeZone?: string;
}): WaterTicketProjection | { ok: false; reason: string; message: string } {
  const { ticket, invoice } = input;
  const src = collectPaperSource(ticket, invoice);
  const ticketDocId = asTrimmedString(ticket.id);
  if (!ticketDocId) {
    return { ok: false, reason: 'ticket_id_required', message: 'Ticket document id is required.' };
  }
  if (!src.companyId) {
    return { ok: false, reason: 'company_required', message: 'Ticket has no companyId.' };
  }
  if (!isTicketOnlyWaterTicket(ticket, invoice)) {
    return { ok: false, reason: 'not_ticket_only', message: 'This slice materializes ticket-only Water Tickets.' };
  }
  if (!src.ticketNumber) {
    return { ok: false, reason: 'ticket_number_required', message: 'Ticket number is required.' };
  }

  const timeZone = input.paperTimeZone || src.timezone || DEFAULT_PAPER_TIMEZONE;
  const driverDisplayName = resolveHumanAuditLabel({
    legalName: input.legalName,
    displayName: input.displayName,
    historicalLabel: src.driverLabel,
  });
  const auditEditedBy = resolveHumanAuditLabel({
    historicalLabel: src.updatedBy,
  });

  return {
    artifactType: 'water_ticket',
    ticketDocId,
    invoiceDocId: src.invoiceDocId,
    ticketNumber: src.ticketNumber,
    companyId: src.companyId,
    ownerDriverId: src.ownerDriverId,
    paperTimeZone: timeZone,
    dateDisplay: formatDateDisplay(ticket.date, timeZone),
    acceptedTimeDisplay: invoice ? acceptedTimeFromInvoice(invoice, timeZone) : '',
    operator: src.operator,
    pickupLocation: src.pickupLocation,
    dropoffLocation: src.dropoffLocation,
    driverDisplayName,
    truck: src.truck,
    trailer: src.trailer,
    pickupBbls: src.pickupBbls,
    dropoffBbls: src.dropoffBbls,
    tankTop: src.tankTop,
    tankBottom: src.tankBottom,
    timeline: buildPaperTimeline(invoice?.timeline, timeZone),
    photos: input.photos,
    jsaContentHash: input.jsaContentHash || '',
    jsaPath: input.jsaPath || '',
    totalBbl: src.totalBbl,
    totalHours: src.totalHours,
    ticketCount: '1',
    auditSubmittedBy: driverDisplayName,
    auditEditedBy: auditEditedBy === 'Unknown driver' ? '' : auditEditedBy,
    auditCreatedAtDisplay: src.createdAtMs
      ? formatDateTimeDisplay(new Date(src.createdAtMs).toISOString(), timeZone)
      : '',
  };
}
