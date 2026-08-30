import {
  nextRolloutState,
  admissionClosed,
  canReopen,
  mayDeployConsumers,
  HORIZON_MS,
  type RolloutState,
  type RolloutEvent,
} from '../rolloutStateMachine';

/** Drive the machine along the nominal happy path, returning the state list. */
function happyPath(): RolloutState[] {
  const seq: RolloutEvent[] = [
    { type: 'pause_requested' },
    { type: 'drain_started' },
    { type: 'drain_confirmed', incomingEmpty: true, noLock: true },
    { type: 'deploy_consumers_started' },
    { type: 'deploy_consumers_result', ok: true },
    { type: 'verify', allConsumerRevsMatch: true, noLock: true, incomingEmpty: true },
  ];
  const states: RolloutState[] = ['OPEN'];
  let s: RolloutState = 'OPEN';
  for (const ev of seq) {
    s = nextRolloutState(s, ev);
    states.push(s);
  }
  return states;
}

describe('rollout state machine — nominal path', () => {
  it('walks OPEN → … → OPEN only through a full-proof verify', () => {
    expect(happyPath()).toEqual([
      'OPEN',
      'PAUSE_REQUESTED',
      'DRAINING',
      'DRAINED_180',
      'CONSUMERS_DEPLOYING',
      'VERIFYING',
      'OPEN',
    ]);
  });

  it('admission is closed in every non-OPEN state', () => {
    const closed: RolloutState[] = ['PAUSE_REQUESTED', 'DRAINING', 'DRAINED_180', 'CONSUMERS_DEPLOYING', 'VERIFYING', 'HELD_CLOSED'];
    for (const s of closed) expect(admissionClosed(s)).toBe(true);
    expect(admissionClosed('OPEN')).toBe(false);
  });
});

describe('rollout state machine — FAIL CLOSED after every transition', () => {
  // Every state the operator can be interrupted in AFTER pausing. An interrupt,
  // a timeout, a read failure, or an unknown revision must never auto-reopen.
  const interruptibleClosedStates: RolloutState[] = [
    'PAUSE_REQUESTED',
    'DRAINING',
    'DRAINED_180',
    'CONSUMERS_DEPLOYING',
    'VERIFYING',
    'HELD_CLOSED',
  ];
  const disruptions: RolloutEvent[] = [
    { type: 'interrupt' },
    { type: 'timeout' },
    { type: 'read_failed' },
    { type: 'revision_unknown' },
  ];

  for (const s of interruptibleClosedStates) {
    for (const ev of disruptions) {
      it(`${s} + ${ev.type} → HELD_CLOSED (never OPEN)`, () => {
        const next = nextRolloutState(s, ev);
        expect(next).toBe('HELD_CLOSED');
        expect(admissionClosed(next)).toBe(true);
      });
    }
  }

  it('an interrupt while OPEN is harmless (nothing had started)', () => {
    expect(nextRolloutState('OPEN', { type: 'interrupt' })).toBe('OPEN');
  });

  it('a failed consumer deploy holds closed, does not reopen', () => {
    expect(nextRolloutState('CONSUMERS_DEPLOYING', { type: 'deploy_consumers_result', ok: false })).toBe('HELD_CLOSED');
  });

  it('a verify with ANY missing proof holds closed', () => {
    const partials: RolloutEvent[] = [
      { type: 'verify', allConsumerRevsMatch: false, noLock: true, incomingEmpty: true },
      { type: 'verify', allConsumerRevsMatch: true, noLock: false, incomingEmpty: true },
      { type: 'verify', allConsumerRevsMatch: true, noLock: true, incomingEmpty: false },
    ];
    for (const ev of partials) {
      expect(nextRolloutState('VERIFYING', ev)).toBe('HELD_CLOSED');
      expect(nextRolloutState('HELD_CLOSED', ev)).toBe('HELD_CLOSED');
    }
  });

  it('HELD_CLOSED only escapes via a full-proof verify', () => {
    expect(nextRolloutState('HELD_CLOSED', { type: 'pause_requested' })).toBe('HELD_CLOSED');
    expect(nextRolloutState('HELD_CLOSED', { type: 'deploy_consumers_started' })).toBe('HELD_CLOSED');
    expect(nextRolloutState('HELD_CLOSED', { type: 'verify', allConsumerRevsMatch: true, noLock: true, incomingEmpty: true })).toBe('OPEN');
  });
});

describe('rollout state machine — guards', () => {
  it('drain only advances when incoming empty AND no lock', () => {
    expect(nextRolloutState('DRAINING', { type: 'drain_confirmed', incomingEmpty: false, noLock: true })).toBe('DRAINING');
    expect(nextRolloutState('DRAINING', { type: 'drain_confirmed', incomingEmpty: true, noLock: false })).toBe('DRAINING');
    expect(nextRolloutState('DRAINING', { type: 'drain_confirmed', incomingEmpty: true, noLock: true })).toBe('DRAINED_180');
  });

  it('consumers may deploy only after the full 180s horizon in DRAINED_180', () => {
    expect(mayDeployConsumers('DRAINED_180', HORIZON_MS - 1)).toBe(false);
    expect(mayDeployConsumers('DRAINED_180', HORIZON_MS)).toBe(true);
    expect(mayDeployConsumers('DRAINING', HORIZON_MS + 5000)).toBe(false);
  });

  it('canReopen requires all three affirmative proofs', () => {
    expect(canReopen({ type: 'verify', allConsumerRevsMatch: true, noLock: true, incomingEmpty: true })).toBe(true);
    expect(canReopen({ type: 'verify', allConsumerRevsMatch: true, noLock: true, incomingEmpty: false })).toBe(false);
  });
});
