import { canonicalPayloadDigest } from './wbmPullAuthorize';

/** An edit is a revision of one pull, never a new pull. Legacy clients reuse
 * their edit key, so the server must distinguish immutable correction bodies. */
export function wbmEditRevisionKey(legacyKey: string, payload: Record<string, unknown>): string {
  const { idempotencyKey: _key, ...body } = payload;
  return `${legacyKey}_r_${canonicalPayloadDigest(body)}`;
}

/** Operator recovery receipts acknowledge only an exact stale request after
 * its explicitly reviewed replacement finished the existing edit outbox. */
export function verifiedEditRecovery(input: {
  receipt: any; original: any; outbox: any;
  driverId: string; companyId: string; originalPacketId: string; payloadDigest: string;
}): boolean {
  const { receipt: r, original: p, outbox: o } = input;
  return !!r && !!p && !!o && r.schemaVersion === 1
    && r.driverId === input.driverId && r.companyId === input.companyId
    && r.originalPacketId === input.originalPacketId && r.payloadDigest === input.payloadDigest
    && p.driverId === input.driverId && p.companyId === input.companyId
    && o.driverId === input.driverId && o.companyId === input.companyId
    && o.originalPacketId === input.originalPacketId && o.eventId === r.appliedEventId
    && o.completed === true && o.stage === 'done' && o.revision === r.appliedRevision
    && Number.isFinite(r.topInches) && Number.isFinite(r.bbls)
    && o.measurements?.tankTopInches === r.topInches && o.measurements?.bblsTaken === r.bbls
    && p.tankTopInches === r.topInches && p.bblsTaken === r.bbls
    && p.lastPullDeliveredEventId === r.appliedEventId
    && p.lastPullDeliveredRevision === r.appliedRevision;
}
