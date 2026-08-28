// packetGuards.ts — future-time validation + lossless quarantine for
// incoming packets.
//
// GS3 incident (7/21–22/2026): a pull was accidentally entered as 11:07 PM
// while it was still earlier that evening. The future timestamp became
// outgoing.lastPullDateTimeUTC, and when five legitimate packets arrived
// they compared "not newer" than the poisoned watermark and were deleted by
// `snapshot.ref.remove()` — no processed row, no response, no rejection
// record, no user-visible error. Recovery required manual backfill.
//
// Two rules fall out of that incident:
//  1. Never trust a timestamp from the future — neither an incoming pull's
//     nor the stored watermark's. Clock skew gets a 5-minute allowance.
//  2. Never destroy a packet. Every rejection is quarantined to
//     packets/rejected/<packetId> with the complete original payload and a
//     machine-stable reason, in ONE atomic multi-location update that also
//     removes packets/incoming/<packetId>. If that update fails, the
//     incoming packet stays put so the rejection can retry.
//
// This module is pure/injected (no admin SDK import) so it unit-tests
// without an emulator: index.ts supplies the clock and the root ref.

export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export type RejectionReason =
  | 'FUTURE_PULL_TIME'
  | 'FUTURE_WELL_WATERMARK'
  | 'STALE_PULL_TIME'
  | 'ORIGINAL_PACKET_NOT_FOUND'
  | 'AMBIGUOUS_EDIT_TARGET'
  | 'MALFORMED_PULL_TIME'
  | 'MALFORMED_WELL_WATERMARK'
  | 'STRANDED_INCOMING_PACKET'
  | 'PACKET_ID_COLLISION';

export interface GuardVerdict {
  /** 'process' — accept as (potentially) newest, advancing the watermark.
   *  'process_backdated' — a VALID older pull: accept into chronological history
   *    WITHOUT advancing/regressing the watermark (Late-Entry lane).
   *  'quarantine' — reject losslessly. */
  action: 'process' | 'process_backdated' | 'quarantine';
  reason?: RejectionReason;
  readableReason?: string;
  /** The watermark the packet was compared against, when one was involved. */
  comparedWatermarkUTC?: string | null;
}

const PROCESS: GuardVerdict = { action: 'process' };

/**
 * Validation ladder for an incoming pull, in this exact order:
 *   1. parse the incoming timestamp;
 *   2. reject an incoming FUTURE time (> now + 5 min);
 *   3. parse the existing watermark;
 *   4. reject against a FUTURE-poisoned watermark (> now + 5 min) — a
 *      corrupted watermark must never be used to call real packets stale;
 *   5. normal stale comparison, only when BOTH timestamps are valid;
 *   6. otherwise process.
 *
 * Malformed timestamps are quarantined, never silently coerced or run
 * through comparisons: an unparseable incoming time is MALFORMED_PULL_TIME
 * and an unparseable stored watermark (when an outgoing response exists) is
 * MALFORMED_WELL_WATERMARK — corrupted state must be reviewed, not trusted.
 */
