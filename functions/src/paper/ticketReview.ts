import { randomUUID } from 'crypto';
import { asTrimmedString } from './format';
import { assertActorMayMutateTicket, assertRecordTenant, driverEditWindowOriginMs } from './actorPolicy';
import { isTicketOnlyWaterTicket } from './projection';
import {
  clearOverrideAfterMutation,
  finalizeToBilling,
  handToPayroll,
  reopenForOverride,
} from './workflow';
import type { PaperCaller, PaperWorkflowRecord, TicketReviewEventRecord } from './types';
import type { PaperStore } from './store';

const NUMERIC_FIELDS = new Set(['qty', 'bbls', 'pickupBbls', 'dropoffBbls', 'hours', 'totalHours', 'totalBBL']);
const TICKET_PATCH_FIELDS = new Set([
  'date', 'operator', 'company', 'location', 'wellName', 'hauledTo', 'disposal',
  'truck', 'trailer', 'driver', 'qty', 'bbls', 'pickupBbls', 'dropoffBbls',
  'top', 'bottom', 'hours', 'notes',
]);
const INVOICE_PATCH_FIELDS = new Set(['totalBBL', 'totalHours', 'operator', 'wellName', 'hauledTo', 'truckNumber', 'trailer']);
const ALLOWED_FIELDS = new Set([...TICKET_PATCH_FIELDS, ...INVOICE_PATCH_FIELDS]);

export type TicketReviewAction = 'correct' | 'hand_to_payroll' | 'finalize_to_billing' | 'reopen';
export const MAX_REVIEW_BATCH = 50;

const MAX_TEXT = 500;
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const NONNEG = new Set(['qty', 'bbls', 'pickupBbls', 'dropoffBbls', 'hours', 'totalHours', 'totalBBL']);

function validCalendarDate(text: string): boolean {
  const m = text.match(DATE_RE);
  if (!m) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2100) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

export function validateTypedFields(fields: Record<string, unknown>):
  | { ok: true; parsed: Record<string, unknown> }
  | { ok: false; reason: string; message: string } {
  const keys = Object.keys(fields);
  if (!keys.length) return { ok: false, reason: 'invalid_request', message: 'No mutation fields.' };
  const parsed: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { ok: false, reason: 'unexpected_field', message: `Unexpected field: ${key}` };
    }
    if (NUMERIC_FIELDS.has(key)) {
      let n: number | null = null;
      if (typeof raw === 'number' && Number.isFinite(raw)) n = raw;
      else if (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim())) n = Number(raw.trim());
      if (n == null || !Number.isFinite(n)) {
        return { ok: false, reason: 'invalid_field_type', message: `Field ${key} must be a finite number.` };
      }
      if (NONNEG.has(key) && n < 0) {
        return { ok: false, reason: 'invalid_field_value', message: `Field ${key} cannot be negative.` };
      }
      parsed[key] = n;
      continue;
    }
    if (raw != null && typeof raw !== 'string' && typeof raw !== 'number') {
      return { ok: false, reason: 'invalid_field_type', message: `Field ${key} has an invalid type.` };
    }
    const text = raw == null ? '' : String(raw).trim();
    if (text.length > MAX_TEXT) {
      return { ok: false, reason: 'invalid_field_value', message: `Field ${key} exceeds ${MAX_TEXT} characters.` };
    }
    if (key === 'date' && !validCalendarDate(text)) {
      return { ok: false, reason: 'invalid_field_value', message: 'Date must be a valid MM/DD/YYYY value.' };
    }
    parsed[key] = typeof raw === 'number' ? raw : text;
  }
  return { ok: true, parsed };
}

function currentFieldValue(ticket: Record<string, unknown>, invoice: Record<string, unknown> | null, key: string): unknown {
  if (key === 'truck') return ticket.truck ?? invoice?.truckNumber;
  if (key === 'hours') return ticket.hours ?? invoice?.totalHours;
  if (key === 'totalHours') return invoice?.totalHours ?? ticket.hours;
  if (key === 'totalBBL') return invoice?.totalBBL ?? ticket.qty ?? ticket.bbls;
  return ticket[key] ?? invoice?.[key];
}

