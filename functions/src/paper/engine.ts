import { authorizePaperMaterialize, authorizePaperRead } from './access';
import { asTrimmedString, DEFAULT_PAPER_TIMEZONE } from './format';
import { hashExactBytes, utf8Bytes } from './hash';
import { buildWaterTicketHtml, normalizePaperHtml } from './html';
import { canonicalDriverIdFromRecords } from './identity';
import { snapshotPhotoBytes, splitLivePhotos } from './photos';
import { buildArtifactSeed, buildRevisionRecord, paperAssetPath } from './persist';
import { projectWaterTicket } from './projection';
import { deriveGovernedSourceEvent } from './sourceEvent';
import type { PaperStore } from './store';
import {
  waterTicketArtifactId,
  type GetPaperDecision,
  type MaterializeDecision,
  type PaperCaller,
  type PaperLookup,
  type PaperOp,
  type PaperPhoto,
} from './types';

async function snapshotAssets(
  store: PaperStore,
  invoicePhotos: unknown,
): Promise<{ photos: PaperPhoto[]; jsaContentHash: string; jsaBytes: Buffer | null }> {
  const live = splitLivePhotos(invoicePhotos);
  const photos: PaperPhoto[] = [];
  for (const ref of live.photos) {
    const bytes = await store.readLiveAsset(ref.uri);
    if (!bytes) continue;
    photos.push(snapshotPhotoBytes(bytes, ref));
  }
  let jsaContentHash = '';
  let jsaBytes: Buffer | null = null;
  if (live.jsaUri) {
    jsaBytes = await store.readLiveAsset(live.jsaUri);
    if (jsaBytes) jsaContentHash = hashExactBytes(jsaBytes);
  }
  return { photos, jsaContentHash, jsaBytes };
}

export async function materializeWaterTicketPaper(input: {
  store: PaperStore;
  caller: PaperCaller;
  ticketDocId: string;
  op: PaperOp;
  nowMs: number;
}): Promise<MaterializeDecision> {
  const ticket = await input.store.getTicket(input.ticketDocId);
  if (!ticket) return { ok: false, reason: 'ticket_not_found', message: 'Ticket not found.' };
  const companyId = asTrimmedString(ticket.companyId);
  const access = authorizePaperMaterialize(input.caller, companyId);
  if (!access.ok) return access;
  const invoiceId = asTrimmedString(ticket.invoiceDocId);
  const invoice = invoiceId ? await input.store.getInvoice(invoiceId) : null;
  const derived = deriveGovernedSourceEvent({ ticket, invoice, op: input.op });
  if (!derived.ok) return derived;

  const ownerDriverId = canonicalDriverIdFromRecords({
    ownerDriverId: ticket.ownerDriverId,
    driverId: ticket.driverId,
    submittedBy: ticket.submittedBy,
    invoiceOwnerDriverId: invoice?.ownerDriverId,
    invoiceDriverId: invoice?.driverId,
  });
  const identity = ownerDriverId ? await input.store.getIdentityByDriverId(ownerDriverId) : null;
  const timeZone = (await input.store.getCompanyTimeZone(companyId)) || DEFAULT_PAPER_TIMEZONE;
  const snapped = await snapshotAssets(input.store, invoice?.photos);
  const projected = projectWaterTicket({
    ticket,
    invoice,
    legalName: identity?.legalName,
    displayName: identity?.displayName,
    photos: snapped.photos,
    jsaContentHash: snapped.jsaContentHash,
    paperTimeZone: timeZone,
  });
  if ('reason' in projected) return projected;

  const htmlText = normalizePaperHtml(buildWaterTicketHtml(projected));
  const htmlBytes = utf8Bytes(htmlText);
  const contentHash = hashExactBytes(htmlBytes);
  const seed = buildArtifactSeed(projected, input.nowMs);

  const reserved = await input.store.reserveSourceEvent({
    sourceEventId: derived.sourceEventId,
    artifactSeed: seed,
  });
  if (reserved.action === 'idempotent') {
    const revision = await input.store.getRevision(reserved.event.artifactId, reserved.event.revisionId);
    if (!revision) return { ok: false, reason: 'document_unavailable', message: 'Document unavailable.' };
    return { ok: true, action: 'idempotent', revision, artifact: reserved.artifact };
  }

  const revision = buildRevisionRecord({
    projection: projected,
    revisionId: reserved.event.revisionId,
    sourceEventId: derived.sourceEventId,
    contentHash,
    actorUid: input.caller.uid,
    actorDriverId: input.caller.kind === 'driver' ? input.caller.driverId || null : ownerDriverId || null,
    createdAtMs: input.nowMs,
  });

  try {
    await input.store.createHtmlBytes(revision.storageHtmlPath, htmlBytes);
    for (const photo of projected.photos) {
      const raw = photo.dataUri.split(',')[1] || '';
      const bytes = Buffer.from(raw, 'base64');
      await input.store.createAssetBytes(
        paperAssetPath(revision.companyId, revision.artifactId, revision.revisionId, photo.contentHash),
        bytes,
      );
    }
    if (snapped.jsaBytes && snapped.jsaContentHash) {
      await input.store.createAssetBytes(
        paperAssetPath(revision.companyId, revision.artifactId, revision.revisionId, snapped.jsaContentHash),
        snapped.jsaBytes,
      );
    }
    const finalized = await input.store.finalizeRevision({
      sourceEventId: derived.sourceEventId,
      revision,
      invoiceIndex: projected.invoiceDocId
        ? {
          invoiceDocId: projected.invoiceDocId,
          artifactId: revision.artifactId,
          ticketDocId: projected.ticketDocId,
          companyId: projected.companyId,
        }
        : null,
      nowMs: input.nowMs,
    });
    return {
      ok: true,
      action: finalized.action === 'idempotent' ? 'idempotent' : 'created',
      revision: finalized.revision,
      artifact: finalized.artifact,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'persist_failed',
      message: err instanceof Error ? err.message : 'persist_failed',
    };
  }
}