export function evaluateIncomingPull(args: {
  incomingDateTimeUTC: unknown;
  /** True when the well HAS an outgoing response — distinguishes "no
   *  watermark yet" (fine) from "watermark exists but is unreadable"
   *  (quarantine). */
  hasOutgoingResponse: boolean;
  /** prevResponse?.lastPullDateTimeUTC — only meaningful when hasOutgoingResponse. */
  watermarkDateTimeUTC: unknown;
  nowMs: number;
}): GuardVerdict {
  const { incomingDateTimeUTC, hasOutgoingResponse, watermarkDateTimeUTC, nowMs } = args;

  // 1: incoming timestamp must parse.
  const incomingMs =
    typeof incomingDateTimeUTC === 'string' ? new Date(incomingDateTimeUTC).getTime() : NaN;
  if (isNaN(incomingMs)) {
    return {
      action: 'quarantine',
      reason: 'MALFORMED_PULL_TIME',
      readableReason:
        `Incoming pull timestamp ${JSON.stringify(incomingDateTimeUTC)} is unreadable — ` +
        `the packet cannot be safely processed or compared, so it is held for review ` +
        `with its raw value intact.`,
      comparedWatermarkUTC: null,
    };
  }

  // 2: incoming future time.
  if (incomingMs - nowMs > FUTURE_TOLERANCE_MS) {
    return {
      action: 'quarantine',
      reason: 'FUTURE_PULL_TIME',
      readableReason:
        `Incoming pull time ${String(incomingDateTimeUTC)} is ` +
        `${Math.round((incomingMs - nowMs) / 60000)} min ahead of server time ` +
        `${new Date(nowMs).toISOString()} — a completed pull cannot be in the future ` +
        `(likely an AM/PM or date entry mistake).`,
      comparedWatermarkUTC: null,
    };
  }

  // 3: the stored watermark must parse — when one is supposed to exist.
  const watermarkMs =
    typeof watermarkDateTimeUTC === 'string' ? new Date(watermarkDateTimeUTC).getTime() : NaN;
  if (hasOutgoingResponse && isNaN(watermarkMs)) {
    return {
      action: 'quarantine',
      reason: 'MALFORMED_WELL_WATERMARK',
      readableReason:
        `The well's outgoing watermark ${JSON.stringify(watermarkDateTimeUTC)} is unreadable — ` +
        `stale comparison is impossible against corrupted state, so this packet is held ` +
        `for review instead of being processed or judged against it.`,
      comparedWatermarkUTC:
        watermarkDateTimeUTC === undefined || watermarkDateTimeUTC === null
          ? null
          : String(watermarkDateTimeUTC),
    };
  }

  // 4: future-poisoned watermark.
  if (!isNaN(watermarkMs) && watermarkMs - nowMs > FUTURE_TOLERANCE_MS) {
    return {
      action: 'quarantine',
      reason: 'FUTURE_WELL_WATERMARK',
      readableReason:
        `The well's outgoing watermark ${String(watermarkDateTimeUTC)} is in the future ` +
        `relative to server time ${new Date(nowMs).toISOString()} — the watermark is ` +
        `corrupted (GS3-style AM/PM poisoning), so this packet is held for review ` +
        `instead of being judged against it.`,
      comparedWatermarkUTC: String(watermarkDateTimeUTC),
    };
  }

  // 5: order comparison, only with two valid timestamps.
  // NOT newer than the current pull (older OR sharing the exact watermark
  // minute). This is NOT stale merely for being older/equal:
  //   - same packetId + equivalent material → idempotent replay, and
  //   - same packetId + different material → PACKET_ID_COLLISION
  //     are BOTH decided BEFORE this guard (processed-existence +
  //     comparePullEquivalence), so only a DISTINCT packetId reaches here;
  //   - a distinct pull at/below the watermark (a back-dated entry, or a second
  //     truck / minute-rounded manual entry sharing the current minute) is
  //     ACCEPTED into chronological history and ordered by the COMPLETE sort key
  //     (event time + packetId tie-break) at insertion; a logical duplicate
  //     (same time+material, different id) collapses to a no-op there.
  // Never blanket-reject a distinct pull for sharing/preceding the watermark.
  if (!isNaN(incomingMs) && !isNaN(watermarkMs) && incomingMs <= watermarkMs) {
    return { action: 'process_backdated', comparedWatermarkUTC: String(watermarkDateTimeUTC) };
  }

  // 6: all guards passed.
  return PROCESS;
}

/**
 * Verdict for a watchdog-detected packet that must leave packets/incoming
 * without having been processed: stranded (no function consumed it),
 * duplicate-grouped, or an edit/delete type the watchdog must not
 * re-trigger. GS3 7/22/2026: the watchdog's `remove()` here destroyed a
 * driver edit; everything now goes through the same lossless quarantine.
 */
