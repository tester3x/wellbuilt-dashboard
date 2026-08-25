import { authorizePaperMaterialize, authorizePaperRead } from './access';
import { asTrimmedString, DEFAULT_PAPER_TIMEZONE } from './format';
import { hashExactBytes, utf8Bytes } from './hash';
import { buildWaterTicketHtml, normalizePaperHtml } from './html';
import { canonicalDriverIdFromRecords } from './identity';
import { MAX_CANONICAL_HTML_BYTES, MAX_PAPER_PHOTOS, snapshotPhotoForPaper, thumbDataUri } from './media';
import { splitLivePhotos } from './photos';
import { buildRevisionRecord, paperAssetPath } from './persist';
import { isTicketOnlyWaterTicket, projectWaterTicket } from './projection';
import { deriveGovernedSourceEvent } from './sourceEvent';
import { buildPaperSourceSnapshot } from './sourceSnapshot';
import type { PaperStore } from './store';
import {
  waterTicketArtifactId,
  type GetPaperDecision,
  type InvoiceSourceRecord,
  type MaterializeDecision,
  type PaperCaller,
  type PaperEditSource,
  type PaperLookup,
  type PaperOp,
  type PaperPhotoMeta,
  type TicketSourceRecord,
} from './types';

async function snapshotAssets(
  store: PaperStore,
  invoicePhotos: unknown,
  ctx: { companyId: string; artifactId: string; revisionId: string; invoiceDocId: string; ticketDocId: string },
): Promise<
  | {
      ok: true;
      photos: PaperPhotoMeta[];
      thumbs: Record<string, string>;
      originals: Array<{ path: string; bytes: Buffer }>;
      jsaContentHash: string;
      jsaPath: string;
      jsaBytes: Buffer | null;
    }
  | { ok: false; reason: string; message: string }
> {
  const live = splitLivePhotos(invoicePhotos);
  const photos: PaperPhotoMeta[] = [];
  const thumbs: Record<string, string> = {};
  const originals: Array<{ path: string; bytes: Buffer }> = [];
  const owner = {
    companyId: ctx.companyId,
    invoiceDocId: ctx.invoiceDocId,
    ticketDocId: ctx.ticketDocId,
  };
  for (const ref of live.photos.slice(0, MAX_PAPER_PHOTOS)) {
    const got = await store.readLiveAsset(ref.uri, owner);
    if (!got.ok) {
      if (got.retry) {
        return { ok: false, reason: 'asset_unavailable', message: 'Referenced tenant asset is not yet readable.' };
      }
      continue;
    }
    const originalPath = paperAssetPath(ctx.companyId, ctx.artifactId, ctx.revisionId, 'pending-orig');
    const snapped = snapshotPhotoForPaper(got.bytes, ref, {
      originalPath,
      thumbPath: paperAssetPath(ctx.companyId, ctx.artifactId, ctx.revisionId, 'pending-thumb'),
    });
    const originalStorePath = paperAssetPath(ctx.companyId, ctx.artifactId, ctx.revisionId, snapped.meta.contentHash);
    const thumbStorePath = paperAssetPath(ctx.companyId, ctx.artifactId, ctx.revisionId, `t-${snapped.meta.thumbHash}`);
    snapped.meta.originalPath = originalStorePath;
    snapped.meta.thumbPath = thumbStorePath;
    photos.push(snapped.meta);
    thumbs[snapped.meta.thumbHash] = thumbDataUri(snapped.thumb, snapped.meta.thumbMimeType);
    originals.push({ path: originalStorePath, bytes: snapped.original });
    originals.push({ path: thumbStorePath, bytes: snapped.thumb });
  }
  let jsaContentHash = '';
  let jsaPath = '';
  let jsaBytes: Buffer | null = null;
  if (live.jsaUri) {
    const got = await store.readLiveAsset(live.jsaUri, owner);
    if (!got.ok) {
      if (got.retry) {
        return { ok: false, reason: 'asset_unavailable', message: 'Referenced tenant asset is not yet readable.' };
      }
    } else {
      jsaBytes = got.bytes;
      jsaContentHash = hashExactBytes(got.bytes);
      jsaPath = paperAssetPath(ctx.companyId, ctx.artifactId, ctx.revisionId, jsaContentHash);
    }
  }
  return { ok: true, photos, thumbs, originals, jsaContentHash, jsaPath, jsaBytes };
}

