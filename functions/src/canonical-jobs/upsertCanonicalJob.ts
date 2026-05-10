// canonical_jobs upsert helpers — Phase 1 (additive write/link only).
//
// MIRROR FILE: identical at
//   wellbuilt-tickets/functions/src/canonical-jobs/upsertCanonicalJob.ts
//
// Three exported writers:
//   upsertCanonicalJob       — packet_sent / ticket_submitted / edited / closed
//   upsertOnTransferAccept   — transfer_accepted (current-owner overwrite,
//                              originalDriverHash preserved)
//   appendCanonicalEvent     — transfer_cancelled / declined / expired /
//                              deleted (event-only, no field changes)
//
// Architectural rules enforced (per CLAUDE_CANONICAL_JOBS Phase 1 spec):
//   1. packetId, when present, IS the doc id. Never auto-id.
//   2. originalDriverHash set ONCE on create; never overwritten on patch.
//   3. transfer_accepted overwrites driverHash/Name/truck/trailer/etc.;
//      originalDriverHash preserved.
//   4. companyId required: callers MUST log canonical.job_missing_companyId
//      when the returned missingCompanyId flag is true. Phase 1 still proceeds.
//   5. transfer-only events without packetId are NO-OP at the call site.
//   6. event.extra is bounded to identifiers + scalars. No nested objects.
//   7. dateTimeUTC = pull/job time (set-once); event.timestamp = system time.

import * as admin from 'firebase-admin';
import {
  CanonicalJob,
  CanonicalJobEvent,
  CanonicalJobEventType,
  CanonicalJobSource,
} from './types';

const COLLECTION = 'canonical_jobs';

// ── helpers ────────────────────────────────────────────────────────────────

function db(): FirebaseFirestore.Firestore {
  return admin.firestore();
}

// RULE 1: packetId-first, auto-id only when packetId is null/empty.
function resolveDocId(packetId?: string | null): { docId: string; isAutoId: boolean } {
  if (typeof packetId === 'string' && packetId.length > 0) {
    return { docId: packetId, isAutoId: false };
  }
  const ms = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return { docId: `cj_${ms}_${rand}`, isAutoId: true };
}

