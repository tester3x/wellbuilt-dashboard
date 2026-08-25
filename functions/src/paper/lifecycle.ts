import { asTrimmedString, timestampMs } from './format';
import { SYSTEM_PAPER_CALLER } from './paperCaller';
import { materializeWaterTicketPaper } from './engine';
import { isTicketOnlyWaterTicket, paperSourceFingerprint } from './projection';
import { invoiceEditMs, ticketEditMs } from './sourceEvent';
import { seedDispatchReviewWorkflow } from './workflow';
import type { InvoiceSourceRecord, PaperEditSource, PaperOp, TicketSourceRecord } from './types';
import type { PaperStore } from './store';

export type PaperLifecycleClass =
  | 'ignored'
  | 'pending_reconciliation'
  | 'success'
  | 'retriable'
  | 'permanent';

export interface PaperLifecycleOutcome {
  class: PaperLifecycleClass;
  op: PaperOp | 'none';
  reason?: string;
  ticketDocId?: string;
  invoiceDocId?: string;
  companyId?: string;
  sourceEventId?: string;
  results: unknown[];
}

const RETRIABLE_REASONS = new Set([
  'persist_failed',
  'document_unavailable',
  'ticket_not_found',
  'invoice_not_found',
  'asset_unavailable',
]);

function fieldStr(rec: Record<string, unknown> | null | undefined, key: string): string {
  if (!rec) return '';
  const v = rec[key];
  if (v == null) return '';
  return String(v);
}

export function isClosedStatus(status: unknown): boolean {
  const s = asTrimmedString(status).toLowerCase();
  return s === 'closed' || s === 'complete' || s === 'completed';
}

export function isAuthoritativelyClosed(invoice: Record<string, unknown> | InvoiceSourceRecord | null | undefined): boolean {
  if (!invoice) return false;
  const rec = invoice as Record<string, unknown>;
  if (timestampMs(rec.closedAt) || timestampMs(rec.closedAtMs)) return true;
  return isClosedStatus(rec.status);
}

function asTicket(ticketId: string, rec: Record<string, unknown>): TicketSourceRecord {
  return { id: ticketId, ...rec } as TicketSourceRecord;
}

function asInvoice(invoiceId: string, rec: Record<string, unknown>): InvoiceSourceRecord {
  return { id: invoiceId, ...rec } as InvoiceSourceRecord;
}

export function classifyInvoicePaperChange(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): PaperOp | 'none' {
  if (!after) return 'none';
  const closedAfter = timestampMs(after.closedAt) || timestampMs(after.closedAtMs);
  const closedBefore = before ? (timestampMs(before.closedAt) || timestampMs(before.closedAtMs)) : null;
  if (closedAfter && !closedBefore) return 'close';
  if (isClosedStatus(after.status) && !isClosedStatus(before?.status)) return 'close';
  if (!isAuthoritativelyClosed(after)) return 'none';
  if (paperSourceFingerprint(null, before) === paperSourceFingerprint(null, after)) return 'none';
  const editAfter = invoiceEditMs(after);
  const editBefore = invoiceEditMs(before);
  if (!editAfter || (editBefore != null && editAfter <= editBefore)) return 'none';
  return 'edit';
}

export function classifyTicketPaperChange(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): PaperOp | 'none' | 'reconcile' {
  if (!after) return 'none';
  if (!before) return 'reconcile';
  const beforeInv = fieldStr(before, 'invoiceDocId');
  const afterInv = fieldStr(after, 'invoiceDocId');
  if (!beforeInv && afterInv) return 'reconcile';
  if (paperSourceFingerprint(before, null) === paperSourceFingerprint(after, null)) return 'none';
  const updatedAfter = ticketEditMs(after);
  const updatedBefore = ticketEditMs(before);
  if (!updatedAfter || (updatedBefore != null && updatedAfter <= updatedBefore)) return 'none';
  return 'edit';
}

