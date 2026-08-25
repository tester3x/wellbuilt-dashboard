/**
 * Actor presentation / mutation policy for canonical paper.
 *
 * GOVERNED (copied, not invented):
 *   Driver owner 24h window from invoice.createdAt || closedAt.
 *   Matches WB-T functions/src/ticketEdit.ts authorizeTicketEditGoverned
 *   and HistoryScreen.canEdit / utils/historyCardCore.EDIT_WINDOW_MS.
 *   Server clock only. Platform admin is the WB-T privileged bypass.
 *
 * NOT GOVERNED — do not invent:
 *   Dispatch pay-period ticket-edit window
 *   Payroll lock after dispatch
 *   Billing/finalization lock
 *   Offline: edit started before expiry, synced after (WB-T uses Date.now()
 *   at transaction time; this module identifies that boundary and does not
 *   decide a new rule)
 */
import { asTrimmedString, timestampMs } from './format';
import { isAuthoritativelyClosed } from './lifecycle';
import { canonicalDriverIdFromRecords } from './identity';
import type { InvoiceSourceRecord, PaperCaller, TicketSourceRecord } from './types';

export const PAPER_ACTOR_POLICY_VERSION = 'canonical-paper-actor-routing.v1';
export const DRIVER_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PaperPresentationMode = 'edit_form' | 'canonical_paper' | 'read_only_detail';

export type PaperPresentationDecision = {
  ok: true;
  mode: PaperPresentationMode;
  canEdit: boolean;
  reason: string;
  evaluatedAtMs: number;
  policyVersion: string;
  previewAvailable: boolean;
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

/** Invoice createdAt || closedAt — same origin as WB-T updateTicket. */
export function driverEditWindowOriginMs(
  invoice: InvoiceSourceRecord | Record<string, unknown> | null | undefined,
): number | null {
  if (!invoice) return null;
  const rec = invoice as Record<string, unknown>;
  return timestampMs(rec.createdAtMs)
    || timestampMs(rec.createdAt)
    || timestampMs(rec.closedAtMs)
    || timestampMs(rec.closedAt);
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

/**
 * Server-side mutation gate. Hiding the form is not enforcement.
 * Dashboard dispatch/payroll ticket-field mutation is policy_undefined (deny).
 * WB-T updateTicket remains the live driver enforcement point (not edited here).
 */
export function assertActorMayMutateTicket(input: {
  caller: PaperCaller;
  ticket: TicketSourceRecord;
  invoice: InvoiceSourceRecord | null;
  nowMs: number;
}): { ok: true; via: string } | { ok: false; reason: string; message: string } {
  const nowMs = input.nowMs;
  if (input.caller.kind === 'system') {
    return { ok: false, reason: 'unauthorized', message: 'System callers do not mutate tickets.' };
  }
  if (input.caller.isPlatformAdmin && input.caller.kind === 'dashboard') {
    return { ok: true, via: 'admin' };
  }
  if (input.caller.kind === 'dashboard') {
    return {
      ok: false,
      reason: 'policy_undefined',
      message: 'No governed dispatch/payroll/billing ticket-edit window exists.',
    };
  }
  if (input.caller.kind !== 'driver') {
    return { ok: false, reason: 'unauthorized', message: 'Caller cannot mutate this ticket.' };
  }
  if (!driverOwnsTicket(input.caller, input.ticket, input.invoice)) {
    return { ok: false, reason: 'not_ticket_owner', message: 'Driver may only edit their own ticket.' };
  }
  const originMs = driverEditWindowOriginMs(input.invoice);
  if (originMs == null) {
    return { ok: false, reason: 'edit_window_unknown', message: 'Edit window origin is unresolvable.' };
  }
  if (nowMs - originMs >= DRIVER_EDIT_WINDOW_MS) {
    return { ok: false, reason: 'edit_window_expired', message: 'Driver correction window has expired.' };
  }
  return { ok: true, via: 'owner' };
}

export function evaluatePaperPresentation(input: {
  caller: PaperCaller;
  ticket: TicketSourceRecord;
  invoice: InvoiceSourceRecord | null;
  nowMs: number;
  artifact?: { artifactId: string; currentRevisionId: string } | null;
}): PaperPresentationDecision {
  const evaluatedAtMs = input.nowMs;
  const policyVersion = PAPER_ACTOR_POLICY_VERSION;
  const closed = isAuthoritativelyClosed(input.invoice);
  const paperMeta = input.artifact?.currentRevisionId
    ? { artifactId: input.artifact.artifactId, revisionId: input.artifact.currentRevisionId }
    : {};

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
    const originMs = driverEditWindowOriginMs(input.invoice);
    const expiresAtMs = originMs != null ? originMs + DRIVER_EDIT_WINDOW_MS : null;
    const withinWindow = originMs != null && evaluatedAtMs - originMs < DRIVER_EDIT_WINDOW_MS;
    if (!closed) {
      return {
        ok: true,
        mode: 'edit_form',
        canEdit: true,
        reason: 'driver_open_job',
        evaluatedAtMs,
        policyVersion,
        previewAvailable: false,
        windowOriginMs: originMs,
        windowExpiresAtMs: expiresAtMs,
      };
    }
    if (withinWindow) {
      return {
        ok: true,
        mode: 'edit_form',
        canEdit: true,
        reason: 'driver_correction_window',
        evaluatedAtMs,
        policyVersion,
        previewAvailable: true,
        windowOriginMs: originMs,
        windowExpiresAtMs: expiresAtMs,
        ...paperMeta,
      };
    }
    return {
      ok: true,
      mode: 'canonical_paper',
      canEdit: false,
      reason: 'edit_window_expired',
      evaluatedAtMs,
      policyVersion,
      previewAvailable: true,
      windowOriginMs: originMs,
      windowExpiresAtMs: expiresAtMs,
      ...paperMeta,
    };
  }

  if (input.caller.kind === 'dashboard' && input.caller.isPlatformAdmin) {
    return {
      ok: true,
      mode: 'edit_form',
      canEdit: true,
      reason: 'privileged_admin',
      evaluatedAtMs,
      policyVersion,
      previewAvailable: closed,
      ...paperMeta,
    };
  }

  if (input.caller.kind === 'dashboard') {
    const role = (input.caller.roles || [])[0] || 'dashboard';
    if (!closed) {
      return {
        ok: true,
        mode: 'read_only_detail',
        canEdit: false,
        reason: 'open_job_unproven_edit',
        evaluatedAtMs,
        policyVersion,
        previewAvailable: false,
      };
    }
    return {
      ok: false,
      reason: 'policy_undefined',
      message: 'No governed dispatch/payroll/billing ticket-edit window exists.',
      canEdit: false,
      evaluatedAtMs,
      policyVersion,
      gap: `${role}_ticket_edit_window`,
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
  return asTrimmedString((caller.roles || [])[0]) || 'dashboard';
}
