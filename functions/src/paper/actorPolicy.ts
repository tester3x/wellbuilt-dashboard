/**
 * Canonical paper actor routing v2.
 *
 * Driver 24h window starts at invoice.closedAt/closedAtMs only — not createdAt.
 * Dashboard authority is capability + workflow stage, not roles[0].
 * Platform admin is an explicit override, not a standing editor.
 *
 * WB-T updateTicket still uses createdAt||closedAt. That mismatch is reported;
 * this module does not edit WB-T.
 */
import { asTrimmedString, timestampMs } from './format';
import { canonicalDriverIdFromRecords } from './identity';
import type {
  InvoiceSourceRecord,
  PaperCaller,
  PaperWorkflowRecord,
  PaperWorkflowStage,
  TicketSourceRecord,
} from './types';

export const PAPER_ACTOR_POLICY_VERSION = 'canonical-paper-actor-routing.v3';
export const DRIVER_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const DRIVER_MUTATION_FIELDS = [
  'date', 'operator', 'company', 'location', 'wellName', 'hauledTo', 'disposal',
  'truck', 'trailer', 'qty', 'bbls', 'pickupBbls', 'dropoffBbls', 'top', 'bottom',
  'hours', 'notes',
] as const;

export const DISPATCH_MUTATION_FIELDS = [
  'date', 'operator', 'company', 'location', 'wellName', 'hauledTo', 'disposal',
  'truck', 'trailer', 'driver', 'hours', 'notes',
] as const;

export const PAYROLL_MUTATION_FIELDS = [
  'hours', 'totalHours',
] as const;

export const BILLING_TICKET_MUTATION_FIELDS = [] as const;

export const ADMIN_OVERRIDE_FIELDS = [
  ...new Set([...DRIVER_MUTATION_FIELDS, ...DISPATCH_MUTATION_FIELDS, ...PAYROLL_MUTATION_FIELDS]),
];

export type PaperPresentationMode = 'edit_form' | 'canonical_paper' | 'read_only_detail';
export type PaperStageActor = 'driver' | 'dispatch' | 'payroll' | 'billing' | 'admin' | 'viewer';

export type PaperPresentationDecision = {
  ok: true;
  mode: PaperPresentationMode;
  canEdit: boolean;
  reason: string;
  evaluatedAtMs: number;
  policyVersion: string;
  previewAvailable: boolean;
  stageActor: PaperStageActor;
  workflowStage: PaperWorkflowStage | 'open' | 'driver_correction';
  allowedFields: string[];
  artifactId?: string;
  revisionId?: string;
  windowOriginMs?: number | null;
  windowExpiresAtMs?: number | null;
} | {
  ok: false;
  reason: string;
  message: string;
  canEdit: false;
  evaluatedAtMs: number;
  policyVersion: string;
  gap?: string;
};

export function callerHasCap(caller: PaperCaller, cap: string): boolean {
  return (caller.caps || []).includes(cap);
}

export function assertRecordTenant(input: {
  caller: PaperCaller;
  ticket: TicketSourceRecord;
  invoice: InvoiceSourceRecord | null;
  review?: PaperWorkflowRecord | null;
  allowAdminCrossTenant?: boolean;
}): { ok: true } | { ok: false; reason: string; message: string } {
  const ticketCo = asTrimmedString(input.ticket.companyId);
  const invoiceCo = input.invoice ? asTrimmedString(input.invoice.companyId) : ticketCo;
  const reviewCo = input.review ? asTrimmedString(input.review.companyId) : ticketCo;
  if (!ticketCo || (input.invoice && invoiceCo !== ticketCo) || (input.review && reviewCo !== ticketCo)) {
    return { ok: false, reason: 'record_company_mismatch', message: 'Ticket, invoice, and review companyId must agree.' };
  }
  if (input.caller.kind === 'driver') {
    if (asTrimmedString(input.caller.companyId) !== ticketCo) {
      return { ok: false, reason: 'record_company_mismatch', message: 'Driver company does not match the ticket.' };
    }
    return { ok: true };
  }
  if (input.caller.isPlatformAdmin && input.allowAdminCrossTenant) return { ok: true };
  if (!input.caller.companyId || input.caller.companyId !== ticketCo) {
    return { ok: false, reason: 'record_company_mismatch', message: 'Caller company does not match the ticket.' };
  }
  return { ok: true };
}

