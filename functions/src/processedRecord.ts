// processedRecord.ts — the EXACT construct-and-strip step of processIncomingPull,
// extracted verbatim (behavior-preserving) so it is unit-testable without an
// emulator. index.ts calls buildProcessedRecord for the stored pull; nothing
// about its behavior changes.
//
// Why this matters: the processed record is `{ ...incoming, ...computed }` minus
// three client trail-only helper keys. That spread is what preserves PASSTHROUGH
// fields — notably recoveredFromPacketId (Mechanism A recovery provenance) — onto
// packets/processed. Testing this real function proves the production processor
// does not strip or rename provenance.

/** Fields the processor computes and overlays onto the incoming pull. */
export interface ProcessedComputedFields {
  packetId: string;
  tankTopInches: number;
  tankAfterInches: number;
  tankAfterFeet: string;
  timeDif: string;
  timeDifDays: number;
  recoveryInches: number;
  flowRate: string;
  flowRateDays: number;
  recoveryNeeded: number;
  estTimeToPull: string;
  estDateTimePull: string;
  processedAt: string;
}

/** Client-only trail helpers that must NOT be persisted on the processed pull. */
const TRAIL_ONLY_KEYS = ['pendingEditEvents', 'originalSubmittedValues', 'hasQueuedCorrection'] as const;

/**
 * Build the packets/processed record: spread the incoming data (passthrough
 * fields — driverId, timezone, recoveredFromPacketId, … — survive), overlay the
 * computed fields, strip the client trail-only helpers, and retain
 * originalSubmittedAt when a queued correction froze it. Identical to the inline
 * logic previously in processIncomingPull.
 */
export function buildProcessedRecord(
  data: Record<string, unknown>,
  computed: ProcessedComputedFields,
): Record<string, unknown> {
  const processedPacket: Record<string, unknown> = { ...data, ...(computed as unknown as Record<string, unknown>) };
  for (const k of TRAIL_ONLY_KEYS) delete processedPacket[k];
  if (typeof data.originalSubmittedAt !== 'undefined' && data.originalSubmittedAt !== null) {
    processedPacket.originalSubmittedAt = data.originalSubmittedAt;
  }
  return processedPacket;
}