function classifyMaterializeResult(input: {
  op: PaperOp;
  ticketDocId: string;
  invoiceDocId?: string;
  companyId?: string;
  result: { ok: true } | { ok: false; reason: string; message: string };
}): PaperLifecycleOutcome {
  if (input.result.ok) {
    return {
      class: 'success',
      op: input.op,
      ticketDocId: input.ticketDocId,
      invoiceDocId: input.invoiceDocId,
      companyId: input.companyId,
      results: [input.result],
    };
  }
  const reason = input.result.reason;
  if (reason === 'not_ticket_only') {
    return {
      class: 'ignored',
      op: input.op,
      reason,
      ticketDocId: input.ticketDocId,
      invoiceDocId: input.invoiceDocId,
      companyId: input.companyId,
      results: [input.result],
    };
  }
  const retriable = RETRIABLE_REASONS.has(reason);
  return {
    class: retriable ? 'retriable' : 'permanent',
    op: input.op,
    reason,
    ticketDocId: input.ticketDocId,
    invoiceDocId: input.invoiceDocId,
    companyId: input.companyId,
    results: [input.result],
  };
}

function foldOutcomes(op: PaperOp | 'none', items: PaperLifecycleOutcome[]): PaperLifecycleOutcome {
  if (items.length === 0) {
    return { class: 'ignored', op, results: [] };
  }
  const retriable = items.find((i) => i.class === 'retriable');
  if (retriable) {
    return {
      ...retriable,
      op,
      results: items.flatMap((i) => i.results),
    };
  }
  const permanent = items.find((i) => i.class === 'permanent');
  if (permanent) {
    return {
      ...permanent,
      op,
      results: items.flatMap((i) => i.results),
    };
  }
  const success = items.find((i) => i.class === 'success');
  if (success) {
    return {
      class: 'success',
      op,
      ticketDocId: success.ticketDocId,
      invoiceDocId: success.invoiceDocId,
      companyId: success.companyId,
      results: items.flatMap((i) => i.results),
    };
  }
  return {
    class: 'ignored',
    op,
    reason: items[0]?.reason,
    ticketDocId: items[0]?.ticketDocId,
    invoiceDocId: items[0]?.invoiceDocId,
    companyId: items[0]?.companyId,
    results: items.flatMap((i) => i.results),
  };
}

async function materializeOne(input: {
  store: PaperStore;
  ticketDocId: string;
  invoiceDocId?: string;
  companyId?: string;
  op: PaperOp;
  editSource?: PaperEditSource;
  nowMs: number;
  sourceTicket?: TicketSourceRecord;
  sourceInvoice?: InvoiceSourceRecord | null;
}): Promise<PaperLifecycleOutcome> {
  try {
    const result = await materializeWaterTicketPaper({
      store: input.store,
      caller: SYSTEM_PAPER_CALLER,
      ticketDocId: input.ticketDocId,
      op: input.op,
      nowMs: input.nowMs,
      editSource: input.editSource,
      sourceTicket: input.sourceTicket,
      sourceInvoice: input.sourceInvoice,
    });
    if (result.ok && input.op === 'close') {
      const existing = await input.store.getWorkflow(input.ticketDocId);
      if (!existing) {
        await input.store.putWorkflow(seedDispatchReviewWorkflow({
          ticketDocId: input.ticketDocId,
          invoiceDocId: input.invoiceDocId || '',
          companyId: input.companyId || '',
          invoice: input.sourceInvoice || null,
          nowMs: input.nowMs,
        }));
      }
    }
    return classifyMaterializeResult({
      op: input.op,
      ticketDocId: input.ticketDocId,
      invoiceDocId: input.invoiceDocId,
      companyId: input.companyId,
      result,
    });
  } catch {
    return {
      class: 'retriable',
      op: input.op,
      reason: 'persist_failed',
      ticketDocId: input.ticketDocId,
      invoiceDocId: input.invoiceDocId,
      companyId: input.companyId,
      results: [],
    };
  }
}

