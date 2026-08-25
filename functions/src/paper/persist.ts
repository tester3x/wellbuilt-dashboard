import { contentHashForHtml } from './hash';
import { paperStorageHtmlPath, waterTicketArtifactId, type PaperArtifactRecord, type PaperRevisionRecord, type WaterTicketProjection } from './types';

export function nextRevisionId(existing: PaperRevisionRecord[]): string {
  let max = 0;
  for (const r of existing) {
    const m = /^r(\d+)$/.exec(r.revisionId);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `r${max + 1}`;
}

export function findRevisionBySourceEvent(
  existing: PaperRevisionRecord[],
  sourceEventId: string,
): PaperRevisionRecord | null {
  return existing.find((r) => r.sourceEventId === sourceEventId) || null;
}

export function planPaperPersist(input: {
  projection: WaterTicketProjection;
  html: string;
  sourceEventId: string;
  actorUid: string;
  actorDriverId: string | null;
  existingArtifact: PaperArtifactRecord | null;
  existingRevisions: PaperRevisionRecord[];
  createdAtMs: number;
}):
  | { ok: true; action: 'idempotent'; revision: PaperRevisionRecord; artifact: PaperArtifactRecord }
  | {
      ok: true;
      action: 'created';
      revision: PaperRevisionRecord;
      artifact: PaperArtifactRecord;
      html: string;
      previousCurrentRevisionId: string | null;
    }
  | { ok: false; reason: string; message: string } {
  const sourceEventId = input.sourceEventId.trim();
  if (!sourceEventId) {
    return { ok: false, reason: 'source_event_required', message: 'sourceEventId is required.' };
  }
  const p = input.projection;
  const artifactId = waterTicketArtifactId(p.ticketDocId);
  const hash = contentHashForHtml(input.html);
  const duplicate = findRevisionBySourceEvent(input.existingRevisions, sourceEventId);
  if (duplicate) {
    const artifact = input.existingArtifact || {
      artifactId,
      artifactType: 'water_ticket' as const,
      currentRevisionId: duplicate.revisionId,
      displayNumber: p.ticketNumber,
      companyId: p.companyId,
      ticketDocId: p.ticketDocId,
      invoiceDocId: '',
      createdAtMs: duplicate.createdAtMs,
      updatedAtMs: duplicate.createdAtMs,
    };
    return { ok: true, action: 'idempotent', revision: duplicate, artifact };
  }

  const revisionId = nextRevisionId(input.existingRevisions);
  const storageHtmlPath = paperStorageHtmlPath(p.companyId, artifactId, revisionId);
  const revision: PaperRevisionRecord = {
    artifactId,
    artifactType: 'water_ticket',
    revisionId,
    displayNumber: p.ticketNumber,
    companyId: p.companyId,
    contentHash: hash,
    storageHtmlPath,
    storagePdfPath: null,
    sourceEventId,
    createdAtMs: input.createdAtMs,
    actorUid: input.actorUid,
    actorDriverId: input.actorDriverId,
    humanAuditLabel: p.auditSubmittedBy,
    projection: p,
  };
  const artifact: PaperArtifactRecord = {
    artifactId,
    artifactType: 'water_ticket',
    currentRevisionId: revisionId,
    displayNumber: p.ticketNumber,
    companyId: p.companyId,
    ticketDocId: p.ticketDocId,
    invoiceDocId: input.existingArtifact?.invoiceDocId || '',
    createdAtMs: input.existingArtifact?.createdAtMs || input.createdAtMs,
    updatedAtMs: input.createdAtMs,
  };
  return {
    ok: true,
    action: 'created',
    revision,
    artifact,
    html: input.html,
    previousCurrentRevisionId: input.existingArtifact?.currentRevisionId || null,
  };
}

/** Apply a persist plan against an injectable store. Pointer writes last. */
export async function commitPaperPersist<TStore extends {
  writeHtml(path: string, html: string): Promise<void>;
  writeRevision(revision: PaperRevisionRecord): Promise<void>;
  writeArtifact(artifact: PaperArtifactRecord): Promise<void>;
}>(
  plan: Exclude<ReturnType<typeof planPaperPersist>, { ok: false }>,
  store: TStore,
): Promise<{ artifact: PaperArtifactRecord; revision: PaperRevisionRecord }> {
  if (plan.action === 'idempotent') {
    return { artifact: plan.artifact, revision: plan.revision };
  }
  await store.writeHtml(plan.revision.storageHtmlPath, plan.html);
  await store.writeRevision(plan.revision);
  await store.writeArtifact(plan.artifact);
  return { artifact: plan.artifact, revision: plan.revision };
}
