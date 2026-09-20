import { fail } from './jobPacketRevisionStore';
import { parseDispatchId, requireCompleteBinding } from './dispatchPacketPin';

export const ACCEPT_DRIVER_DISPATCH_CALLABLE = 'acceptDriverDispatch';
export const ACCEPTABLE_FROM = Object.freeze(['pending', 'paused', 'accepted', 'in_progress'] as const);
export const ACCEPT_TARGETS = Object.freeze(['accepted', 'in_progress'] as const);

export type AcceptDecision =
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
    }
  | { ok: false; reason: string; field?: string };

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function isTarget(v: unknown): v is 'accepted' | 'in_progress' {
  return v === 'accepted' || v === 'in_progress';
}

export function evaluateAcceptDriverDispatch(input: {
  dispatchId: unknown;
  caller: { driverId: string; companyId: string } | null;
  existing: Record<string, unknown> | null;
  invoiceDocId?: unknown;
  invoiceNumber?: unknown;
  targetStatus?: unknown;
}): AcceptDecision {
  const id = parseDispatchId(input.dispatchId);
  if (!id.ok) return id;
  const driverId = str(input.caller?.driverId);
  const companyId = str(input.caller?.companyId);
  if (!driverId || !companyId) return fail('unauthenticated_driver');
  if (!input.existing) return fail('not_found');
  const bound = requireCompleteBinding(input.existing);
  if (!bound.ok) return bound;
  const jobCompany = str(input.existing.companyId);
  if (!jobCompany || jobCompany !== companyId) return fail('wrong_company');
  const assigned = str(input.existing.driverId);
  if (!assigned || assigned !== driverId) return fail('other_driver');

  const from = str(input.existing.status).toLowerCase() || 'pending';
  if (!(ACCEPTABLE_FROM as readonly string[]).includes(from)) return fail('invalid_status', from);

  const requested = isTarget(input.targetStatus) ? input.targetStatus : 'accepted';
  let status: 'accepted' | 'in_progress' = requested;
  if (from === 'paused' && requested === 'accepted') status = 'in_progress';
  if (from === 'in_progress') status = 'in_progress';
  if (from === 'accepted' && requested === 'accepted') status = 'accepted';

  const invoiceDocId = str(input.invoiceDocId) || undefined;
  const invoiceNumber = str(input.invoiceNumber) || undefined;
  const existingInvoice = str(input.existing.invoiceDocId);
  if (invoiceDocId && existingInvoice && existingInvoice !== invoiceDocId) {
    return fail('invoice_conflict');
  }

  const already =
    (from === 'accepted' && status === 'accepted') ||
    (from === 'in_progress' && status === 'in_progress');
  const loads = typeof input.existing.loadsCompleted === 'number' && Number.isFinite(input.existing.loadsCompleted)
    ? Math.max(0, Math.trunc(input.existing.loadsCompleted))
    : 0;
  const firstStart = from === 'pending' || from === 'paused';
  return {
    ok: true,
    result: already ? 'already_accepted' : 'accepted',
    status,
    loadsCompleted: firstStart && !already ? loads + 1 : loads,
    incrementLoads: firstStart && !already,
    stampAcceptedAt: !input.existing.acceptedAt,
    stampStartedAt: status === 'in_progress',
    invoiceDocId: invoiceDocId || existingInvoice || undefined,
    invoiceNumber: invoiceNumber || str(input.existing.invoiceNumber) || undefined,
  };
}

export const ACCEPT_REQUEST_KEYS = Object.freeze([
  'dispatchId',
  'invoiceDocId',
  'invoiceNumber',
  'targetStatus',
] as const);
