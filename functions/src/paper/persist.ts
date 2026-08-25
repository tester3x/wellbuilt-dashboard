import { sha256Utf8 } from './hash';
import { paperAssetPath, paperStorageHtmlPath, waterTicketArtifactId, type PaperArtifactRecord, type PaperRevisionRecord } from './types';

export function eventDocId(sourceEventId: string): string {
  return sha256Utf8(sourceEventId);
}

export function buildRevisionRecord(input: {
  projection: PaperRevisionRecord['projection'];
  revisionId: string;
  sourceEventId: string;
  eventMs: number;
  contentHash: string;
  actorUid: string;
  actorDriverId: string | null;
  createdAtMs: number;
}): PaperRevisionRecord {
  const p = input.projection;
  const artifactId = waterTicketArtifactId(p.ticketDocId);
  return {
    artifactId,
    artifactType: 'water_ticket',
    revisionId: input.revisionId,
    displayNumber: p.ticketNumber,
    companyId: p.companyId,
    ticketDocId: p.ticketDocId,
    invoiceDocId: p.invoiceDocId,
    ownerDriverId: p.ownerDriverId,
    contentHash: input.contentHash,
    storageHtmlPath: paperStorageHtmlPath(p.companyId, artifactId, input.revisionId),
    storagePdfPath: null,
    sourceEventId: input.sourceEventId,
    eventMs: input.eventMs,
    createdAtMs: input.createdAtMs,
    actorUid: input.actorUid,
    actorDriverId: input.actorDriverId,
    humanAuditLabel: p.auditSubmittedBy,
    projection: p,
  };
}

export function buildArtifactSeed(p: PaperRevisionRecord['projection'], createdAtMs: number): PaperArtifactRecord {
  return {
    artifactId: waterTicketArtifactId(p.ticketDocId),
    artifactType: 'water_ticket',
    currentRevisionId: '',
    nextRevisionSeq: 0,
    displayNumber: p.ticketNumber,
    companyId: p.companyId,
    ticketDocId: p.ticketDocId,
    invoiceDocId: p.invoiceDocId,
    ownerDriverId: p.ownerDriverId,
    paperTimeZone: p.paperTimeZone,
    currentEventMs: 0,
    currentSourceEventId: '',
    createdAtMs,
    updatedAtMs: createdAtMs,
  };
}

export { paperAssetPath, paperStorageHtmlPath };
