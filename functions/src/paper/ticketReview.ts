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

export type TicketReviewAction = 'correct' | 'hand_to_payroll' | 'finalize_to_billing' | 'reopen';

export function validateTypedFields(fields: Record<string, unknown>):
  | { ok: true; parsed: Record<string, unknown> }
  | { ok: false; reason: string; message: string } {
  const parsed: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(fields)) {
    if (NUMERIC_FIELDS.has(key)) {
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        parsed[key] = raw;
        continue;
      }
      if (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
        parsed[key] = Number(raw.trim());
        continue;
      }
      return { ok: false, reason: 'invalid_field_type', message: `Field ${key} must be a finite number.` };
    }
    if (raw != null && typeof raw !== 'string' && typeof raw !== 'number') {
      return { ok: false, reason: 'invalid_field_type', message: `Field ${key} has an invalid type.` };
    }
    parsed[key] = raw;
  }
  return { ok: true, parsed };
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
      allowAdminCrossTenant: input.action === 'reopen' && input.caller.isPlatformAdmin,
    });
    if (!tenant.ok) return tenant;

    if (input.expectedVersion != null && review && review.version !== input.expectedVersion) {
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
    const event: TicketReviewEventRecord = {
      mutationId,
      ticketDocId: input.ticketDocId,
      invoiceDocId: invoiceId,
      companyId: asTrimmedString(ticket.companyId),
      action: input.action,
      actorUid: input.caller.uid,
      via,
      reason: input.reason || null,
      fields: Object.keys(parsedFields),
      stageBefore: review?.stage || 'none',
      stageAfter: nextReview?.stage || review?.stage || 'none',
      versionBefore: review?.version || 0,
      versionAfter: nextReview?.version || 0,
      nowMs: input.nowMs,
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
