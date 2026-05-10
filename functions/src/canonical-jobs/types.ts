// canonical_jobs — Phase 1 additive linking layer.
//
// MIRROR FILE: identical shape lives at
//   wellbuilt-tickets/functions/src/canonical-jobs/types.ts
// Keep both in sync. Mirror exists because Dashboard CF (codebase: default)
// and WB T CF (codebase: waterticket) are deployed separately and cannot
// share imports.
//
// Phase 1 = WRITE/LINK ONLY. No readers depend on this collection yet.

export type CanonicalJobSource = 'wbm' | 'wbt' | 'cf' | 'dashboard';

export type CanonicalJobEventType =
  | 'packet_sent'
  | 'ticket_submitted'
  | 'transfer_requested'
  | 'transfer_accepted'
  | 'transfer_cancelled'
  | 'transfer_declined'
  | 'transfer_expired'
  | 'closed'
  | 'edited'
  | 'deleted';

export interface CanonicalJobEvent {
  type: CanonicalJobEventType;
  // System event time (ms epoch). Distinct from CanonicalJob.dateTimeUTC,
  // which is the JOB event time (e.g. tank pull moment).
  timestamp: number;
  actorDriverHash: string | null;
  actorSource: CanonicalJobSource;
  notes: string | null;
  // Bounded extra payload — identifiers + scalars only. See sanitizeExtra
  // in upsertCanonicalJob.ts.
  extra: Record<string, string | number | boolean | null>;
}

export interface CanonicalJob {
  // Doc id. Equal to packetId when present, else cj_{ms}_{rand}.
  canonicalJobId: string;

  // ── LINKAGE (fill-once-when-null) ────────────────────────────────
  packetId: string | null;
  ticketDocId: string | null;
  ticketNumber: string | null;
  invoiceDocId: string | null;
  invoiceNumber: string | null;
  dispatchId: string | null;
  transferRequestId: string | null;
  companyId: string | null;

  // ── STATE (overwrite when provided) ──────────────────────────────
  driverHash: string | null;
  driverName: string | null;
  truck: string | null;
  trailer: string | null;
  truckId: string | null;
  trailerId: string | null;

  // ── IMMUTABLE-AFTER-FIRST-WRITE ─────────────────────────────────
  // Captured on CREATE; never overwritten. Source of truth for who
  // originated the job, even after transfer ownership flips.
  originalDriverHash: string | null;

  // ── LINKAGE (job metadata, fill-once-when-null) ──────────────────
  shiftId: string | null;
  projectId: string | null;
  wellId: string | null;
  wellName: string | null;
  wellConfigKey: string | null;
  customLocationId: string | null;
  disposalId: string | null;
  hauledTo: string | null;
  bblsTaken: number | null;
  tankLevelFeet: number | null;
  tankAfterFeet: number | null;
  // Pull / job event time (ISO). Distinct from event[].timestamp.
  dateTimeUTC: string | null;

  source: CanonicalJobSource;

  // serverTimestamp on first write
  createdAt: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp;

  events: CanonicalJobEvent[];
}
