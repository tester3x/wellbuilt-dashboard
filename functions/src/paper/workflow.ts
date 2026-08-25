import { asTrimmedString, timestampMs } from './format';
import { callerHasCap } from './actorPolicy';
import type { InvoiceSourceRecord, PaperCaller, PaperWorkflowRecord, PaperWorkflowStage } from './types';

export function seedDispatchReviewWorkflow(input: {
  ticketDocId: string;
  invoiceDocId: string;
  companyId: string;
  invoice: InvoiceSourceRecord | null;
  nowMs: number;
}): PaperWorkflowRecord {
  return {
    ticketDocId: input.ticketDocId,
    invoiceDocId: input.invoiceDocId,
    companyId: input.companyId,
    stage: 'dispatch_review',
    closedAtMs: timestampMs(input.invoice?.closedAtMs) || timestampMs(input.invoice?.closedAt),
    handedToPayrollAtMs: null,
    handedToPayrollByUid: null,
    finalizedToBillingAtMs: null,
    finalizedToBillingByUid: null,
    overrideActive: false,
    overrideReason: null,
    overrideByUid: null,
    overrideAtMs: null,
    updatedAtMs: input.nowMs,
  };
}

export function handToPayroll(
  current: PaperWorkflowRecord,
  caller: PaperCaller,
  nowMs: number,
): { ok: true; workflow: PaperWorkflowRecord } | { ok: false; reason: string; message: string } {
  if (!callerHasCap(caller, 'createDispatch') && !caller.isPlatformAdmin) {
    return { ok: false, reason: 'missing_capability', message: 'Dispatch handoff requires createDispatch.' };
  }
  if (current.stage !== 'dispatch_review') {
    return { ok: false, reason: 'workflow_locked', message: 'Ticket is not in dispatch review.' };
  }
  return {
    ok: true,
    workflow: {
      ...current,
      stage: 'payroll_review',
      handedToPayrollAtMs: nowMs,
      handedToPayrollByUid: caller.uid,
      overrideActive: false,
      updatedAtMs: nowMs,
    },
  };
}

export function finalizeToBilling(
  current: PaperWorkflowRecord,
  caller: PaperCaller,
  nowMs: number,
): { ok: true; workflow: PaperWorkflowRecord } | { ok: false; reason: string; message: string } {
  if (!callerHasCap(caller, 'approvePayroll') && !caller.isPlatformAdmin) {
    return { ok: false, reason: 'missing_capability', message: 'Payroll finalization requires approvePayroll.' };
  }
  if (current.stage !== 'payroll_review') {
    return { ok: false, reason: 'workflow_locked', message: 'Ticket is not in payroll review.' };
  }
  return {
    ok: true,
    workflow: {
      ...current,
      stage: 'billing',
      finalizedToBillingAtMs: nowMs,
      finalizedToBillingByUid: caller.uid,
      overrideActive: false,
      updatedAtMs: nowMs,
    },
  };
}

export function reopenForOverride(
  current: PaperWorkflowRecord,
  caller: PaperCaller,
  reason: string,
  nowMs: number,
): { ok: true; workflow: PaperWorkflowRecord } | { ok: false; reason: string; message: string } {
  if (!caller.isPlatformAdmin) {
    return { ok: false, reason: 'override_required', message: 'Only a platform admin may reopen a locked ticket.' };
  }
  const trimmed = asTrimmedString(reason);
  if (trimmed.length < 8) {
    return { ok: false, reason: 'reason_required', message: 'Reopen requires an audit reason.' };
  }
  return {
    ok: true,
    workflow: {
      ...current,
      overrideActive: true,
      overrideReason: trimmed,
      overrideByUid: caller.uid,
      overrideAtMs: nowMs,
      updatedAtMs: nowMs,
    },
  };
}

export function clearOverrideAfterMutation(current: PaperWorkflowRecord, nowMs: number): PaperWorkflowRecord {
  return {
    ...current,
    overrideActive: false,
    updatedAtMs: nowMs,
  };
}

export function defaultClosedWorkflowStage(): PaperWorkflowStage {
  return 'dispatch_review';
}