// RULE 6: bound extra to identifiers + scalars. Drop arrays/objects.
const MAX_EXTRA_KEYS = 12;
const MAX_STRING_LEN = 256;
function sanitizeExtra(
  extra?: Record<string, unknown> | null,
): Record<string, string | number | boolean | null> {
  if (!extra) return {};
  const out: Record<string, string | number | boolean | null> = {};
  let count = 0;
  for (const [k, v] of Object.entries(extra)) {
    if (count >= MAX_EXTRA_KEYS) break;
    if (v === null || v === undefined) {
      out[k] = null;
    } else if (typeof v === 'string') {
      out[k] = v.length > MAX_STRING_LEN ? v.slice(0, MAX_STRING_LEN) : v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
    // arrays / nested objects intentionally dropped per RULE 6
    count++;
  }
  return out;
}

// fill only when existing field is null/undefined; preserves first-write linkage.
function fillOnce(
  patch: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
  key: string,
  incoming: unknown,
): void {
  if (incoming === null || incoming === undefined) return;
  const existingVal = existing ? existing[key] : undefined;
  if (existingVal === null || existingVal === undefined) {
    patch[key] = incoming;
  }
}

function buildEvent(
  type: CanonicalJobEventType,
  actorDriverHash: string | null,
  actorSource: CanonicalJobSource,
  notes: string | null,
  extra?: Record<string, unknown> | null,
): CanonicalJobEvent {
  return {
    type,
    timestamp: Date.now(),
    actorDriverHash,
    actorSource,
    notes,
    extra: sanitizeExtra(extra),
  };
}

// ── public API ─────────────────────────────────────────────────────────────

export interface UpsertInput {
  packetId?: string | null;

  ticketDocId?: string | null;
  ticketNumber?: string | null;
  invoiceDocId?: string | null;
  invoiceNumber?: string | null;
  dispatchId?: string | null;
  transferRequestId?: string | null;

  companyId?: string | null;

  driverHash?: string | null;
  driverName?: string | null;
  truck?: string | null;
  trailer?: string | null;
  truckId?: string | null;
  trailerId?: string | null;

  shiftId?: string | null;
  projectId?: string | null;

  wellId?: string | null;
  wellName?: string | null;
  wellConfigKey?: string | null;
  customLocationId?: string | null;
  disposalId?: string | null;
  hauledTo?: string | null;

  bblsTaken?: number | null;
  tankLevelFeet?: number | null;
  tankAfterFeet?: number | null;
  dateTimeUTC?: string | null;

  source: CanonicalJobSource;
}

export interface UpsertEvent {
  type: CanonicalJobEventType;
  actorDriverHash?: string | null;
  actorSource: CanonicalJobSource;
  notes?: string | null;
  extra?: Record<string, unknown> | null;
}

export interface UpsertResult {
  canonicalJobId: string;
  created: boolean;
  missingCompanyId: boolean;
  isAutoId: boolean;
}

/**
 * Generic upsert. Use for packet_sent / ticket_submitted / edited / closed.
 * Linkage fields use fill-once semantics; STATE fields (driver* / truck /
 * trailer / *Id) are overwritten when provided. originalDriverHash captured
 * on first create.
 */
export async function upsertCanonicalJob(
  input: UpsertInput,
  event: UpsertEvent,
): Promise<UpsertResult> {
  const { docId, isAutoId } = resolveDocId(input.packetId);
  const ref = db().collection(COLLECTION).doc(docId);
  const missingCompanyId = !input.companyId;
  let created = false;

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const eventRecord = buildEvent(
      event.type,
      event.actorDriverHash ?? null,
      event.actorSource,
      event.notes ?? null,
      event.extra,
    );

    if (!snap.exists) {
      // CREATE — RULE 2: originalDriverHash captured exactly once.
      created = true;
      const incomingDriverHash = input.driverHash ?? null;
      const data: Record<string, unknown> = {
        canonicalJobId: docId,
        packetId: input.packetId ?? null,
        ticketDocId: input.ticketDocId ?? null,
        ticketNumber: input.ticketNumber ?? null,
        invoiceDocId: input.invoiceDocId ?? null,
        invoiceNumber: input.invoiceNumber ?? null,
        dispatchId: input.dispatchId ?? null,
        transferRequestId: input.transferRequestId ?? null,
        companyId: input.companyId ?? null,
        driverHash: incomingDriverHash,
        originalDriverHash: incomingDriverHash, // RULE 2: set-once
        driverName: input.driverName ?? null,
        truck: input.truck ?? null,
        trailer: input.trailer ?? null,
        truckId: input.truckId ?? null,
        trailerId: input.trailerId ?? null,
        shiftId: input.shiftId ?? null,
        projectId: input.projectId ?? null,
        wellId: input.wellId ?? null,
        wellName: input.wellName ?? null,
        wellConfigKey: input.wellConfigKey ?? null,
        customLocationId: input.customLocationId ?? null,
        disposalId: input.disposalId ?? null,
        hauledTo: input.hauledTo ?? null,
        bblsTaken: input.bblsTaken ?? null,
        tankLevelFeet: input.tankLevelFeet ?? null,
        tankAfterFeet: input.tankAfterFeet ?? null,
        dateTimeUTC: input.dateTimeUTC ?? null, // RULE 7: pull time, write-once
        source: input.source,
        createdAt: now,
        updatedAt: now,
        events: [eventRecord],
      };
      tx.set(ref, data);
      return;
    }

    // PATCH branch.
    const existing = snap.data() as Record<string, unknown> | undefined;
    const patch: Record<string, unknown> = { updatedAt: now };

    // ── LINKAGE fields (fill-once-when-null) ───────────────────────────
    fillOnce(patch, existing, 'packetId', input.packetId);
    fillOnce(patch, existing, 'ticketDocId', input.ticketDocId);
    fillOnce(patch, existing, 'ticketNumber', input.ticketNumber);
    fillOnce(patch, existing, 'invoiceDocId', input.invoiceDocId);
    fillOnce(patch, existing, 'invoiceNumber', input.invoiceNumber);
    fillOnce(patch, existing, 'dispatchId', input.dispatchId);
    fillOnce(patch, existing, 'transferRequestId', input.transferRequestId);
    fillOnce(patch, existing, 'companyId', input.companyId);
    fillOnce(patch, existing, 'shiftId', input.shiftId);
    fillOnce(patch, existing, 'projectId', input.projectId);
    fillOnce(patch, existing, 'wellId', input.wellId);
    fillOnce(patch, existing, 'wellName', input.wellName);
    fillOnce(patch, existing, 'wellConfigKey', input.wellConfigKey);
    fillOnce(patch, existing, 'customLocationId', input.customLocationId);
    fillOnce(patch, existing, 'disposalId', input.disposalId);
    fillOnce(patch, existing, 'hauledTo', input.hauledTo);
    fillOnce(patch, existing, 'bblsTaken', input.bblsTaken);
    fillOnce(patch, existing, 'tankLevelFeet', input.tankLevelFeet);
    fillOnce(patch, existing, 'tankAfterFeet', input.tankAfterFeet);
    fillOnce(patch, existing, 'dateTimeUTC', input.dateTimeUTC);

    // ── STATE fields (overwrite when provided) ─────────────────────────
    if (input.driverHash != null) patch.driverHash = input.driverHash;
    if (input.driverName != null) patch.driverName = input.driverName;
    if (input.truck != null) patch.truck = input.truck;
    if (input.trailer != null) patch.trailer = input.trailer;
    if (input.truckId != null) patch.truckId = input.truckId;
    if (input.trailerId != null) patch.trailerId = input.trailerId;

    // RULE 2: originalDriverHash is set-once — backfill only if missing.
    if (
      (existing?.originalDriverHash === null || existing?.originalDriverHash === undefined) &&
      input.driverHash
    ) {
      patch.originalDriverHash = input.driverHash;
    }

    patch.events = admin.firestore.FieldValue.arrayUnion(eventRecord);
    tx.update(ref, patch);
  });

  return { canonicalJobId: docId, created, missingCompanyId, isAutoId };
}

