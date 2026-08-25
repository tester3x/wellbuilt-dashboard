import { waterTicketArtifactId, type PaperCaller, type PaperLookup } from './types';
import { evaluatePaperPresentation, PAPER_ACTOR_POLICY_VERSION, type PaperPresentationDecision } from './actorPolicy';
import type { PaperStore } from './store';

export async function resolvePaperPresentation(input: {
  store: PaperStore;
  caller: PaperCaller;
  lookup: PaperLookup;
  nowMs: number;
}): Promise<PaperPresentationDecision> {
  let ticketDocId = '';
  if ('ticketDocId' in input.lookup && input.lookup.ticketDocId) {
    ticketDocId = input.lookup.ticketDocId;
  } else if ('invoiceDocId' in input.lookup && input.lookup.invoiceDocId) {
    const idx = await input.store.getInvoiceIndex(input.lookup.invoiceDocId);
    if (idx) ticketDocId = idx.ticketDocId;
    else {
      const tickets = await input.store.findTicketsByInvoiceDocId(input.lookup.invoiceDocId);
      ticketDocId = tickets[0]?.id || '';
    }
  }
  if (!ticketDocId) {
    return {
      ok: false,
      reason: 'ticket_not_found',
      message: 'Ticket not found.',
      canEdit: false,
      evaluatedAtMs: input.nowMs,
      policyVersion: PAPER_ACTOR_POLICY_VERSION,
    };
  }
  const ticket = await input.store.getTicket(ticketDocId);
  if (!ticket) {
    return {
      ok: false,
      reason: 'ticket_not_found',
      message: 'Ticket not found.',
      canEdit: false,
      evaluatedAtMs: input.nowMs,
      policyVersion: PAPER_ACTOR_POLICY_VERSION,
    };
  }
  const invoiceId = String(ticket.invoiceDocId || '').trim();
  const invoice = invoiceId ? await input.store.getInvoice(invoiceId) : null;
  const artifact = await input.store.getArtifact(waterTicketArtifactId(ticket.id));
  const workflow = await input.store.getWorkflow(ticket.id);
  return evaluatePaperPresentation({
    caller: input.caller,
    ticket,
    invoice,
    nowMs: input.nowMs,
    workflow,
    artifact: artifact
      ? { artifactId: artifact.artifactId, currentRevisionId: artifact.currentRevisionId }
      : null,
  });
}
