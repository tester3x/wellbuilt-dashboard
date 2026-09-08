import { evaluateDeletePull, deleteIncomingKey, type DeleteAuthorizeInput } from '../deletePullAuthorize';

const GOOD_CALLER = { caps: ['manageDrivers'], isPlatformAdmin: true };
const PROCESSED = { wellName: 'Gabriel 1', dateTimeUTC: '2026-09-07T11:40:00.000Z', bblsTaken: 100 };

function input(over: Partial<DeleteAuthorizeInput>): DeleteAuthorizeInput {
  return {
    packetId: '20260907_Gabriel1_ab12',
    wellName: 'Gabriel 1',
    processed: PROCESSED,
    caller: GOOD_CALLER,
    ...over,
  };
}

describe('evaluateDeletePull — authorization (fail closed)', () => {
  it('denies a caller without manageDrivers (covers unauthenticated / unauthorized role)', () => {
    expect(evaluateDeletePull(input({ caller: { caps: [], isPlatformAdmin: true } })))
      .toMatchObject({ ok: false, code: 'permission-denied', reason: 'manageDrivers_required' });
    // A driver/viewer role resolves to no manageDrivers cap → same denial.
    expect(evaluateDeletePull(input({ caller: { caps: ['viewReports'], isPlatformAdmin: false } })))
      .toMatchObject({ ok: false, reason: 'manageDrivers_required' });
  });

  it('denies a company-scoped (non-legacy) caller — the well pool is untenanted (wrong company)', () => {
    expect(evaluateDeletePull(input({ caller: { caps: ['manageDrivers'], isPlatformAdmin: false, companyId: 'acme' } })))
      .toMatchObject({ ok: false, code: 'permission-denied', reason: 'pool_forbidden' });
  });

  it('allows an unscoped / liquid-gold caller', () => {
    expect(evaluateDeletePull(input({ caller: { caps: ['manageDrivers'], isPlatformAdmin: false, companyId: 'liquid-gold' } })).ok).toBe(true);
    expect(evaluateDeletePull(input({ caller: { caps: ['manageDrivers'], isPlatformAdmin: false } })).ok).toBe(true);
  });
});

describe('evaluateDeletePull — identity', () => {
  it('requires a valid immutable packetId (rejects empty / forbidden chars — malformed)', () => {
    expect(evaluateDeletePull(input({ packetId: '' }))).toMatchObject({ reason: 'invalid_packetId' });
    expect(evaluateDeletePull(input({ packetId: 'bad/id' }))).toMatchObject({ reason: 'invalid_packetId' });
    expect(evaluateDeletePull(input({ packetId: 'a.b' }))).toMatchObject({ reason: 'invalid_packetId' });
  });

  it('requires the pull’s well (scope claim)', () => {
    expect(evaluateDeletePull(input({ wellName: '  ' }))).toMatchObject({ reason: 'missing_wellName' });
  });

  it('rejects when the SERVER-stored well no longer matches the claim (wrong well / stale view)', () => {
    expect(evaluateDeletePull(input({ wellName: 'Gabriel 1', processed: { ...PROCESSED, wellName: 'Gabriel 7' } })))
      .toMatchObject({ ok: false, code: 'failed-precondition', reason: 'well_mismatch' });
  });
});

describe('evaluateDeletePull — outcome', () => {
  it('authorizes a delete by stored identity', () => {
    expect(evaluateDeletePull(input({}))).toMatchObject({ ok: true, action: 'delete', packetId: '20260907_Gabriel1_ab12', wellName: 'Gabriel 1' });
  });

  it('is idempotent: an already-gone pull is a truthful success, not an error', () => {
    expect(evaluateDeletePull(input({ processed: null }))).toMatchObject({ ok: true, action: 'already_gone' });
  });

  it('deterministic single-flight key per packetId', () => {
    expect(deleteIncomingKey('P1')).toBe('delete_P1');
    expect(deleteIncomingKey('P1')).toBe(deleteIncomingKey('P1'));
  });
});