export async function materializeWaterTicketPaper(input: {
  store: PaperStore;
  caller: PaperCaller;
  ticketDocId: string;
  op: PaperOp;
  nowMs: number;
  editSource?: PaperEditSource;
  sourceTicket?: TicketSourceRecord;
  sourceInvoice?: InvoiceSourceRecord | null;
}): Promise<MaterializeDecision> {
  const ticket = input.sourceTicket || await input.store.getTicket(input.ticketDocId);
  if (!ticket) return { ok: false, reason: 'ticket_not_found', message: 'Ticket not found.' };
  const companyId = asTrimmedString(ticket.companyId);
  const access = authorizePaperMaterialize(input.caller, companyId);
  if (!access.ok) return access;
  const invoiceId = asTrimmedString(ticket.invoiceDocId) || asTrimmedString(input.sourceInvoice?.id);
  const invoice = input.sourceInvoice !== undefined
    ? input.sourceInvoice
    : (invoiceId ? await input.store.getInvoice(invoiceId) : null);
  if (!isTicketOnlyWaterTicket(ticket, invoice)) {
    return { ok: false, reason: 'not_ticket_only', message: 'This slice materializes ticket-only Water Tickets.' };
  }
  const derived = deriveGovernedSourceEvent({
    ticket,
    invoice,
    op: input.op,
    editSource: input.editSource,
  });
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
  const artifactId = waterTicketArtifactId(ticket.id);
  const sourceSnapshot = buildPaperSourceSnapshot({
    op: input.op,
    editSource: input.editSource,
    ticket,
    invoice,
    paperTimeZone: timeZone,
    legalName: identity?.legalName,
    displayName: identity?.displayName,
  });
  const reserved = await input.store.reserveSourceEvent({
    sourceEventId: derived.sourceEventId,
    eventMs: derived.eventMs,
    sourceSnapshot,
    artifactSeed: {
      artifactId,
      artifactType: 'water_ticket',
      displayNumber: asTrimmedString(ticket.ticketNumber),
      companyId,
      ticketDocId: ticket.id,
      invoiceDocId: invoiceId,
      ownerDriverId,
      paperTimeZone: timeZone,
      currentEventMs: 0,
      currentSourceEventId: '',
      createdAtMs: input.nowMs,
    },
  });
  if (reserved.action === 'idempotent') {
    const revision = await input.store.getRevision(reserved.event.artifactId, reserved.event.revisionId);
    if (!revision) return { ok: false, reason: 'document_unavailable', message: 'Document unavailable.' };
    return { ok: true, action: 'idempotent', revision, artifact: reserved.artifact };
  }

  const frozen = reserved.event.sourceSnapshot || sourceSnapshot;
  const snapped = await snapshotAssets(input.store, frozen.invoice?.photos, {
    companyId,
    artifactId,
    revisionId: reserved.event.revisionId,
    invoiceDocId: invoiceId,
    ticketDocId: ticket.id,
  });
  if (!snapped.ok) return snapped;
  const projected = projectWaterTicket({
    ticket: frozen.ticket,
    invoice: frozen.invoice,
    legalName: frozen.legalName,
    displayName: frozen.displayName,
    photos: snapped.photos,
    jsaContentHash: snapped.jsaContentHash,
    jsaPath: snapped.jsaPath,
    paperTimeZone: frozen.paperTimeZone,
  });
  if ('reason' in projected) return projected;

  const htmlText = normalizePaperHtml(buildWaterTicketHtml(projected, snapped.thumbs));
  const htmlBytes = utf8Bytes(htmlText);
  if (htmlBytes.length > MAX_CANONICAL_HTML_BYTES) {
    return { ok: false, reason: 'html_too_large', message: 'Canonical HTML exceeds 512KB.' };
  }
  const contentHash = hashExactBytes(htmlBytes);
  const revision = buildRevisionRecord({
    projection: projected,
    revisionId: reserved.event.revisionId,
    sourceEventId: derived.sourceEventId,
    eventMs: derived.eventMs,
    contentHash,
    actorUid: input.caller.uid,
    actorDriverId: input.caller.kind === 'driver' ? input.caller.driverId || null : ownerDriverId || null,
    createdAtMs: input.nowMs,
  });

  try {
    await input.store.createHtmlBytes(revision.storageHtmlPath, htmlBytes);
    for (const asset of snapped.originals) {
      await input.store.createAssetBytes(asset.path, asset.bytes);
    }
    if (snapped.jsaBytes && snapped.jsaPath) {
      await input.store.createAssetBytes(snapped.jsaPath, snapped.jsaBytes);
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