export async function getWaterTicketPaper(input: {
  store: PaperStore;
  caller: PaperCaller;
  lookup: PaperLookup;
  revisionId?: string;
}): Promise<GetPaperDecision> {
  let artifactId = '';
  if ('ticketDocId' in input.lookup && input.lookup.ticketDocId) {
    artifactId = waterTicketArtifactId(input.lookup.ticketDocId);
  } else if ('invoiceDocId' in input.lookup && input.lookup.invoiceDocId) {
    const idx = await input.store.getInvoiceIndex(input.lookup.invoiceDocId);
    if (!idx) return { ok: false, reason: 'document_unavailable', message: 'Document unavailable.' };
    artifactId = idx.artifactId;
  } else {
    return { ok: false, reason: 'lookup_required', message: 'Document unavailable.' };
  }

  const artifact = await input.store.getArtifact(artifactId);
  if (!artifact) return { ok: false, reason: 'document_unavailable', message: 'Document unavailable.' };
  const access = authorizePaperRead(input.caller, artifact);
  if (!access.ok) return { ok: false, reason: access.reason, message: access.message };
  const revisionId = input.revisionId || artifact.currentRevisionId;
  if (!revisionId) return { ok: false, reason: 'document_unavailable', message: 'Document unavailable.' };
  const revision = await input.store.getRevision(artifactId, revisionId);
  if (!revision) return { ok: false, reason: 'document_unavailable', message: 'Document unavailable.' };
  const bytes = await input.store.readHtmlBytes(revision.storageHtmlPath);
  if (!bytes) return { ok: false, reason: 'document_unavailable', message: 'Document unavailable.' };
  const hash = hashExactBytes(bytes);
  if (hash !== revision.contentHash) {
    return { ok: false, reason: 'document_unavailable', message: 'Document unavailable.' };
  }
  return {
    ok: true,
    artifactId,
    artifactType: 'water_ticket',
    revisionId: revision.revisionId,
    displayNumber: revision.displayNumber,
    companyId: revision.companyId,
    contentHash: hash,
    html: bytes.toString('utf8'),
  };
}
