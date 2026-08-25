import { utf8Bytes } from './hash';
import { collectPaperSource, paperSourceFingerprint } from './projection';
import type {
  InvoiceSourceRecord,
  PaperEditSource,
  PaperOp,
  PaperSourceSnapshot,
  TicketSourceRecord,
} from './types';

/** Event docs stay well under Firestore's 1MB limit. */
export const MAX_SOURCE_SNAPSHOT_BYTES = 64 * 1024;

export function buildPaperSourceSnapshot(input: {
  op: PaperOp;
  editSource?: PaperEditSource;
  ticket: TicketSourceRecord;
  invoice: InvoiceSourceRecord | null;
  paperTimeZone: string;
  legalName?: string;
  displayName?: string;
}): { ok: true; snapshot: PaperSourceSnapshot } | { ok: false; reason: string; message: string } {
  const source = collectPaperSource(input.ticket, input.invoice);
  const snapshot: PaperSourceSnapshot = {
    op: input.op,
    ticketDocId: input.ticket.id,
    invoiceDocId: source.invoiceDocId,
    companyId: source.companyId,
    ownerDriverId: source.ownerDriverId,
    ticketNumber: source.ticketNumber,
    fingerprint: paperSourceFingerprint(input.ticket, input.invoice),
    paperTimeZone: input.paperTimeZone,
    assetUris: [...source.photos.map((p) => p.uri), ...(source.jsaUri ? [source.jsaUri] : [])],
    source,
    snapshotBytes: 0,
  };
  if (input.editSource) snapshot.editSource = input.editSource;
  if (input.legalName) snapshot.legalName = input.legalName;
  if (input.displayName) snapshot.displayName = input.displayName;
  const bytes = utf8Bytes(JSON.stringify(snapshot));
  snapshot.snapshotBytes = bytes.length;
  if (bytes.length > MAX_SOURCE_SNAPSHOT_BYTES) {
    return { ok: false, reason: 'snapshot_too_large', message: 'Paper source snapshot exceeds 64KB bound.' };
  }
  return { ok: true, snapshot };
}

export function recordsFromPaperSourceSnapshot(snap: PaperSourceSnapshot): {
  ticket: TicketSourceRecord;
  invoice: InvoiceSourceRecord | null;
} {
  const s = snap.source;
  const ticket: TicketSourceRecord = {
    id: snap.ticketDocId,
    ticketNumber: s.ticketNumber,
    companyId: s.companyId,
    invoiceDocId: s.invoiceDocId,
    date: s.dateRaw,
    operator: s.operator,
    location: s.pickupLocation,
    hauledTo: s.dropoffLocation,
    driver: s.driverLabel,
    truck: s.truck,
    trailer: s.trailer,
    pickupBbls: s.pickupBbls,
    dropoffBbls: s.dropoffBbls,
    top: s.tankTop,
    bottom: s.tankBottom,
    hours: s.totalHours,
    ownerDriverId: s.ownerDriverId,
    submittedBy: s.submittedBy,
    updatedBy: s.updatedBy,
    createdAtMs: s.createdAtMs,
    invoiceNumber: s.invoiceNumber,
  };
  if (!snap.invoiceDocId) return { ticket, invoice: null };
  const photos = s.jsaUri
    ? [...s.photos, { uri: s.jsaUri, type: 'jsa' }]
    : s.photos;
  const invoice: InvoiceSourceRecord = {
    id: snap.invoiceDocId,
    companyId: s.companyId,
    invoiceNumber: s.invoiceNumber,
    invoicingMode: s.invoicingMode,
    operator: s.operator,
    wellName: s.pickupLocation,
    hauledTo: s.dropoffLocation,
    driver: s.driverLabel,
    truckNumber: s.truck,
    trailer: s.trailer,
    totalBBL: s.totalBbl,
    totalHours: s.totalHours,
    invoiceStartedAt: s.invoiceStartedAt,
    startTime: s.startTime,
    timezone: s.timezone,
    ownerDriverId: s.ownerDriverId,
    photos,
    timeline: s.timeline,
  };
  return { ticket, invoice };
}
