import { authorizePaperCompany } from './access';
import { contentHashForHtml } from './hash';
import { buildWaterTicketHtml, normalizePaperHtml } from './html';
import { commitPaperPersist, planPaperPersist } from './persist';
import { projectWaterTicket } from './projection';
import type { PaperStore } from './store';
import { waterTicketArtifactId, type GetPaperDecision, type MaterializeDecision, type PaperCaller, type PaperLookup } from './types';

export async function resolveTicketForLookup(
  store: PaperStore,
  lookup: PaperLookup,
): Promise<
  | { ok: true; ticket: NonNullable<Awaited<ReturnType<PaperStore['getTicket']>>>; invoice: Awaited<ReturnType<PaperStore['getInvoice']>> }
  | { ok: false; reason: string; message: string }
> {
  if ('ticketDocId' in lookup && lookup.ticketDocId) {
    const ticket = await store.getTicket(lookup.ticketDocId);
    if (!ticket) return { ok: false, reason: 'ticket_not_found', message: 'Document unavailable.' };
    const invoiceId = typeof ticket.invoiceDocId === 'string' ? ticket.invoiceDocId : '';
    const invoice = invoiceId ? await store.getInvoice(invoiceId) : null;
    return { ok: true, ticket, invoice };
  }
  const invoiceDocId = 'invoiceDocId' in lookup ? lookup.invoiceDocId : '';
  if (!invoiceDocId) return { ok: false, reason: 'lookup_required', message: 'Document unavailable.' };
  const invoice = await store.getInvoice(invoiceDocId);
  if (!invoice) return { ok: false, reason: 'invoice_not_found', message: 'Document unavailable.' };
  const tickets = await store.findTicketsForInvoice(invoice);
  if (tickets.length !== 1) {
    return { ok: false, reason: 'not_ticket_only', message: 'Document unavailable.' };
  }
  return { ok: true, ticket: tickets[0], invoice };
}

export async function materializeWaterTicketPaper(input: {
  store: PaperStore;
  caller: PaperCaller;
  ticketDocId: string;
  sourceEventId: string;
  nowMs: number;
}): Promise<MaterializeDecision> {
  const ticket = await input.store.getTicket(input.ticketDocId);
  if (!ticket) return { ok: false, reason: 'ticket_not_found', message: 'Ticket not found.' };
  const companyId = typeof ticket.companyId === 'string' ? ticket.companyId : '';
  const access = authorizePaperCompany(input.caller, companyId);
  if (!access.ok) return access;
  const invoiceId = typeof ticket.invoiceDocId === 'string' ? ticket.invoiceDocId : '';
  const invoice = invoiceId ? await input.store.getInvoice(invoiceId) : null;
  const names = await input.store.resolveLegalName(
    String(ticket.driver || invoice?.driver || ''),
  );
  const projected = projectWaterTicket({
    ticket,
    invoice,
    legalName: names.legalName,
    displayName: names.displayName,
  });
  if ('reason' in projected) return projected;
  const html = normalizePaperHtml(buildWaterTicketHtml(projected));
  const artifactId = waterTicketArtifactId(ticket.id);
  const existingArtifact = await input.store.getArtifact(artifactId);
  const existingRevisions = await input.store.listRevisions(artifactId);
  const plan = planPaperPersist({
    projection: projected,
    html,
    sourceEventId: input.sourceEventId,
    actorUid: input.caller.uid,
    actorDriverId: null,
    existingArtifact,
    existingRevisions,
    createdAtMs: input.nowMs,
  });
  if (!plan.ok) return plan;
  if (plan.action === 'idempotent') {
    return { ok: true, action: 'idempotent', revision: plan.revision, artifact: plan.artifact };
  }
  try {
    const committed = await commitPaperPersist(plan, input.store);
    return { ok: true, action: 'created', revision: committed.revision, artifact: committed.artifact };
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
  const resolved = await resolveTicketForLookup(input.store, input.lookup);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason, message: 'Document unavailable.' };
  }
  const { ticket, invoice } = resolved;
  const companyId = typeof ticket.companyId === 'string'
    ? ticket.companyId
    : typeof invoice?.companyId === 'string' ? invoice.companyId : '';
  const access = authorizePaperCompany(input.caller, companyId);
  if (!access.ok) return { ok: false, reason: access.reason, message: access.message };
  const artifactId = waterTicketArtifactId(ticket.id);
  const artifact = await input.store.getArtifact(artifactId);
  if (!artifact) return { ok: false, reason: 'document_unavailable', message: 'Document unavailable.' };
  const revisionId = input.revisionId || artifact.currentRevisionId;
  const revision = await input.store.getRevision(artifactId, revisionId);
  if (!revision) return { ok: false, reason: 'document_unavailable', message: 'Document unavailable.' };
  const html = await input.store.readHtml(revision.storageHtmlPath);
  if (html == null) return { ok: false, reason: 'document_unavailable', message: 'Document unavailable.' };
  const hash = contentHashForHtml(html);
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
    html,
  };
}