export function strandedPacketVerdict(args: {
  /** Packet age when the watchdog examined it; null when unknown. */
  ageMs: number | null;
  /** Which watchdog rule fired (duplicate group, stranded edit/delete, …). */
  context: string;
}): GuardVerdict {
  const ageText =
    args.ageMs === null ? 'unknown age' : `${Math.round(args.ageMs / 60000)} min old`;
  return {
    action: 'quarantine',
    reason: 'STRANDED_INCOMING_PACKET',
    readableReason: `Watchdog: ${args.context} (${ageText}). Held in packets/rejected for review.`,
    comparedWatermarkUTC: null,
  };
}

// ── Exact-ID idempotency (same-ID retry support) ─────────────────────────
// WB-M retries/recovers with STABLE packet ids. A replay of an id that is
// already in packets/processed is NOT stale data — it is an idempotent
// retry of a successful operation (e.g. the client lost the response).
// Equivalence is decided on the MATERIAL fields only; retry bookkeeping
// (_retriggeredBy, predictedLevelInches, timestamps of the attempt, …)
// never makes two copies of the same pull "different".

/** Top level in whole inches, from either representation. */
function topInchesOf(p: Record<string, unknown>): number | null {
  const ti = Number(p.tankTopInches);
  if (Number.isFinite(ti)) return Math.round(ti);
  const feet = Number(p.tankLevelFeet);
  if (Number.isFinite(feet)) return Math.round(feet * 12);
  return null;
}

const norm = (v: unknown): unknown => (v === undefined || v === null ? null : v);

export interface EquivalenceVerdict {
  equivalent: boolean;
  /** Human-readable field-level comparison context for collisions. */
  differences: string[];
}

/**
 * Material-field equivalence between an incoming packet and the processed
 * record under the same id: well, driver, dateTimeUTC, top level, BBLs,
 * and request type. Anything else is bookkeeping and ignored.
 */
export function comparePullEquivalence(
  incoming: Record<string, unknown>,
  processed: Record<string, unknown>,
): EquivalenceVerdict {
  const differences: string[] = [];
  const check = (label: string, a: unknown, b: unknown) => {
    if (a !== b) differences.push(`${label}: incoming=${JSON.stringify(a)} processed=${JSON.stringify(b)}`);
  };
  check('wellName', norm(incoming.wellName), norm(processed.wellName));
  check('driverId', norm(incoming.driverId), norm(processed.driverId));
  check('dateTimeUTC', norm(incoming.dateTimeUTC), norm(processed.dateTimeUTC));
  check('topLevelInches', topInchesOf(incoming), topInchesOf(processed));
  check('bblsTaken', Number(incoming.bblsTaken), Number(processed.bblsTaken));
  check('requestType', (incoming.requestType as string) || 'pull', (processed.requestType as string) || 'pull');
  return { equivalent: differences.length === 0, differences };
}

/** Verdict for a same-ID payload that is MATERIALLY different from the
 *  processed record — a genuine identity collision. The incoming payload
 *  is preserved in the quarantine record; processed data is never
 *  overwritten. */
export function packetIdCollisionVerdict(differences: string[]): GuardVerdict {
  return {
    action: 'quarantine',
    reason: 'PACKET_ID_COLLISION',
    readableReason:
      `A packet with this id already exists in packets/processed but the incoming payload ` +
      `materially conflicts with it — held for review, processed data untouched. ` +
      `Differences: ${differences.join('; ')}`,
    comparedWatermarkUTC: null,
  };
}

/**
 * Can the server PROVE this exact edit was already applied? True only when
 * the processed original carries an edit marker (editedAt) AND its values
 * already equal every value this edit requests. Returns null when the
 * schema cannot prove it either way (caller proceeds normally).
 */
