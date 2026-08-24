/**
 * Governed Safety actions. Dashboard never writes spill_incidents directly.
 * If callables are not deployed, UI is disabled and payloads are still typed.
 */

export const SPILL_ACTION_CALLABLES = {
  acknowledge: 'acknowledgeSpillIncident',
  assignOwner: 'assignSpillIncidentOwner',
  addNote: 'addSpillIncidentFollowUp',
  resolve: 'resolveSpillIncident',
  close: 'closeSpillIncident',
  reopen: 'reopenSpillIncident',
  updatePolicy: 'updateSpillNotificationPolicy',
} as const;

export type SpillActionType = keyof typeof SPILL_ACTION_CALLABLES;

/** Flip only when the matching callable is actually deployed. All false today. */
export const SPILL_ACTION_CALLABLES_AVAILABLE: Record<SpillActionType, boolean> = {
  acknowledge: false,
  assignOwner: false,
  addNote: false,
  resolve: false,
  close: false,
  reopen: false,
  updatePolicy: false,
};

export type SpillAction =
  | { type: 'acknowledge'; companyId: string; incidentId: string; reason?: string }
  | { type: 'assignOwner'; companyId: string; incidentId: string; ownerEmployeeId: string; reason?: string }
  | { type: 'addNote'; companyId: string; incidentId: string; note: string }
  | { type: 'resolve'; companyId: string; incidentId: string; reason?: string }
  | { type: 'close'; companyId: string; incidentId: string; reason?: string }
  | { type: 'reopen'; companyId: string; incidentId: string; reason: string };

export interface SpillActionAudit {
  action: SpillActionType;
  actorUid: string;
  actorName: string | null;
  atIso: string;
  reason: string | null;
  priorStatus: string;
  resultingStatus: string;
  companyId: string;
  incidentId: string;
}

/** Reconciled with WB-T spillBackendCore: open may resolve; notes/assign keep status. */
const NEXT: Record<string, Partial<Record<SpillActionType, string>>> = {
  open: { acknowledge: 'acknowledged', resolve: 'resolved', assignOwner: 'open', addNote: 'open' },
  acknowledged: { acknowledge: 'acknowledged', resolve: 'resolved', assignOwner: 'acknowledged', addNote: 'acknowledged' },
  resolved: { addNote: 'resolved', close: 'closed', reopen: 'open', assignOwner: 'resolved' },
  closed: { reopen: 'open' },
};

export function isSpillActionAvailable(type: SpillActionType): boolean {
  return SPILL_ACTION_CALLABLES_AVAILABLE[type] === true;
}

export function spillActionDisabledReason(type: SpillActionType): string | null {
  if (isSpillActionAvailable(type)) return null;
  return `${SPILL_ACTION_CALLABLES[type]} is not deployed`;
}

export function resultingStatusFor(priorStatus: string, type: SpillActionType): string | null {
  const prior = String(priorStatus || 'open').toLowerCase();
  const mapped = prior === 'accepted' || prior === 'submitted' || prior === 'queued' ? 'open' : prior;
  return NEXT[mapped]?.[type] ?? null;
}

export function validateSpillAction(action: SpillAction, priorStatus: string): { ok: true } | { ok: false; error: string } {
  if (!action.companyId?.trim() || !action.incidentId?.trim()) {
    return { ok: false, error: 'companyId and incidentId are required' };
  }
  if (action.type === 'reopen' && !String(action.reason || '').trim()) {
    return { ok: false, error: 'reopen requires a reason' };
  }
  if (action.type === 'addNote' && !String(action.note || '').trim()) {
    return { ok: false, error: 'follow-up note is empty' };
  }
  if (action.type === 'assignOwner' && !String(action.ownerEmployeeId || '').trim()) {
    return { ok: false, error: 'owner employee is required' };
  }
  if (!resultingStatusFor(priorStatus, action.type)) {
    return { ok: false, error: `cannot ${action.type} from ${priorStatus}` };
  }
  return { ok: true };
}

export function buildSpillActionAudit(
  action: SpillAction,
  actor: { uid: string; name?: string | null },
  priorStatus: string,
  atIso: string,
): SpillActionAudit {
  const resulting = resultingStatusFor(priorStatus, action.type) || priorStatus;
  const reason = 'reason' in action ? (action.reason ?? null) : action.type === 'addNote' ? action.note : null;
  return {
    action: action.type,
    actorUid: actor.uid,
    actorName: actor.name ?? null,
    atIso,
    reason,
    priorStatus,
    resultingStatus: resulting,
    companyId: action.companyId,
    incidentId: action.incidentId,
  };
}

export function buildSpillActionCallablePayload(action: SpillAction, audit: SpillActionAudit): Record<string, unknown> {
  return {
    companyId: action.companyId,
    incidentId: action.incidentId,
    action: action.type,
    reason: audit.reason,
    priorStatus: audit.priorStatus,
    resultingStatus: audit.resultingStatus,
    actorUid: audit.actorUid,
    atIso: audit.atIso,
    ...(action.type === 'assignOwner' ? { ownerEmployeeId: action.ownerEmployeeId } : {}),
    ...(action.type === 'addNote' ? { note: action.note } : {}),
    expectedRevision: (action as { expectedRevision?: number }).expectedRevision,
  };
}

export const REQUIRED_SPILL_ACTION_CONTRACTS = Object.entries(SPILL_ACTION_CALLABLES).map(([type, callable]) => ({
  type,
  callable,
  deployed: SPILL_ACTION_CALLABLES_AVAILABLE[type as SpillActionType],
  notes: 'Idempotent by incidentId+action+atIso. Must append audit { actorUid, atIso, reason, priorStatus, resultingStatus }. Tenant: caller.companyId must match incident.companyId unless platform admin.',
}));