function fieldUnchanged(ticket: Record<string, unknown>, invoice: Record<string, unknown> | null, key: string, value: unknown): boolean {
  const cur = currentFieldValue(ticket, invoice, key);
  if (value == null && (cur == null || cur === '')) return true;
  if (NUMERIC_FIELDS.has(key)) {
    const a = typeof cur === 'number' ? cur : Number(cur);
    const b = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  return String(cur ?? '') === String(value ?? '');
}

function patchesFromFields(fields: Record<string, unknown>, mutationId: string, nowMs: number) {
  const ticketPatch: Record<string, unknown> = {
    updatedAt: nowMs,
    updatedAtMs: nowMs,
    paperMutationId: mutationId,
  };
  const invoicePatch: Record<string, unknown> = {
    updatedAt: nowMs,
    editedAt: nowMs,
    paperMutationId: mutationId,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (TICKET_PATCH_FIELDS.has(key)) ticketPatch[key] = value;
    if (INVOICE_PATCH_FIELDS.has(key) || key === 'truck' || key === 'operator' || key === 'hauledTo') {
      if (key === 'truck') invoicePatch.truckNumber = value;
      else invoicePatch[key] = value;
    }
  }
  return { ticketPatch, invoicePatch };
}

export async function applyTicketReviewAction(input: {
  store: PaperStore;
  caller: PaperCaller;
  ticketDocId: string;
  action: TicketReviewAction;
  nowMs: number;
  fields?: Record<string, unknown>;
  reason?: string;
  expectedVersion?: number;
  batchId?: string;
}): Promise<
  | { ok: true; via: string; mutationId: string; stage: string; version: number; ticketDocId: string; invoiceDocId: string }
  | { ok: false; reason: string; message: string }
> {
  return input.store.runReviewTransaction(async (store) => {
    const ticket = await store.getTicket(input.ticketDocId);
    if (!ticket) return { ok: false as const, reason: 'ticket_not_found', message: 'Ticket not found.' };
    const invoiceId = asTrimmedString(ticket.invoiceDocId);
    const invoice = invoiceId ? await store.getInvoice(invoiceId) : null;
    const review = await store.getWorkflow(input.ticketDocId);
    const tenant = assertRecordTenant({
      caller: input.caller,
      ticket,
      invoice,
      review,
      allowAdminCrossTenant: input.caller.isPlatformAdmin && (
        input.action === 'reopen' || (input.action === 'correct' && !!review?.overrideActive)
      ),
    });
    if (!tenant.ok) return tenant;

    if (input.expectedVersion == null) {
      return { ok: false as const, reason: 'expected_version_required', message: 'expectedVersion is required.' };
    }
    const currentVersion = review?.version ?? 0;
    if (currentVersion !== input.expectedVersion) {
      return { ok: false as const, reason: 'version_conflict', message: 'Review state changed; retry with current version.' };
    }

    if (input.action !== 'correct' && input.action !== 'reopen') {
      if (!review) return { ok: false as const, reason: 'workflow_unavailable', message: 'Ticket review state is not available.' };
      if (!driverEditWindowOriginMs(invoice)) {
        return { ok: false as const, reason: 'edit_window_unknown', message: 'No authoritative closedAt; cannot hand off an open invoice.' };
      }
      if (!isTicketOnlyWaterTicket(ticket, invoice)) {
        return { ok: false as const, reason: 'not_ticket_only', message: 'This slice is ticket-only Water Tickets.' };
      }
    }

    const mutationId = randomUUID();
    let nextReview: PaperWorkflowRecord | null = review;
    let via: string = input.action;
    let parsedFields: Record<string, unknown> = {};

    if (input.action === 'correct') {
      const typed = validateTypedFields(input.fields || {});
      if (!typed.ok) return typed;
      parsedFields = typed.parsed;
      const ticketRec = ticket as unknown as Record<string, unknown>;
      const invoiceRec = (invoice || {}) as unknown as Record<string, unknown>;
      const changed = Object.keys(parsedFields).some((k) => !fieldUnchanged(ticketRec, invoiceRec, k, parsedFields[k]));
      if (!changed) {
        return { ok: false as const, reason: 'no_effective_change', message: 'Correction does not change any values.' };
      }
      const gate = assertActorMayMutateTicket({
        caller: input.caller,
        ticket,
        invoice,
        workflow: review,
        nowMs: input.nowMs,
        fields: Object.keys(parsedFields),
      });
      if (!gate.ok) return gate;
      via = gate.via;
      if (review) {
        nextReview = {
          ...clearOverrideAfterMutation(review, input.nowMs),
          version: review.version + 1,
          lastMutationId: mutationId,
        };
      }
      const { ticketPatch, invoicePatch } = patchesFromFields(parsedFields, mutationId, input.nowMs);
      await store.patchTicket(input.ticketDocId, ticketPatch);
      if (invoiceId && invoice) await store.patchInvoice(invoiceId, invoicePatch);
    } else if (input.action === 'hand_to_payroll') {
      if (!review) return { ok: false as const, reason: 'workflow_unavailable', message: 'Ticket review state is not available.' };
      const next = handToPayroll(review, input.caller, input.nowMs);
      if (!next.ok) return next;
      nextReview = { ...next.workflow, lastMutationId: mutationId };
    } else if (input.action === 'finalize_to_billing') {
      if (!review) return { ok: false as const, reason: 'workflow_unavailable', message: 'Ticket review state is not available.' };
      const next = finalizeToBilling(review, input.caller, input.nowMs);
      if (!next.ok) return next;
      nextReview = { ...next.workflow, lastMutationId: mutationId };
    } else {
      if (!review) return { ok: false as const, reason: 'workflow_unavailable', message: 'Ticket review state is not available.' };
      const next = reopenForOverride(review, input.caller, input.reason || '', input.nowMs);
      if (!next.ok) return next;
      nextReview = { ...next.workflow, lastMutationId: mutationId };
    }

    if (nextReview) await store.putWorkflow(nextReview);
    const linkedReason = input.action === 'correct' && review?.overrideActive
      ? (input.reason || review.overrideReason || null)
      : (input.reason || null);
    const event: TicketReviewEventRecord = {
      mutationId,
      ticketDocId: input.ticketDocId,
      invoiceDocId: invoiceId,
      companyId: asTrimmedString(ticket.companyId),
      action: input.action,
      actorUid: input.caller.uid,
      via,
      reason: linkedReason,
      fields: Object.keys(parsedFields),
      stageBefore: review?.stage || 'none',
      stageAfter: nextReview?.stage || review?.stage || 'none',
      versionBefore: review?.version || 0,
      versionAfter: nextReview?.version || 0,
      nowMs: input.nowMs,
      ...(input.batchId ? { batchId: input.batchId } : {}),
    };
    await store.putReviewEvent(event);
    return {
      ok: true as const,
      via,
      mutationId,
      stage: nextReview?.stage || '',
      version: nextReview?.version || 0,
      ticketDocId: input.ticketDocId,
      invoiceDocId: invoiceId,
    };
  });
}

export type TicketReviewBatchItemResult =
  | { ok: true; ticketDocId: string; via: string; mutationId: string; stage: string; version: number }
  | { ok: false; ticketDocId: string; reason: string; message: string };

export async function applyTicketReviewBatch(input: {
  store: PaperStore;
  caller: PaperCaller;
  action: 'hand_to_payroll' | 'finalize_to_billing';
  items: Array<{ ticketDocId: string; expectedVersion: number }>;
  nowMs: number;
}): Promise<{ ok: true; batchId: string; results: TicketReviewBatchItemResult[] }> {
  const batchId = randomUUID();
  const results: TicketReviewBatchItemResult[] = [];
  for (const item of input.items) {
    const r = await applyTicketReviewAction({
      store: input.store,
      caller: input.caller,
      ticketDocId: item.ticketDocId,
      action: input.action,
      nowMs: input.nowMs,
      expectedVersion: item.expectedVersion,
      batchId,
    });
    if (r.ok) {
      results.push({
        ok: true,
        ticketDocId: item.ticketDocId,
        via: r.via,
        mutationId: r.mutationId,
        stage: r.stage,
        version: r.version,
      });
    } else {
      results.push({
        ok: false,
        ticketDocId: item.ticketDocId,
        reason: r.reason,
        message: r.message,
      });
    }
  }
  return { ok: true, batchId, results };
}