export function editAlreadyApplied(
  edit: Record<string, unknown>,
  processedOriginal: Record<string, unknown>,
): boolean | null {
  if (!processedOriginal.editedAt && !processedOriginal.wasEdited) return false;
  const editTop = topInchesOf(edit);
  const origTop = topInchesOf(processedOriginal);
  const editBbls = Number(edit.bblsTaken);
  const origBbls = Number(processedOriginal.bblsTaken);
  if (editTop === null || origTop === null || !Number.isFinite(editBbls) || !Number.isFinite(origBbls)) {
    return null; // cannot prove — schema lacks comparable values
  }
  if (editTop !== origTop || editBbls !== origBbls) return false;
  if (typeof edit.wellDown === 'boolean' && processedOriginal.wellDown !== undefined && edit.wellDown !== Boolean(processedOriginal.wellDown)) {
    return false;
  }
  const editUtc = typeof edit.dateTimeUTC === 'string' && edit.dateTimeUTC ? edit.dateTimeUTC : null;
  if (editUtc && norm(processedOriginal.dateTimeUTC) !== editUtc) return false;
  return true;
}

/** Remove ONLY the duplicate incoming copy — one atomic single-path
 *  update, no fallback: a failed removal leaves incoming intact (the
 *  watchdog re-triggers and the idempotency check catches it again). */
export async function removeIncomingPacket(rootRef: RootRefLike, packetId: string): Promise<boolean> {
  try {
    await rootRef.update({ [`packets/incoming/${packetId}`]: null });
    return true;
  } catch (err) {
    console.error(`[IDEMPOTENT_REPLAY] incoming cleanup FAILED for ${packetId} — left intact for retry`, err);
    return false;
  }
}

// ─── 7/25 — exact invoice-identity edit resolution ──────────────────────────
//
// Field failure (ticket 19852): the client's Depart minted twin packet ids;
// the processed pull was `…_7guae0` while the invoice persisted the
// stale-rejected `…_q1jwti`. The close EDIT (140→165) targeted the phantom
// and was quarantined ORIGINAL_PACKET_NOT_FOUND even though BOTH records
// carry the same immutable invoiceDocId. Resolution order:
//   1. originalPacketId in processed/ → exact (unchanged behavior).
//   2. Missing + valid invoiceDocId → bounded indexed lookup by EXACT
//      invoiceDocId. Exactly one candidate → use it (its id stays
//      canonical; the phantom is never stamped anywhere). Zero → the
//      existing orphan quarantine. Multiple → AMBIGUOUS_EDIT_TARGET
//      quarantine — never guess.
// Never resolved by timestamp, well name, driver, quantity, nearest-time,
// or first-result.

/** Injectable read surface for edit-target resolution (jest-testable). */
export interface EditResolutionDb {
  /** processed/{packetId} value or null. */
  readProcessed(packetId: string): Promise<Record<string, unknown> | null>;
  /** Bounded indexed query: processed records whose invoiceDocId equals the
      given value exactly (requires the packets/processed invoiceDocId
      .indexOn — see database.rules.json). */
  queryProcessedByInvoiceDocId(
    invoiceDocId: string,
  ): Promise<Array<{ key: string; val: Record<string, unknown> }>>;
}

export type EditTargetResolution =
  | { kind: 'exact'; packetId: string; packet: Record<string, unknown> }
  | { kind: 'fallback'; packetId: string; packet: Record<string, unknown> }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; candidateIds: string[] };

export async function resolveEditTarget(
  dbi: EditResolutionDb,
  originalPacketId: string,
  invoiceDocId: unknown,
): Promise<EditTargetResolution> {
  const exact = await dbi.readProcessed(originalPacketId);
  if (exact) return { kind: 'exact', packetId: originalPacketId, packet: exact };

  const inv = typeof invoiceDocId === 'string' ? invoiceDocId.trim() : '';
  if (!inv) return { kind: 'not_found' };

  const rows = await dbi.queryProcessedByInvoiceDocId(inv);
  // Defensive: processed/ holds pulls; never let a non-pull artifact match.
  const candidates = rows.filter(
    (r) => ((r.val as { requestType?: unknown }).requestType ?? 'pull') === 'pull',
  );
  if (candidates.length === 0) return { kind: 'not_found' };
  if (candidates.length > 1) {
    return { kind: 'ambiguous', candidateIds: candidates.map((c) => c.key).sort() };
  }
  return { kind: 'fallback', packetId: candidates[0].key, packet: candidates[0].val };
}