export async function applyInvoicePaperLifecycle(input: {
  store: PaperStore;
  invoiceId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  nowMs: number;
}): Promise<PaperLifecycleOutcome> {
  const op = classifyInvoicePaperChange(input.before, input.after);
  if (op === 'none' || !input.after) {
    return { class: 'ignored', op: 'none', invoiceDocId: input.invoiceId, results: [] };
  }
  const invoice = asInvoice(input.invoiceId, input.after);
  const companyId = asTrimmedString(invoice.companyId);
  if (!isTicketOnlyWaterTicket({ id: '', invoiceNumber: invoice.invoiceNumber }, invoice)) {
    return {
      class: 'ignored',
      op,
      reason: 'not_ticket_only',
      invoiceDocId: input.invoiceId,
      companyId,
      results: [],
    };
  }
  const tickets = await input.store.findTicketsByInvoiceDocId(input.invoiceId);
  if (tickets.length === 0) {
    return {
      class: 'pending_reconciliation',
      op,
      reason: 'tickets_not_yet_queryable',
      invoiceDocId: input.invoiceId,
      companyId,
      results: [],
    };
  }
  const outcomes: PaperLifecycleOutcome[] = [];
  for (const ticket of tickets) {
    outcomes.push(await materializeOne({
      store: input.store,
      ticketDocId: ticket.id,
      invoiceDocId: input.invoiceId,
      companyId: asTrimmedString(ticket.companyId) || companyId,
      op,
      editSource: op === 'edit' ? 'invoice' : undefined,
      nowMs: input.nowMs,
      sourceTicket: ticket,
      sourceInvoice: invoice,
    }));
  }
  return foldOutcomes(op, outcomes);
}

export async function applyTicketPaperLifecycle(input: {
  store: PaperStore;
  ticketId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  nowMs: number;
}): Promise<PaperLifecycleOutcome> {
  const change = classifyTicketPaperChange(input.before, input.after);
  if (!input.after || change === 'none') {
    return { class: 'ignored', op: 'none', ticketDocId: input.ticketId, results: [] };
  }
  const ticket = asTicket(input.ticketId, input.after);
  const invoiceId = asTrimmedString(ticket.invoiceDocId);
  const invoice = invoiceId ? await input.store.getInvoice(invoiceId) : null;
  const companyId = asTrimmedString(ticket.companyId) || asTrimmedString(invoice?.companyId);
  if (invoice && !isTicketOnlyWaterTicket(ticket, invoice)) {
    return {
      class: 'ignored',
      op: 'none',
      reason: 'not_ticket_only',
      ticketDocId: input.ticketId,
      invoiceDocId: invoiceId,
      companyId,
      results: [],
    };
  }
  if (!isAuthoritativelyClosed(invoice)) {
    return { class: 'ignored', op: 'none', ticketDocId: input.ticketId, invoiceDocId: invoiceId, companyId, results: [] };
  }

  if (change === 'reconcile') {
    return materializeOne({
      store: input.store,
      ticketDocId: input.ticketId,
      invoiceDocId: invoiceId,
      companyId,
      op: 'close',
      nowMs: input.nowMs,
      sourceTicket: ticket,
      sourceInvoice: invoice,
    });
  }

  return materializeOne({
    store: input.store,
    ticketDocId: input.ticketId,
    invoiceDocId: invoiceId,
    companyId,
    op: 'edit',
    editSource: 'ticket',
    nowMs: input.nowMs,
    sourceTicket: ticket,
    sourceInvoice: invoice,
  });
}

export type PaperLifecycleAudit = (entry: {
  action: string;
  actorUid?: string | null;
  detail?: Record<string, unknown>;
}) => Promise<void>;

/**
 * Trigger settlement: retriable failures throw (Cloud Functions retry).
 * Permanent contract violations are audited and do not look like success of
 * a ticket-only close/edit. Expected ignores and pending reconciliation return.
 */
export async function settlePaperLifecycle(
  outcome: PaperLifecycleOutcome,
  audit?: PaperLifecycleAudit,
): Promise<PaperLifecycleOutcome> {
  if (outcome.class === 'retriable') {
    throw new Error('paper_lifecycle_retry');
  }
  if (outcome.class === 'permanent') {
    const detail = {
      ticketDocId: outcome.ticketDocId || '',
      invoiceDocId: outcome.invoiceDocId || '',
      companyId: outcome.companyId || '',
      sourceEvent: outcome.sourceEventId || outcome.op,
      reason: outcome.reason || 'permanent_failure',
    };
    console.error('[paper-lifecycle] permanent_failure', detail);
    if (audit) {
      await audit({
        action: 'paperLifecyclePermanentFailure',
        actorUid: SYSTEM_PAPER_CALLER.uid,
        detail,
      });
    }
  }
  return outcome;
}