function isClosedStatus(status: unknown): boolean {
  const s = asTrimmedString(status).toLowerCase();
  return s === 'closed' || s === 'complete' || s === 'completed';
}

function invoiceLooksClosed(invoice: InvoiceSourceRecord | Record<string, unknown> | null | undefined): boolean {
  if (!invoice) return false;
  const rec = invoice as Record<string, unknown>;
  if (timestampMs(rec.closedAt) || timestampMs(rec.closedAtMs)) return true;
  return isClosedStatus(rec.status);
}

/** Authoritative close instant only. Never createdAt. */
export function driverEditWindowOriginMs(
  invoice: InvoiceSourceRecord | Record<string, unknown> | null | undefined,
): number | null {
  if (!invoice) return null;
  const rec = invoice as Record<string, unknown>;
  return timestampMs(rec.closedAtMs) || timestampMs(rec.closedAt);
}

export function driverOwnsTicket(
  caller: PaperCaller,
  ticket: TicketSourceRecord,
  invoice: InvoiceSourceRecord | null,
): boolean {
  if (caller.kind !== 'driver' || !caller.driverId) return false;
  const owner = canonicalDriverIdFromRecords({
    ownerDriverId: ticket.ownerDriverId,
    driverId: ticket.driverId,
    submittedBy: ticket.submittedBy,
    invoiceOwnerDriverId: invoice?.ownerDriverId,
    invoiceDriverId: invoice?.driverId,
  });
  return owner === caller.driverId;
}

export function workflowStageFor(
  invoice: InvoiceSourceRecord | null,
  workflow: PaperWorkflowRecord | null,
): PaperWorkflowStage | 'open' | 'unavailable' {
  if (!invoiceLooksClosed(invoice) && !driverEditWindowOriginMs(invoice)) return 'open';
  if (!workflow) return 'unavailable';
  return workflow.stage;
}

export function resolveStageActor(
  caller: PaperCaller,
  stage: PaperWorkflowStage | 'open' | 'unavailable',
): PaperStageActor {
  if (caller.kind === 'driver') return 'driver';
  if (caller.isPlatformAdmin) return 'admin';
  if (stage === 'payroll_review' && callerHasCap(caller, 'approvePayroll')) return 'payroll';
  if (stage === 'dispatch_review' && callerHasCap(caller, 'createDispatch')) return 'dispatch';
  if (stage === 'billing' && (callerHasCap(caller, 'editBilling') || callerHasCap(caller, 'viewBilling'))) return 'billing';
  if (stage === 'open' && callerHasCap(caller, 'createDispatch')) return 'dispatch';
  if (callerHasCap(caller, 'viewTickets') || callerHasCap(caller, 'viewDispatch')) return 'viewer';
  return 'viewer';
}

export function allowedFieldsFor(actor: PaperStageActor, overrideActive: boolean): string[] {
  if (actor === 'driver') return [...DRIVER_MUTATION_FIELDS];
  if (actor === 'dispatch') return [...DISPATCH_MUTATION_FIELDS];
  if (actor === 'payroll') return [...PAYROLL_MUTATION_FIELDS];
  if (actor === 'admin' && overrideActive) return [...ADMIN_OVERRIDE_FIELDS];
  return [];
}

