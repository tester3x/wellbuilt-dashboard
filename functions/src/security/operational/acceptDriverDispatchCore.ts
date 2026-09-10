/**
 * Governed driver accept/start. Not upsertDriverDispatch (merge-upsert).
 *
 * pending|paused → accepted|in_progress. Same-driver retry is idempotent.
 * Company and canonical driverId are auth-only. Hash-only staff assignments
 * (driverId missing, driverHash ≠ caller UUID) are not claimed here.
 */

export const ACCEPT_DRIVER_DISPATCH_CALLABLE = 'acceptDriverDispatch';

export const ACCEPTABLE_FROM = ['pending', 'paused', 'accepted', 'in_progress'] as const;
export const ACCEPT_TARGETS = ['accepted', 'in_progress'] as const;

export type AcceptDriverDispatchCaller = {
  driverId: string;
  companyId: string;
};

export type AcceptDriverDispatchExisting = {
  driverId?: unknown;
  driverHash?: unknown;
  companyId?: unknown;
  status?: unknown;
  loadsCompleted?: unknown;
  loadCount?: unknown;
  acceptedAt?: unknown;
  invoiceDocId?: unknown;
  invoiceNumber?: unknown;
} | null;

export type AcceptDriverDispatchDecision =
  | {
      ok: true;
      result: 'accepted' | 'already_accepted';
      status: 'accepted' | 'in_progress';
      loadsCompleted: number;
      incrementLoads: boolean;
      stampAcceptedAt: boolean;
      stampStartedAt: boolean;
      invoiceDocId?: string;
      invoiceNumber?: string;
      stampDriverId: boolean;
    }
  | { ok: false; reason: string };

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function statusOf(v: unknown): string {
  return str(v).toLowerCase();
}

export function isAcceptTargetStatus(v: unknown): v is 'accepted' | 'in_progress' {
  return v === 'accepted' || v === 'in_progress';
}

export function dispatchAssignedToCaller(
  existing: AcceptDriverDispatchExisting,
  caller: AcceptDriverDispatchCaller,
): boolean {
  if (!existing) return false;
  const driverId = str(existing.driverId);
  const hash = str(existing.driverHash);
  if (driverId) return driverId === caller.driverId;
  // VC96 field jobs stamp UUID into driverHash when driverId is also UUID.
  // Do not treat a 64-char approved SHA as the canonical driver.
  return hash === caller.driverId;
}

export function evaluateAcceptDriverDispatch(input: {
  dispatchId: string;
  caller: AcceptDriverDispatchCaller | null | undefined;
  existing: AcceptDriverDispatchExisting;
  invoiceDocId?: unknown;
  invoiceNumber?: unknown;
  targetStatus?: unknown;
}): AcceptDriverDispatchDecision {
  const dispatchId = str(input.dispatchId);
  if (!dispatchId) return { ok: false, reason: 'dispatchId_required' };
  const driverId = str(input.caller?.driverId);
  const companyId = str(input.caller?.companyId);
  if (!driverId || !companyId) return { ok: false, reason: 'unauthenticated_driver' };

  const existing = input.existing;
  if (!existing) return { ok: false, reason: 'not_found' };

  const jobCompany = str(existing.companyId);
  if (!jobCompany || jobCompany !== companyId) {
    return { ok: false, reason: 'wrong_company' };
  }

  if (!dispatchAssignedToCaller(existing, { driverId, companyId })) {
    return { ok: false, reason: 'other_driver' };
  }

  const from = statusOf(existing.status) || 'pending';
  if (!(ACCEPTABLE_FROM as readonly string[]).includes(from)) {
    return { ok: false, reason: 'invalid_status' };
  }

  const requested = isAcceptTargetStatus(input.targetStatus) ? input.targetStatus : 'accepted';
  let status: 'accepted' | 'in_progress' = requested;
  if (from === 'paused' && requested === 'accepted') status = 'in_progress';
  if (from === 'in_progress') status = 'in_progress';
  if (from === 'accepted' && requested === 'accepted') status = 'accepted';

  const invoiceDocId = str(input.invoiceDocId) || undefined;
  const invoiceNumber = str(input.invoiceNumber) || undefined;
  const existingInvoice = str(existing.invoiceDocId);
  if (invoiceDocId && existingInvoice && existingInvoice !== invoiceDocId) {
    return { ok: false, reason: 'invoice_conflict' };
  }

  const already =
    (from === 'accepted' && status === 'accepted') ||
    (from === 'in_progress' && status === 'in_progress');

  const loads = typeof existing.loadsCompleted === 'number' && Number.isFinite(existing.loadsCompleted)
    ? Math.max(0, Math.trunc(existing.loadsCompleted))
    : 0;
  const firstStart = from === 'pending' || from === 'paused';
  const incrementLoads = firstStart && !already;

  return {
    ok: true,
    result: already ? 'already_accepted' : 'accepted',
    status,
    loadsCompleted: incrementLoads ? loads + 1 : loads,
    incrementLoads,
    stampAcceptedAt: !existing.acceptedAt,
    stampStartedAt: status === 'in_progress',
    invoiceDocId: invoiceDocId || existingInvoice || undefined,
    invoiceNumber: invoiceNumber || str(existing.invoiceNumber) || undefined,
    stampDriverId: !str(existing.driverId),
  };
}
