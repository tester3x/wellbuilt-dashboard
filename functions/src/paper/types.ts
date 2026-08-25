/**
 * Canonical paper v1 — ticket-only Water Ticket.
 * Structured tickets/invoices remain editable source of truth.
 * Stored HTML is an immutable presentation revision.
 */

export const PAPER_ARTIFACT_TYPE = 'water_ticket' as const;
export type PaperArtifactType = typeof PAPER_ARTIFACT_TYPE;

export const PAPER_FEATURE_FLAG = 'CANONICAL_PAPER_TICKET_ONLY_V1';

export function waterTicketArtifactId(ticketDocId: string): string {
  return `wt:${ticketDocId}`;
}

export function paperStorageHtmlPath(companyId: string, artifactId: string, revisionId: string): string {
  return `paper/${companyId}/${artifactId}/${revisionId}/document.html`;
}

export interface PaperTimelineEvent {
  type: string;
  timestamp: string;
  label: string;
  locationName: string;
}

export interface PaperPhoto {
  uri: string;
  location: string;
  type: string;
  takenAt: string;
}

export interface WaterTicketProjection {
  artifactType: PaperArtifactType;
  ticketDocId: string;
  ticketNumber: string;
  companyId: string;
  dateDisplay: string;
  acceptedTimeDisplay: string;
  operator: string;
  pickupLocation: string;
  dropoffLocation: string;
  driverDisplayName: string;
  truck: string;
  trailer: string;
  pickupBbls: string;
  dropoffBbls: string;
  tankTop: string;
  tankBottom: string;
  timeline: PaperTimelineEvent[];
  photos: PaperPhoto[];
  jsaUri: string;
  totalBbl: string;
  totalHours: string;
  ticketCount: string;
  auditSubmittedBy: string;
  auditEditedBy: string;
  auditCreatedAtDisplay: string;
}

export interface PaperArtifactRecord {
  artifactId: string;
  artifactType: PaperArtifactType;
  currentRevisionId: string;
  displayNumber: string;
  companyId: string;
  ticketDocId: string;
  invoiceDocId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PaperRevisionRecord {
  artifactId: string;
  artifactType: PaperArtifactType;
  revisionId: string;
  displayNumber: string;
  companyId: string;
  contentHash: string;
  storageHtmlPath: string;
  storagePdfPath: string | null;
  sourceEventId: string;
  createdAtMs: number;
  actorUid: string;
  actorDriverId: string | null;
  humanAuditLabel: string;
  projection: WaterTicketProjection;
}

export interface TicketSourceRecord {
  id: string;
  ticketNumber?: unknown;
  date?: unknown;
  company?: unknown;
  companyId?: unknown;
  operator?: unknown;
  location?: unknown;
  wellName?: unknown;
  hauledTo?: unknown;
  disposal?: unknown;
  driver?: unknown;
  truck?: unknown;
  trailer?: unknown;
  qty?: unknown;
  bbls?: unknown;
  pickupBbls?: unknown;
  dropoffBbls?: unknown;
  top?: unknown;
  bottom?: unknown;
  hours?: unknown;
  invoiceNumber?: unknown;
  invoiceDocId?: unknown;
  submittedBy?: unknown;
  updatedBy?: unknown;
  updatedByUid?: unknown;
  updatedByDriverId?: unknown;
  createdAtMs?: unknown;
  createdAt?: unknown;
  packageId?: unknown;
}

export interface InvoiceSourceRecord {
  id: string;
  invoiceNumber?: unknown;
  invoicingMode?: unknown;
  operator?: unknown;
  wellName?: unknown;
  hauledTo?: unknown;
  driver?: unknown;
  truckNumber?: unknown;
  trailer?: unknown;
  totalBBL?: unknown;
  totalHours?: unknown;
  invoiceStartedAt?: unknown;
  startTime?: unknown;
  companyId?: unknown;
  tickets?: unknown;
  timeline?: unknown;
  photos?: unknown;
  notes?: unknown;
}

export interface PaperCaller {
  uid: string;
  companyId?: string;
  isPlatformAdmin: boolean;
}

export type PaperLookup =
  | { ticketDocId: string; invoiceDocId?: undefined }
  | { invoiceDocId: string; ticketDocId?: undefined };

export type MaterializeDecision =
  | { ok: true; action: 'created'; revision: PaperRevisionRecord; artifact: PaperArtifactRecord }
  | { ok: true; action: 'idempotent'; revision: PaperRevisionRecord; artifact: PaperArtifactRecord }
  | { ok: false; reason: string; message: string };

export type GetPaperDecision =
  | {
      ok: true;
      artifactId: string;
      artifactType: PaperArtifactType;
      revisionId: string;
      displayNumber: string;
      companyId: string;
      contentHash: string;
      html: string;
    }
  | { ok: false; reason: string; message: string };
