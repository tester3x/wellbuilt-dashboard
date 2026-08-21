export type DispatchCardActionKind = 'cancel' | 'dismiss' | 'none' | 'error';

export type DispatchCardAction =
  | { kind: 'cancel'; label: 'Cancel dispatch'; confirmVerb: 'cancel' }
  | { kind: 'dismiss'; label: 'Dismiss dispatch'; confirmVerb: 'dismiss' }
  | { kind: 'none' }
  | { kind: 'error'; reason: string; label: 'Unknown status' };

const CANCEL_STATUSES = ['pending', 'pending_approval', 'accepted', 'in_progress', 'paused'] as const;
const DISMISS_STATUSES = ['declined', 'cancelled'] as const;
const HIDDEN_STATUSES = ['completed', 'dismissed'] as const;

export function resolveDispatchCardAction(status: string | undefined): DispatchCardAction {
  const st = typeof status === 'string' ? status.trim() : '';
  if ((CANCEL_STATUSES as readonly string[]).includes(st)) {
    return { kind: 'cancel', label: 'Cancel dispatch', confirmVerb: 'cancel' };
  }
  if ((DISMISS_STATUSES as readonly string[]).includes(st)) {
    return { kind: 'dismiss', label: 'Dismiss dispatch', confirmVerb: 'dismiss' };
  }
  if ((HIDDEN_STATUSES as readonly string[]).includes(st) || !st) {
    return { kind: 'none' };
  }
  return { kind: 'error', reason: `unknown_status:${st}`, label: 'Unknown status' };
}

export function dispatchCardConfirmCopy(input: {
  well: string;
  driver: string;
  status: string;
  action: Extract<DispatchCardAction, { kind: 'cancel' | 'dismiss' }>;
}): string {
  const result = input.action.kind === 'cancel'
    ? 'This will cancel the job (status → cancelled).'
    : 'This will dismiss the job (status → dismissed).';
  return `${input.action.label}\n\nWell: ${input.well}\nDriver: ${input.driver}\nCurrent status: ${input.status}\n\n${result}`;
}
