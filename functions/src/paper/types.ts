/**
 * Canonical paper v1 — ticket-only Water Ticket.
 * Structured tickets/invoices remain the editable source of truth.
 * Stored HTML is an immutable presentation revision.
 */

export const PAPER_ARTIFACT_TYPE = 'water_ticket' as const;
export type PaperArtifactType = typeof PAPER_ARTIFACT_TYPE;

export const PAPER_FEATURE_FLAG = 'CANONICAL_PAPER_TICKET_ONLY_V1';
export const DEFAULT_PAPER_TIMEZONE = 'America/Chicago';

export function waterTicketArtifactId(ticketDocId: string): string {
  return `wt:${ticketDocId}`;
}

export function paperStorageHtmlPath(companyId: string, artifactId: string, revisionId: string): string {
  return `paper/${companyId}/${artifactId}/${revisionId}/document.html`;
}

export function paperAssetPath(
  companyId: string,
  artifactId: string,
  revisionId: string,
  contentHash: string,
): string {
  return `paper/${companyId}/${artifactId}/${revisionId}/assets/${contentHash}`;
}

export interface PaperTimelineEvent {
  type: string;
  timestamp: string;
  timeDisplay: string;
  label: string;
  locationName: string;
}

export interface LivePhotoRef {
  uri: string;
  location: string;
  type: string;
  takenAt: string;
}

export interface PaperPhotoMeta {
  contentHash: string;
  thumbHash: string;
  originalPath: string;
  thumbPath: string;
  mimeType: string;
  thumbMimeType: string;
  width: number;
  height: number;
  location: string;
  type: string;
  takenAt: string;
}

export interface WaterTicketProjection {
  artifactType: PaperArtifactType;
  ticketDocId: string;
  invoiceDocId: string;
  ticketNumber: string;
  companyId: string;
  ownerDriverId: string;
  paperTimeZone: string;
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
  photos: PaperPhotoMeta[];
  jsaContentHash: string;
  jsaPath: string;
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
  nextRevisionSeq: number;
  displayNumber: string;
  companyId: string;
  ticketDocId: string;
  invoiceDocId: string;
  ownerDriverId: string;
  paperTimeZone: string;
  currentEventMs: number;
  currentSourceEventId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PaperRevisionRecord {
  artifactId: string;
  artifactType: PaperArtifactType;
  revisionId: string;
  displayNumber: string;
  companyId: string;
  ticketDocId: string;
  invoiceDocId: string;
  ownerDriverId: string;
  contentHash: string;
  storageHtmlPath: string;
  storagePdfPath: string | null;
  sourceEventId: string;
  eventMs: number;
  createdAtMs: number;
  actorUid: string;
  actorDriverId: string | null;
  humanAuditLabel: string;
  projection: WaterTicketProjection;
}

export interface PaperVisibleSource {
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
}

export interface PaperSourceSnapshot {
  op: PaperOp;
  editSource?: PaperEditSource;
  ticketDocId: string;
  invoiceDocId: string;
  companyId: string;
  ownerDriverId: string;
  ticketNumber: string;
  fingerprint: string;
  paperTimeZone: string;
  legalName?: string;
  displayName?: string;
  assetUris: string[];
  source: PaperVisibleSource;
  snapshotBytes: number;
}

export type PaperWorkflowStage = 'dispatch_review' | 'payroll_review' | 'billing';

export interface PaperWorkflowRecord {
  ticketDocId: string;
  invoiceDocId: string;
  companyId: string;
  stage: PaperWorkflowStage;
  version: number;
  closedAtMs: number | null;
  handedToPayrollAtMs: number | null;
  handedToPayrollByUid: string | null;
  finalizedToBillingAtMs: number | null;
  finalizedToBillingByUid: string | null;
  overrideActive: boolean;
  overrideReason: string | null;
  overrideByUid: string | null;
  overrideAtMs: number | null;
  lastMutationId: string | null;
  updatedAtMs: number;
}

export type TicketReviewRecord = PaperWorkflowRecord;

export interface TicketReviewEventRecord {
  mutationId: string;
  ticketDocId: string;
  invoiceDocId: string;
  companyId: string;
  action: 'correct' | 'hand_to_payroll' | 'finalize_to_billing' | 'reopen';
  actorUid: string;
  via: string;
  reason: string | null;
  fields: string[];
  stageBefore: string;
  stageAfter: string;
  versionBefore: number;
  versionAfter: number;
  nowMs: number;
  batchId?: string;
}

export interface PaperSourceEventRecord {
  sourceEventId: string;
  artifactId: string;
  revisionId: string;
  eventMs: number;
  status: 'reserved' | 'complete';
  sourceSnapshot?: PaperSourceSnapshot;
}

export interface PaperInvoiceIndexRecord {
  invoiceDocId: string;
  artifactId: string;
  ticketDocId: string;
  companyId: string;
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
  ownerDriverId?: unknown;
  driverId?: unknown;
  createdAtMs?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  updatedAtMs?: unknown;
  editedAt?: unknown;
  packageId?: unknown;
  paperMutationId?: unknown;
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
  closedAt?: unknown;
  closedAtMs?: unknown;
  createdAt?: unknown;
  createdAtMs?: unknown;
  ownerDriverId?: unknown;
  driverId?: unknown;
  timezone?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  updatedAtMs?: unknown;
  editedAt?: unknown;
  paperMutationId?: unknown;
}

export type PaperCallerKind = 'dashboard' | 'driver' | 'system';

export interface PaperCaller {
  kind: PaperCallerKind;
  uid: string;
  companyId?: string;
  isPlatformAdmin: boolean;
  roles?: string[];
  caps?: string[];
  driverId?: string;
}

export type PaperLookup =
  | { ticketDocId: string; invoiceDocId?: undefined }
  | { invoiceDocId: string; ticketDocId?: undefined };

export type PaperOp = 'close' | 'edit';
export type PaperEditSource = 'ticket' | 'invoice';

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