// ─── 7/25 — normalized revision comparison + ordering safety ────────────────
//
// WB-T now synchronizes unconditionally (Depart / Close / Split / History
// save all send the complete canonical pull state). Identical revisions must
// acknowledge successfully WITHOUT rewriting the pull or recomputing
// tank-after / flow / AFR, and an older revision arriving late must never
// revert newer business state.
//
// MATERIAL fields (business truth):
//   - top level     — tankTopInches (inches) or tankLevelFeet×12, rounded to
//                     whole inches (formatting-only differences equal out)
//   - bblsTaken     — Number()-normalized ('165' == 165)
//   - wellName      — trimmed exact identity (well/tank identity)
//   - dateTimeUTC   — the operational gauge instant; an edit carrying a
//                     DIFFERENT instant is a deliberate date correction.
//                     WB-T milestones carry the ORIGINAL instant → equal.
//   - wellDown      — only when the edit explicitly asserts it
// EXCLUDED (transport/audit — can never create a false material change):
//   processedAt, editedAt/editedBy, receivedAt/server times, retry counts,
//   queuedOffline, jobOrigin, splitRevisionNonce, revisionAt, source,
//   canonical link context (invoiceDocId/dispatchId/companyId), and every
//   derived analytic (tankAfter*, flowRate*, recovery*, timeDif*).

export interface EditMaterialVerdict {
  changed: boolean;
  /** Material fields that differ (diagnostic). */
  fields: string[];
}

const numOf = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const strOf = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/**
 * Normalized material comparison between an incoming edit and the stored
 * processed pull. Fields the edit does not carry are "no assertion" and
 * never count as changes (partial edits stay supported).
 */
export function editMaterialChange(
  edit: Record<string, unknown>,
  processed: Record<string, unknown>,
): EditMaterialVerdict {
  const fields: string[] = [];

  const editTop = topInchesOf(edit);
  if (editTop !== null && editTop !== topInchesOf(processed)) fields.push('topInches');

  const editBbls = numOf(edit.bblsTaken);
  if (editBbls !== null && editBbls !== numOf(processed.bblsTaken)) fields.push('bblsTaken');

  const editWell = strOf(edit.wellName);
  if (editWell !== null && editWell !== strOf(processed.wellName)) fields.push('wellName');

  const editUtc = strOf(edit.dateTimeUTC);
  if (editUtc !== null && editUtc !== strOf(processed.dateTimeUTC)) fields.push('dateTimeUTC');

  if (edit.wellDown !== undefined) {
    const assertDown = edit.wellDown === true || edit.wellDown === 'true';
    if (assertDown !== Boolean(processed.wellDown)) fields.push('wellDown');
  }

  return { changed: fields.length > 0, fields };
}

/**
 * Optional revision ordering: when the incoming edit carries `revisionAt`
 * (ISO) AND the processed pull already recorded a newer `lastRevisionAt`,
 * the incoming edit is a stale straggler — acknowledge and drop, never
 * revert. Clients without revisionAt (all current callers) return false and
 * keep today's last-write-wins protocol — fully backward compatible.
 */
export function isStaleRevision(
  edit: Record<string, unknown>,
  processed: Record<string, unknown>,
): boolean {
  const incoming = strOf(edit.revisionAt);
  const applied = strOf(processed.lastRevisionAt);
  if (!incoming || !applied) return false;
  const a = Date.parse(incoming);
  const b = Date.parse(applied);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a < b;
}

/** Verdict for an edit whose invoiceDocId fallback matched MULTIPLE processed
 *  pulls — quarantine explicitly; guessing could edit another job's pull. */
