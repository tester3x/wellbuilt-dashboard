import {
  evaluatePullCorrection,
  correctionIncomingKey,
  wellConfigHasWell,
  type AuthorizeInput,
} from '../pullCorrectionAuthorize';

const GOOD_CALLER = { caps: ['manageDrivers'], isPlatformAdmin: true };
const PROCESSED = { wellName: 'Gabriel 3', dateTimeUTC: '2026-09-07T11:40:00.000Z', bblsTaken: 100 };
const WELL_CONFIG = { 'Gabriel 3': { tanks: 2 }, 'Gabriel 5': { tanks: 3 } };

function input(over: Partial<AuthorizeInput>): AuthorizeInput {
  return {
    op: 'delete',
    packetId: '20260907_Gabriel3_ab12',
    fromWell: 'Gabriel 3',
    processed: PROCESSED,
    wellConfig: WELL_CONFIG,
    caller: GOOD_CALLER,
    ...over,
  };
}

describe('evaluatePullCorrection — authorization', () => {
  it('denies a caller without manageDrivers (fail closed)', () => {
    const d = evaluatePullCorrection(input({ caller: { caps: [], isPlatformAdmin: true } }));
    expect(d).toMatchObject({ ok: false, code: 'permission-denied', reason: 'manageDrivers_required' });
  });

  it('denies a company-scoped (non-legacy) caller — the well pool is untenanted', () => {
    const d = evaluatePullCorrection(input({
      caller: { caps: ['manageDrivers'], isPlatformAdmin: false, companyId: 'acme' },
    }));
    expect(d).toMatchObject({ ok: false, code: 'permission-denied', reason: 'pool_forbidden' });
  });

  it('allows an unscoped / liquid-gold caller', () => {
    const legacy = evaluatePullCorrection(input({
      caller: { caps: ['manageDrivers'], isPlatformAdmin: false, companyId: 'liquid-gold' },
    }));
    expect(legacy.ok).toBe(true);
    const unscoped = evaluatePullCorrection(input({
      caller: { caps: ['manageDrivers'], isPlatformAdmin: false },
    }));
    expect(unscoped.ok).toBe(true);
  });
});

describe('evaluatePullCorrection — identity', () => {
  it('requires a valid immutable packetId (rejects empty / forbidden chars)', () => {
    expect(evaluatePullCorrection(input({ packetId: '' }))).toMatchObject({ reason: 'invalid_packetId' });
    expect(evaluatePullCorrection(input({ packetId: 'bad/id' }))).toMatchObject({ reason: 'invalid_packetId' });
    expect(evaluatePullCorrection(input({ packetId: 'a.b' }))).toMatchObject({ reason: 'invalid_packetId' });
  });

  it('rejects an unknown op', () => {
    expect(evaluatePullCorrection(input({ op: 'reassign' as unknown as 'move' }))).toMatchObject({ reason: 'invalid_op' });
  });

  it('requires the current (wrong) well', () => {
    expect(evaluatePullCorrection(input({ fromWell: '  ' }))).toMatchObject({ reason: 'missing_fromWell' });
  });

  it('rejects when the stored well no longer matches the claimed well (stale view)', () => {
    const d = evaluatePullCorrection(input({
      op: 'delete',
      fromWell: 'Gabriel 3',
      processed: { ...PROCESSED, wellName: 'Some Other Well' },
    }));
    expect(d).toMatchObject({ ok: false, code: 'failed-precondition', reason: 'well_mismatch' });
  });
});

describe('evaluatePullCorrection — delete', () => {
  it('authorizes a delete of an existing pull by stored identity', () => {
    const d = evaluatePullCorrection(input({ op: 'delete' }));
    expect(d).toMatchObject({ ok: true, op: 'delete', action: 'delete', wellName: 'Gabriel 3' });
  });

  it('is idempotent: an already-gone pull is a truthful success, not an error', () => {
    const d = evaluatePullCorrection(input({ op: 'delete', processed: null }));
    expect(d).toMatchObject({ ok: true, op: 'delete', action: 'already_gone' });
  });
});

describe('evaluatePullCorrection — move', () => {
  it('requires a target well', () => {
    expect(evaluatePullCorrection(input({ op: 'move', toWell: '' }))).toMatchObject({ reason: 'missing_toWell' });
  });

  it('rejects moving to the same well', () => {
    expect(evaluatePullCorrection(input({ op: 'move', toWell: 'Gabriel 3' }))).toMatchObject({ reason: 'same_well' });
  });

  it('rejects a target well that does not exist', () => {
    const d = evaluatePullCorrection(input({ op: 'move', toWell: 'Nonexistent Well' }));
    expect(d).toMatchObject({ ok: false, code: 'failed-precondition', reason: 'target_well_not_found' });
  });

  it('cannot move a pull that no longer exists (does not fabricate)', () => {
    const d = evaluatePullCorrection(input({ op: 'move', toWell: 'Gabriel 5', processed: null }));
    expect(d).toMatchObject({ ok: false, reason: 'pull_not_found' });
  });

  it('authorizes a valid move to an existing target well', () => {
    const d = evaluatePullCorrection(input({ op: 'move', toWell: 'Gabriel 5' }));
    expect(d).toMatchObject({ ok: true, op: 'move', action: 'move', fromWell: 'Gabriel 3', toWell: 'Gabriel 5' });
  });

  it('is idempotent: a pull already re-anchored to the target acknowledges without re-queuing', () => {
    const d = evaluatePullCorrection(input({
      op: 'move', toWell: 'Gabriel 5',
      processed: { ...PROCESSED, wellName: 'Gabriel 5' },
    }));
    expect(d).toMatchObject({ ok: true, op: 'move', action: 'already_moved' });
  });
});

describe('helpers', () => {
  it('correctionIncomingKey is deterministic per op+packetId (single-flight retries)', () => {
    expect(correctionIncomingKey('delete', 'P1')).toBe('delete_P1');
    expect(correctionIncomingKey('move', 'P1')).toBe('move_P1');
    expect(correctionIncomingKey('move', 'P1')).toBe(correctionIncomingKey('move', 'P1'));
  });

  it('wellConfigHasWell matches exact and whitespace-stripped keys', () => {
    expect(wellConfigHasWell({ 'Gabriel 5': {} }, 'Gabriel 5')).toBe(true);
    expect(wellConfigHasWell({ Gabriel5: {} }, 'Gabriel 5')).toBe(true);
    expect(wellConfigHasWell({ 'Gabriel 5': {} }, 'Nope')).toBe(false);
  });
});
