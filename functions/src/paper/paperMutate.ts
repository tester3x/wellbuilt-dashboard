import { asTrimmedString } from './format';
import { assertActorMayMutateTicket } from './actorPolicy';
import { clearOverrideAfterMutation } from './workflow';
import type { PaperCaller } from './types';
import type { PaperStore } from './store';

const TICKET_PATCH_FIELDS = new Set([
  'date', 'operator', 'company', 'location', 'wellName', 'hauledTo', 'disposal',
  'truck', 'trailer', 'driver', 'qty', 'bbls', 'pickupBbls', 'dropoffBbls',
  'top', 'bottom', 'hours', 'notes',
]);
const INVOICE_PATCH_FIELDS = new Set(['totalBBL', 'totalHours', 'operator', 'wellName', 'hauledTo', 'truckNumber', 'trailer']);

export async function mutateTicketPaper(input: {
  store: PaperStore;
  caller: PaperCaller;
  ticketDocId: string;
  fields: Record<string, unknown>;
  nowMs: number;
}): Promise<
  | { ok: true; via: string; ticketDocId: string; invoiceDocId: string }
  | { ok: false; reason: string; message: string }
> {
  const keys = Object.keys(input.fields);
  if (!keys.length) return { ok: false, reason: 'invalid_request', message: 'No mutation fields.' };
  const ticket = await input.store.getTicket(input.ticketDocId);
  if (!ticket) return { ok: false, reason: 'ticket_not_found', message: 'Ticket not found.' };
  const invoiceId = asTrimmedString(ticket.invoiceDocId);
  const invoice = invoiceId ? await input.store.getInvoice(invoiceId) : null;
  const workflow = await input.store.getWorkflow(input.ticketDocId);
  const gate = assertActorMayMutateTicket({
    caller: input.caller,
    ticket,
    invoice,
    workflow,
    nowMs: input.nowMs,
    fields: keys,
  });
  if (!gate.ok) return gate;

  const ticketPatch: Record<string, unknown> = { updatedAt: input.nowMs, updatedAtMs: input.nowMs };
  const invoicePatch: Record<string, unknown> = { updatedAt: input.nowMs, editedAt: input.nowMs };
  let invoiceTouched = false;
  for (const key of keys) {
    const value = input.fields[key];
    if (TICKET_PATCH_FIELDS.has(key)) ticketPatch[key] = value;
    if (INVOICE_PATCH_FIELDS.has(key)) {
      invoicePatch[key === 'operator' ? 'operator' : key] = value;
      if (key === 'truck') invoicePatch.truckNumber = value;
      invoiceTouched = true;
    }
  }
  await input.store.patchTicket(input.ticketDocId, ticketPatch);
  if (invoiceTouched && invoiceId) {
    await input.store.patchInvoice(invoiceId, invoicePatch);
  }
  if (workflow?.overrideActive) {
    await input.store.putWorkflow(clearOverrideAfterMutation(workflow, input.nowMs));
  }
  return { ok: true, via: gate.via, ticketDocId: input.ticketDocId, invoiceDocId: invoiceId };
}