export function ambiguousEditVerdict(
  originalPacketId: unknown,
  invoiceDocId: unknown,
  candidateIds: string[],
): GuardVerdict {
  return {
    action: 'quarantine',
    reason: 'AMBIGUOUS_EDIT_TARGET',
    readableReason:
      `Edit targets missing packet ${String(originalPacketId)}; invoiceDocId ` +
      `${String(invoiceDocId)} matches ${candidateIds.length} processed pulls ` +
      `(${candidateIds.join(', ')}) — refusing to guess. Held in packets/rejected ` +
      `for manual resolution.`,
    comparedWatermarkUTC: null,
  };
}

/** Verdict for an edit whose original packet cannot be found in processed/. */
export function orphanEditVerdict(originalPacketId: unknown): GuardVerdict {
  return {
    action: 'quarantine',
    reason: 'ORIGINAL_PACKET_NOT_FOUND',
    readableReason: originalPacketId
      ? `Edit targets original packet ${String(originalPacketId)}, which does not exist ` +
        `in packets/processed — the original may itself have been rejected or never uploaded.`
      : 'Edit packet carries no originalPacketId/packetId to identify the pull it edits.',
    comparedWatermarkUTC: null,
  };
}

/** The exact shape written to packets/rejected/<packetId>. */
export interface RejectedPacketRecord {
  packetId: string;
  /** Complete, unmodified original payload. */
  packet: unknown;
  reason: RejectionReason;
  readableReason: string;
  rejectedAt: string;
  incomingDateTimeUTC: string | null;
  comparedWatermarkUTC: string | null;
  serverNowUTC: string;
  wellName: string | null;
  requestType: string | null;
}

/**
 * One atomic RTDB multi-location update: create the rejection record AND
 * remove the incoming packet together. Applied via rootRef.update(), both
 * writes commit or neither does — a failed quarantine can never lose the
 * incoming packet. The update touches ONLY these two paths; rejected
 * packets must never advance processed/outgoing/performance/production/
 * wellStatus/enrichment state.
 */
export function buildQuarantineUpdate(args: {
  packetId: string;
  packet: unknown;
  verdict: GuardVerdict;
  nowMs: number;
}): Record<string, unknown> {
  const { packetId, packet, verdict, nowMs } = args;
  const p = (packet ?? {}) as Record<string, unknown>;
  const nowIso = new Date(nowMs).toISOString();
  const record: RejectedPacketRecord = {
    packetId,
    packet,
    reason: verdict.reason as RejectionReason,
    readableReason: verdict.readableReason ?? '',
    rejectedAt: nowIso,
    incomingDateTimeUTC: typeof p.dateTimeUTC === 'string' ? p.dateTimeUTC : null,
    comparedWatermarkUTC: verdict.comparedWatermarkUTC ?? null,
    serverNowUTC: nowIso,
    wellName: typeof p.wellName === 'string' ? p.wellName : null,
    requestType: typeof p.requestType === 'string' ? p.requestType : null,
  };
  return {
    [`packets/rejected/${packetId}`]: record,
    [`packets/incoming/${packetId}`]: null,
  };
}

/** Minimal root-ref surface, injectable for tests. */
export interface RootRefLike {
  update(values: Record<string, unknown>): Promise<unknown>;
}

/**
 * Execute the quarantine. Returns true when the atomic update committed.
 * On failure it logs and returns false WITHOUT any fallback deletion —
 * the incoming packet remains intact for retry.
 */
export async function quarantineIncomingPacket(
  rootRef: RootRefLike,
  args: { packetId: string; packet: unknown; verdict: GuardVerdict; nowMs: number },
): Promise<boolean> {
  const update = buildQuarantineUpdate(args);
  try {
    await rootRef.update(update);
    console.log(
      `[QUARANTINE] ${args.verdict.reason}: ${args.packetId} → packets/rejected/${args.packetId}`,
    );
    return true;
  } catch (err) {
    console.error(
      `[QUARANTINE] write FAILED for ${args.packetId} — packets/incoming left intact for retry`,
      err,
    );
    return false;
  }
}