export function assertActorMayMutateTicket(input: {
  caller: PaperCaller;
  ticket: TicketSourceRecord;
  invoice: InvoiceSourceRecord | null;
  workflow?: PaperWorkflowRecord | null;
  nowMs: number;
  fields?: string[];
}): { ok: true; via: string; allowedFields: string[] } | { ok: false; reason: string; message: string } {
  const tenant = assertRecordTenant({
    caller: input.caller,
    ticket: input.ticket,
    invoice: input.invoice,
    review: input.workflow,
    allowAdminCrossTenant: input.caller.isPlatformAdmin && !!input.workflow?.overrideActive,
  });
  if (!tenant.ok) return tenant;
  const closedAtMs = driverEditWindowOriginMs(input.invoice);
  const closed = invoiceLooksClosed(input.invoice) || closedAtMs != null;
  const stage = workflowStageFor(input.invoice, input.workflow || null);
  if (stage === 'unavailable' && input.caller.kind !== 'driver') {
    return { ok: false, reason: 'workflow_unavailable', message: 'Ticket review state is not available.' };
  }
  const actor = resolveStageActor(input.caller, stage);

  if (input.caller.kind === 'system') {
    return { ok: false, reason: 'unauthorized', message: 'System callers do not mutate tickets.' };
  }

  if (actor === 'admin') {
    if (!input.workflow?.overrideActive) {
      return { ok: false, reason: 'override_required', message: 'Platform admin must reopen with a reason before mutating.' };
    }
    return finish('admin_override', allowedFieldsFor('admin', true), input.fields);
  }

  if (actor === 'driver') {
    if (!driverOwnsTicket(input.caller, input.ticket, input.invoice)) {
      return { ok: false, reason: 'not_ticket_owner', message: 'Driver may only edit their own ticket.' };
    }
    if (closed && closedAtMs == null) {
      return { ok: false, reason: 'edit_window_unknown', message: 'Closed job has no authoritative closedAt.' };
    }
    if (closed && input.nowMs - closedAtMs! >= DRIVER_EDIT_WINDOW_MS) {
      return { ok: false, reason: 'edit_window_expired', message: 'Driver correction window has expired.' };
    }
    return finish('owner', allowedFieldsFor('driver', false), input.fields);
  }

  if (actor === 'dispatch') {
    if (stage !== 'dispatch_review') {
      return { ok: false, reason: 'workflow_locked', message: 'Dispatch handoff to payroll has already occurred.' };
    }
    return finish('dispatch', allowedFieldsFor('dispatch', false), input.fields);
  }

  if (actor === 'payroll') {
    if (stage !== 'payroll_review') {
      return { ok: false, reason: 'workflow_locked', message: 'Payroll has finalized this ticket to billing.' };
    }
    return finish('payroll', allowedFieldsFor('payroll', false), input.fields);
  }

  if (actor === 'billing') {
    return { ok: false, reason: 'billing_cannot_mutate_ticket', message: 'Billing cannot mutate the original water ticket.' };
  }

  return { ok: false, reason: 'unauthorized', message: 'Caller cannot mutate this ticket.' };
}

function finish(
  via: string,
  allowedFields: string[],
  fields?: string[],
): { ok: true; via: string; allowedFields: string[] } | { ok: false; reason: string; message: string } {
  if (fields) {
    const extra = fields.filter((f) => !allowedFields.includes(f));
    if (extra.length) {
      return { ok: false, reason: 'unexpected_field', message: `Field not permitted in this stage: ${extra[0]}` };
    }
  }
  return { ok: true, via, allowedFields };
}

