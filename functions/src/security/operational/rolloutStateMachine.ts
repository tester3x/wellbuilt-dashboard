// rolloutStateMachine.ts — the FAIL-CLOSED quiescence state machine for the
// staged WB-M rollout (predeploy gate Rev-3 item 5). Pure decision function:
// once PAUSE_REQUESTED begins, NOTHING reopens admission automatically. Only an
// explicit `verify` event carrying affirmative proof (all four consumer
// functions on the reviewed revision, no coordinator lock held, incoming
// empty) can return to OPEN. Every failure / timeout / interrupt / unknown
// input from a closed state routes to HELD_CLOSED.
export type RolloutState =
  | 'OPEN'
  | 'PAUSE_REQUESTED'
  | 'DRAINING'
  | 'DRAINED_180'
  | 'CONSUMERS_DEPLOYING'
  | 'VERIFYING'
  | 'HELD_CLOSED';

export type RolloutEvent =
  | { type: 'pause_requested' }
  | { type: 'drain_started' }
  | { type: 'drain_confirmed'; incomingEmpty: boolean; noLock: boolean }
  | { type: 'horizon_elapsed'; elapsedMs: number }
  | { type: 'deploy_consumers_started' }
  | { type: 'deploy_consumers_result'; ok: boolean }
  | { type: 'verify'; allConsumerRevsMatch: boolean; noLock: boolean; incomingEmpty: boolean }
  | { type: 'interrupt' }          // terminal closed / Ctrl-C / operator abort
  | { type: 'read_failed' }
  | { type: 'timeout' }
  | { type: 'revision_unknown' };

export const HORIZON_MS = 180_000; // 120s trigger timeout + 60s recovery margin

/** Admission is OPEN only in the OPEN state; every other state is CLOSED. */
export function admissionClosed(state: RolloutState): boolean {
  return state !== 'OPEN';
}

/** Reopening requires ALL affirmative proofs. */
export function canReopen(ev: Extract<RolloutEvent, { type: 'verify' }>): boolean {
  return ev.allConsumerRevsMatch === true && ev.noLock === true && ev.incomingEmpty === true;
}

/**
 * Pure transition. Unknown/failure inputs from any CLOSED state fail closed to
 * HELD_CLOSED — never back to OPEN. From HELD_CLOSED, only a fresh `verify` with
 * full proof (a deliberate operator confirmation) can reopen.
 */
export function nextRolloutState(state: RolloutState, ev: RolloutEvent): RolloutState {
  // Global fail-closed: any interrupt/timeout/read-failure/unknown-revision
  // while NOT already OPEN parks in HELD_CLOSED.
  if (state !== 'OPEN' && (ev.type === 'interrupt' || ev.type === 'timeout' || ev.type === 'read_failed' || ev.type === 'revision_unknown')) {
    return 'HELD_CLOSED';
  }
  switch (state) {
    case 'OPEN':
      // Interrupts while open are harmless (nothing started). Only an explicit
      // pause request moves off OPEN.
      return ev.type === 'pause_requested' ? 'PAUSE_REQUESTED' : 'OPEN';
    case 'PAUSE_REQUESTED':
      return ev.type === 'drain_started' ? 'DRAINING' : 'PAUSE_REQUESTED';
    case 'DRAINING':
      if (ev.type === 'drain_confirmed') return ev.incomingEmpty && ev.noLock ? 'DRAINED_180' : 'DRAINING';
      return 'DRAINING';
    case 'DRAINED_180':
      // The horizon wait is a guard; only a ≥180s elapsed lets consumers deploy.
      if (ev.type === 'horizon_elapsed') return ev.elapsedMs >= HORIZON_MS ? 'DRAINED_180' : 'DRAINED_180';
      if (ev.type === 'deploy_consumers_started') return 'CONSUMERS_DEPLOYING';
      return 'DRAINED_180';
    case 'CONSUMERS_DEPLOYING':
      if (ev.type === 'deploy_consumers_result') return ev.ok ? 'VERIFYING' : 'HELD_CLOSED';
      return 'CONSUMERS_DEPLOYING';
    case 'VERIFYING':
      if (ev.type === 'verify') return canReopen(ev) ? 'OPEN' : 'HELD_CLOSED';
      return 'VERIFYING';
    case 'HELD_CLOSED':
      // The ONLY escape is a deliberate, fully-proven verify.
      if (ev.type === 'verify') return canReopen(ev) ? 'OPEN' : 'HELD_CLOSED';
      return 'HELD_CLOSED';
    default:
      return 'HELD_CLOSED';
  }
}

/** Whether the operator may attempt to deploy consumers (Stage C) yet. */
export function mayDeployConsumers(state: RolloutState, horizonElapsedMs: number): boolean {
  return state === 'DRAINED_180' && horizonElapsedMs >= HORIZON_MS;
}
