/**
 * Staff dismiss of a declined/cancelled dispatch.
 *
 * Terminal write is status:'dismissed' only. Decline history is never
 * cleared. Documents are never deleted. Split families are inspected
 * first: any accepted/in_progress/paused sibling blocks the whole family.
 */

export const DISMISSABLE_STATUSES = ['declined', 'cancelled'] as const;
export const STARTED_STATUSES = ['accepted', 'in_progress', 'paused'] as const;

export type DispatchDismissView = {
  id: string;
  status?: unknown;
  companyId?: unknown;
  splitGroupId?: unknown;
  declinedAt?: unknown;
  declinedBy?: unknown;
  declineReason?: unknown;
  dismissedAt?: unknown;
  dismissedBy?: unknown;
};

export type DismissDispatchResult =
  | {
      ok: true;
      idempotent: boolean;
      dispatchIds: string[];
      preserveDecline: true;
    }
  | { ok: false; reason: string };

function statusOf(job: DispatchDismissView): string {
  return typeof job.status === 'string' ? job.status : '';
}

function isStarted(status: string): boolean {
  return (STARTED_STATUSES as readonly string[]).includes(status);
}

function isDismissable(status: string): boolean {
  return (DISMISSABLE_STATUSES as readonly string[]).includes(status);
}

export function evaluateDismissDispatch(input: {
  job: DispatchDismissView | null;
  siblings: DispatchDismissView[];
  callerCompanyId?: string;
  isPlatformAdmin: boolean;
}): DismissDispatchResult {
  if (!input.job || !input.job.id) return { ok: false, reason: 'unknown_dispatch' };
  const job = input.job;
  const companyId = typeof job.companyId === 'string' ? job.companyId.trim() : '';
  if (!companyId) return { ok: false, reason: 'unscoped_dispatch' };
  if (!input.isPlatformAdmin) {
    const callerCompany = (input.callerCompanyId || '').trim();
    if (!callerCompany || callerCompany !== companyId) {
      return { ok: false, reason: 'cross_company' };
    }
  }

  const st = statusOf(job);
  if (st === 'dismissed') {
    return { ok: true, idempotent: true, dispatchIds: [job.id], preserveDecline: true };
  }
  if (isStarted(st)) return { ok: false, reason: 'job_in_progress' };
  if (!isDismissable(st)) return { ok: false, reason: 'not_dismissable' };

  const splitGroupId = typeof job.splitGroupId === 'string' ? job.splitGroupId.trim() : '';
  const family = splitGroupId
    ? [job, ...input.siblings.filter((s) => s.id && s.id !== job.id)]
    : [job];

  if (family.some((s) => isStarted(statusOf(s)))) {
    return { ok: false, reason: 'family_in_progress' };
  }

  const dispatchIds = family
    .filter((s) => {
      const sStatus = statusOf(s);
      return sStatus === 'dismissed' || isDismissable(sStatus) || sStatus === 'pending' || sStatus === 'pending_approval';
    })
    .map((s) => s.id);

  if (!dispatchIds.includes(job.id)) dispatchIds.unshift(job.id);

  return {
    ok: true,
    idempotent: false,
    dispatchIds: [...new Set(dispatchIds)],
    preserveDecline: true,
  };
}

export function dismissPatch(nowMs: number, dismissedBy: string): Record<string, unknown> {
  return {
    status: 'dismissed',
    dismissedAt: nowMs,
    dismissedBy,
  };
}