export function evaluatePaperPresentation(input: {
  caller: PaperCaller;
  ticket: TicketSourceRecord;
  invoice: InvoiceSourceRecord | null;
  nowMs: number;
  workflow?: PaperWorkflowRecord | null;
  artifact?: { artifactId: string; currentRevisionId: string } | null;
}): PaperPresentationDecision {
  const evaluatedAtMs = input.nowMs;
  const policyVersion = PAPER_ACTOR_POLICY_VERSION;
  const tenant = assertRecordTenant({
    caller: input.caller,
    ticket: input.ticket,
    invoice: input.invoice,
    review: input.workflow,
    allowAdminCrossTenant: input.caller.isPlatformAdmin,
  });
  if (!tenant.ok) {
    return { ...tenant, canEdit: false, evaluatedAtMs: input.nowMs, policyVersion: PAPER_ACTOR_POLICY_VERSION };
  }
  const closedAtMs = driverEditWindowOriginMs(input.invoice);
  const closed = invoiceLooksClosed(input.invoice) || closedAtMs != null;
  const stage = workflowStageFor(input.invoice, input.workflow || null);
  if (closed && stage === 'unavailable' && input.caller.kind !== 'driver') {
    return {
      ok: false,
      reason: 'workflow_unavailable',
      message: 'Ticket review state is not available.',
      canEdit: false,
      evaluatedAtMs: input.nowMs,
      policyVersion: PAPER_ACTOR_POLICY_VERSION,
    };
  }
  const actor = resolveStageActor(input.caller, stage);
  const paperMeta = input.artifact?.currentRevisionId
    ? { artifactId: input.artifact.artifactId, revisionId: input.artifact.currentRevisionId }
    : {};
  const base = {
    evaluatedAtMs,
    policyVersion,
    stageActor: actor,
    workflowStage: (closed ? stage : 'open') as PaperWorkflowStage | 'open' | 'driver_correction',
  };

  if (input.caller.kind === 'driver') {
    if (!driverOwnsTicket(input.caller, input.ticket, input.invoice)) {
      return {
        ok: false,
        reason: 'not_document_owner',
        message: 'Driver may only access their own ticket.',
        canEdit: false,
        evaluatedAtMs,
        policyVersion,
      };
    }
    if (!closed) {
      return {
        ok: true,
        mode: 'edit_form',
        canEdit: true,
        reason: 'driver_open_job',
        previewAvailable: false,
        allowedFields: [...DRIVER_MUTATION_FIELDS],
        windowOriginMs: null,
        windowExpiresAtMs: null,
        ...base,
        workflowStage: 'open',
      };
    }
    if (closedAtMs == null) {
      return {
        ok: false,
        reason: 'edit_window_unknown',
        message: 'Closed job has no authoritative closedAt.',
        canEdit: false,
        evaluatedAtMs,
        policyVersion,
      };
    }
    const expiresAtMs = closedAtMs + DRIVER_EDIT_WINDOW_MS;
    if (evaluatedAtMs - closedAtMs < DRIVER_EDIT_WINDOW_MS) {
      return {
        ok: true,
        mode: 'edit_form',
        canEdit: true,
        reason: 'driver_correction_window',
        previewAvailable: true,
        allowedFields: [...DRIVER_MUTATION_FIELDS],
        windowOriginMs: closedAtMs,
        windowExpiresAtMs: expiresAtMs,
        ...paperMeta,
        ...base,
        workflowStage: 'driver_correction',
      };
    }
    return {
      ok: true,
      mode: 'canonical_paper',
      canEdit: false,
      reason: 'edit_window_expired',
      previewAvailable: true,
      allowedFields: [],
      windowOriginMs: closedAtMs,
      windowExpiresAtMs: expiresAtMs,
      ...paperMeta,
      ...base,
    };
  }

  if (actor === 'admin') {
    if (input.workflow?.overrideActive) {
      return {
        ok: true,
        mode: 'edit_form',
        canEdit: true,
        reason: 'admin_override',
        previewAvailable: true,
        allowedFields: [...ADMIN_OVERRIDE_FIELDS],
        ...paperMeta,
        ...base,
      };
    }
    return {
      ok: true,
      mode: closed ? 'canonical_paper' : 'read_only_detail',
      canEdit: false,
      reason: closed ? 'admin_view_paper' : 'admin_open_readonly',
      previewAvailable: false,
      allowedFields: [],
      ...paperMeta,
      ...base,
    };
  }

  if (!closed) {
    return {
      ok: true,
      mode: 'read_only_detail',
      canEdit: false,
      reason: 'open_job_unproven_edit',
      previewAvailable: false,
      allowedFields: [],
      ...base,
      workflowStage: 'open',
    };
  }

  if (actor === 'dispatch' && stage === 'dispatch_review') {
    return {
      ok: true,
      mode: 'edit_form',
      canEdit: true,
      reason: 'dispatch_review',
      previewAvailable: true,
      allowedFields: [...DISPATCH_MUTATION_FIELDS],
      ...paperMeta,
      ...base,
    };
  }

  if (actor === 'payroll' && stage === 'payroll_review') {
    return {
      ok: true,
      mode: 'edit_form',
      canEdit: true,
      reason: 'payroll_review',
      previewAvailable: true,
      allowedFields: [...PAYROLL_MUTATION_FIELDS],
      ...paperMeta,
      ...base,
    };
  }

  if (actor === 'dispatch' || actor === 'payroll' || actor === 'billing' || actor === 'viewer') {
    return {
      ok: true,
      mode: 'canonical_paper',
      canEdit: false,
      reason: actor === 'billing' ? 'billing_receives_paper' : 'stage_locked_paper',
      previewAvailable: true,
      allowedFields: [],
      ...paperMeta,
      ...base,
    };
  }

  return {
    ok: false,
    reason: 'unauthorized',
    message: 'Caller is not a paper presentation actor.',
    canEdit: false,
    evaluatedAtMs,
    policyVersion,
  };
}

export function presentationRoleLabel(caller: PaperCaller): string {
  if (caller.kind === 'driver') return 'driver';
  if (caller.isPlatformAdmin) return 'platform_admin';
  if (callerHasCap(caller, 'approvePayroll')) return 'payroll';
  if (callerHasCap(caller, 'createDispatch')) return 'dispatch';
  if (callerHasCap(caller, 'editBilling')) return 'billing';
  return asTrimmedString((caller.roles || [])[0]) || 'dashboard';
}