// ── transfer accept ────────────────────────────────────────────────────────

export interface TransferAcceptOwner {
  driverHash: string;
  driverName?: string | null;
  truck?: string | null;
  trailer?: string | null;
  truckId?: string | null;
  trailerId?: string | null;
}

export interface TransferAcceptContext {
  transferRequestId: string;
  companyId?: string | null;
  actorSource: CanonicalJobSource;
  notes?: string | null;
  extra?: Record<string, unknown> | null;
}

export interface TransferAcceptResult {
  canonicalJobId: string;
  missingCompanyId: boolean;
  // True when the canonical row didn't exist at accept time. The caller
  // SHOULD log canonical.job_transfer_missing_canonical_row — indicates
  // a prior packet_sent / ticket_submitted upsert failed.
  missingExisting: boolean;
}

/**
 * RULE 3: overwrite current-owner fields, preserve originalDriverHash.
 * packetId is REQUIRED (transfer flows always carry one).
 */
export async function upsertOnTransferAccept(
  packetId: string,
  newOwner: TransferAcceptOwner,
  context: TransferAcceptContext,
): Promise<TransferAcceptResult> {
  if (!packetId || typeof packetId !== 'string') {
    throw new Error('upsertOnTransferAccept: packetId is required');
  }
  const ref = db().collection(COLLECTION).doc(packetId);
  const missingCompanyId = !context.companyId;
  let missingExisting = false;

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const eventRecord = buildEvent(
      'transfer_accepted',
      newOwner.driverHash,
      context.actorSource,
      context.notes ?? null,
      context.extra,
    );

    if (!snap.exists) {
      // Recovery create — flagged via missingExisting. originalDriverHash
      // unknown; best-effort placeholder = receiver hash. Caller logs.
      missingExisting = true;
      tx.set(ref, {
        canonicalJobId: packetId,
        packetId,
        ticketDocId: null,
        ticketNumber: null,
        invoiceDocId: null,
        invoiceNumber: null,
        dispatchId: null,
        transferRequestId: context.transferRequestId,
        companyId: context.companyId ?? null,
        driverHash: newOwner.driverHash,
        originalDriverHash: newOwner.driverHash,
        driverName: newOwner.driverName ?? null,
        truck: newOwner.truck ?? null,
        trailer: newOwner.trailer ?? null,
        truckId: newOwner.truckId ?? null,
        trailerId: newOwner.trailerId ?? null,
        shiftId: null,
        projectId: null,
        wellId: null,
        wellName: null,
        wellConfigKey: null,
        customLocationId: null,
        disposalId: null,
        hauledTo: null,
        bblsTaken: null,
        tankLevelFeet: null,
        tankAfterFeet: null,
        dateTimeUTC: null,
        source: 'wbt',
        createdAt: now,
        updatedAt: now,
        events: [eventRecord],
      });
      return;
    }

    const existing = snap.data() as Record<string, unknown>;

    // RULE 3: overwrite current-owner fields. originalDriverHash NOT in patch
    // — Firestore .update() preserves any field not in the patch object.
    const patch: Record<string, unknown> = {
      driverHash: newOwner.driverHash,
      driverName: newOwner.driverName ?? null,
      truck: newOwner.truck ?? null,
      trailer: newOwner.trailer ?? null,
      truckId: newOwner.truckId ?? null,
      trailerId: newOwner.trailerId ?? null,
      transferRequestId: context.transferRequestId,
      updatedAt: now,
      events: admin.firestore.FieldValue.arrayUnion(eventRecord),
    };
    // companyId still fill-once
    if (
      (existing.companyId === null || existing.companyId === undefined) &&
      context.companyId
    ) {
      patch.companyId = context.companyId;
    }
    tx.update(ref, patch);
  });

  return { canonicalJobId: packetId, missingCompanyId, missingExisting };
}

// ── append-only event ──────────────────────────────────────────────────────

/**
 * Append an event without changing any field. NO-OP if canonical row missing.
 * Used by transfer_cancelled / declined / expired / deleted.
 */
export async function appendCanonicalEvent(
  packetId: string,
  event: UpsertEvent,
): Promise<{ canonicalJobId: string; existed: boolean }> {
  const ref = db().collection(COLLECTION).doc(packetId);
  const eventRecord = buildEvent(
    event.type,
    event.actorDriverHash ?? null,
    event.actorSource,
    event.notes ?? null,
    event.extra,
  );
  const snap = await ref.get();
  if (!snap.exists) return { canonicalJobId: packetId, existed: false };
  await ref.update({
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    events: admin.firestore.FieldValue.arrayUnion(eventRecord),
  });
  return { canonicalJobId: packetId, existed: true };
}

// Re-export types for call-site convenience.
export type { CanonicalJob, CanonicalJobEvent, CanonicalJobSource };
