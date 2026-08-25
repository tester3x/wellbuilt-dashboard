import {
  applyStatePath,
  buildCapturedApplyState,
  decideAcquireLease,
  decideAdvancePhase,
  decideLedgerClaim,
  decidePublicVersionAdvance,
  decideReleaseLease,
  eventHasVersionClaim,
  inferPhaseFromHistory,
  mergeMonotonic,
  parseApplyState,
  parseVersionLedger,
  phaseAtLeast,
  shouldRetriggerEditIncoming,
  withPhase,
  type GovernedEditApplyState,
} from '../governedEditApplyState';

function captured(over: Partial<GovernedEditApplyState> = {}): GovernedEditApplyState {
  return {
    ...buildCapturedApplyState({
      editEventId: 'e1',
      originalPacketId: 'p1',
      incomingId: 'e1',
      payloadDigest: 'abc',
      wellName: 'Gabriel 5',
      noLevel: false,
      now: 't0',
    }),
    ...over,
  };
}

describe('governedEditApplyState', () => {
  it('captured state has no terminal flags', () => {
    const s = captured();
    expect(s.phase).toBe('captured');
    expect(s.historyWritten).toBe(false);
    expect(s.versionPublished).toBe(false);
    expect(applyStatePath('e1')).toBe('packets/editApplyState/e1');
    expect(phaseAtLeast(s, 'mutated')).toBe(false);
    expect(phaseAtLeast(withPhase(s, 'mutated', { historyWritten: true, processedWritten: true }, 't1'), 'mutated')).toBe(true);
  });

  it('infers mutated from proven history when checkpoint lagged', () => {
    expect(inferPhaseFromHistory({
      state: null,
      historyDigest: 'abc',
      incomingDigest: 'abc',
      acceptedReceipt: false,
    })).toBe('mutated');
    expect(inferPhaseFromHistory({
      state: null,
      historyDigest: 'abc',
      incomingDigest: 'abc',
      acceptedReceipt: true,
    })).toBe('terminal');
    expect(inferPhaseFromHistory({
      state: null,
      historyDigest: 'other',
      incomingDigest: 'abc',
      acceptedReceipt: false,
    })).toBeNull();
  });

  it('eventHasVersionClaim is event-specific and ignores global counter movement', () => {
    expect(eventHasVersionClaim({
      assignedVersion: 4,
      publishedVersion: null,
    })).toEqual({ done: true, seq: 4 });
    expect(eventHasVersionClaim({
      assignedVersion: null,
      publishedVersion: 4,
    })).toEqual({ done: true, seq: 4 });
    expect(eventHasVersionClaim({
      assignedVersion: null,
      publishedVersion: null,
    })).toEqual({ done: false });
  });

  it('ledger assigns once, reuses same digest, conflicts on different digest', () => {
    const first = decideLedgerClaim({
      ledger: { nextSeq: 10, claims: {} },
      editEventId: 'e1',
      payloadDigest: 'abc',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.seq).toBe(11);
    expect(first.reused).toBe(false);
    const reuse = decideLedgerClaim({
      ledger: first.ledger,
      editEventId: 'e1',
      payloadDigest: 'abc',
    });
    expect(reuse).toEqual({ ok: true, ledger: first.ledger, seq: 11, reused: true });
    const other = decideLedgerClaim({
      ledger: first.ledger,
      editEventId: 'e2',
      payloadDigest: 'def',
    });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.seq).toBe(12);
    expect(decideLedgerClaim({
      ledger: first.ledger,
      editEventId: 'e1',
      payloadDigest: 'zzz',
    })).toEqual({ ok: false, reason: 'edit_event_payload_conflict' });
  });

  it('public incoming_version advances to at least the assigned seq and never drops', () => {
    expect(decidePublicVersionAdvance(0, 1)).toBe(1);
    expect(decidePublicVersionAdvance(11, 10)).toBe(11);
    expect(decidePublicVersionAdvance(11, 12)).toBe(12);
  });

  it('parseVersionLedger accepts empty and compact claims', () => {
    expect(parseVersionLedger(null)).toEqual({ nextSeq: 0, claims: {} });
    expect(parseVersionLedger({
      nextSeq: 2,
      claims: { e1: { editEventId: 'e1', payloadDigest: 'abc', seq: 1 } },
    }).claims.e1.seq).toBe(1);
  });

  it('acquire lease: first writer wins; busy while held; conflict on digest; terminal is terminal', () => {
    const candidate = captured();
    const first = decideAcquireLease({
      current: null,
      candidate,
      ownerId: 'A',
      nowMs: 1000,
      leaseMs: 30_000,
    });
    expect(first.action).toBe('acquired');
    if (first.action !== 'acquired') return;
    expect(first.state.lease).toEqual({ ownerId: 'A', expiresAt: 31_000 });

    expect(decideAcquireLease({
      current: first.state,
      candidate,
      ownerId: 'B',
      nowMs: 2000,
      leaseMs: 30_000,
    })).toEqual({ action: 'busy', ownerId: 'A' });

    const expired = decideAcquireLease({
      current: first.state,
      candidate,
      ownerId: 'B',
      nowMs: 40_000,
      leaseMs: 30_000,
    });
    expect(expired.action).toBe('acquired');
    if (expired.action !== 'acquired') return;
    expect(expired.state.lease?.ownerId).toBe('B');

    expect(decideAcquireLease({
      current: first.state,
      candidate: captured({ payloadDigest: 'other' }),
      ownerId: 'B',
      nowMs: 2000,
      leaseMs: 30_000,
    })).toEqual({ action: 'conflict' });

    const term = withPhase(first.state, 'terminal', { versionPublished: true }, 't1');
    expect(decideAcquireLease({
      current: term,
      candidate,
      ownerId: 'B',
      nowMs: 2000,
      leaseMs: 30_000,
    }).action).toBe('terminal');
  });

  it('phase CAS never lowers rank and never clears version proof', () => {
    const owner = { ownerId: 'A', expiresAt: 99_000 };
    const versioned = withPhase(captured({ lease: owner }), 'versioned', {
      assignedVersion: 4,
      publishedVersion: 4,
      versionPublished: true,
      historyWritten: true,
      processedWritten: true,
      outgoingCommitted: true,
    }, 't1');
    const mutatedAttempt = decideAdvancePhase({
      current: versioned,
      desired: withPhase(versioned, 'mutated', { versionPublished: false, publishedVersion: null, assignedVersion: null }, 't2'),
      ownerId: 'A',
      nowMs: 1000,
    });
    expect(mutatedAttempt.action).toBe('keep');
    if (mutatedAttempt.action !== 'keep') return;
    expect(mutatedAttempt.state.phase).toBe('versioned');
    expect(mutatedAttempt.state.assignedVersion).toBe(4);
    expect(mutatedAttempt.state.publishedVersion).toBe(4);
    expect(mutatedAttempt.state.versionPublished).toBe(true);

    const terminal = withPhase(versioned, 'terminal', {}, 't3');
    const downAttempt = decideAdvancePhase({
      current: terminal,
      desired: withPhase(terminal, 'downstream', {}, 't4'),
      ownerId: 'stale',
      nowMs: 1000,
    });
    expect(downAttempt.action).toBe('keep');
    if (downAttempt.action !== 'keep') return;
    expect(downAttempt.state.phase).toBe('terminal');
  });

  it('stale former owner cannot overwrite a newer checkpoint', () => {
    const bState = withPhase(captured({
      lease: { ownerId: 'B', expiresAt: 50_000 },
    }), 'downstream', {
      historyWritten: true,
      processedWritten: true,
      outgoingCommitted: true,
      assignedVersion: 2,
    }, 't1');
    expect(decideAdvancePhase({
      current: bState,
      desired: withPhase(bState, 'mutated', { assignedVersion: null }, 't2'),
      ownerId: 'A',
      nowMs: 1000,
    }).action).toBe('stale');
  });

  it('mergeMonotonic never drops committed flags or assigned seq', () => {
    const current = withPhase(captured(), 'versioned', {
      historyWritten: true,
      versionPublished: true,
      assignedVersion: 7,
      publishedVersion: 7,
    }, 't1');
    const incoming = withPhase(captured(), 'mutated', {
      historyWritten: false,
      versionPublished: false,
      assignedVersion: null,
      publishedVersion: null,
    }, 't2');
    const merged = mergeMonotonic(current, incoming);
    expect(merged.phase).toBe('versioned');
    expect(merged.historyWritten).toBe(true);
    expect(merged.versionPublished).toBe(true);
    expect(merged.assignedVersion).toBe(7);
    expect(merged.publishedVersion).toBe(7);
  });

  it('releaseLease only clears the matching owner', () => {
    const s = captured({ lease: { ownerId: 'A', expiresAt: 9 } });
    expect(decideReleaseLease(s, 'B')?.lease?.ownerId).toBe('A');
    expect(decideReleaseLease(s, 'A')?.lease).toBeNull();
  });

  it('watchdog retriggers governed edits with no checkpoint and never those already terminal', () => {
    expect(shouldRetriggerEditIncoming({ isGoverned: true, applyState: null })).toBe(true);
    expect(shouldRetriggerEditIncoming({ isGoverned: false, applyState: null })).toBe(false);
    expect(shouldRetriggerEditIncoming({
      isGoverned: true,
      applyState: withPhase(captured(), 'terminal', {}, 't'),
    })).toBe(false);
    expect(shouldRetriggerEditIncoming({
      isGoverned: false,
      applyState: captured(),
    })).toBe(true);
  });

  it('parseApplyState rejects malformed rows', () => {
    expect(parseApplyState(null)).toBeNull();
    expect(parseApplyState({ editEventId: 'e' })).toBeNull();
    expect(parseApplyState({
      editEventId: 'e1',
      payloadDigest: 'abc',
      phase: 'captured',
    })?.phase).toBe('captured');
  });
});
