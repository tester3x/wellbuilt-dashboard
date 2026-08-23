import { assertDriverWellPerformanceAccess } from '../driverWellPerformanceAccess';

const gabrielWells = { 'Gabriel 1': { route: 'Gabriels' } };

function expectDenied(
  fn: () => void,
  code: string,
  message: string,
) {
  try {
    fn();
    throw new Error(`expected ${code}/${message}`);
  } catch (err: any) {
    expect(err.code).toBe(code);
    expect(err.message).toBe(message);
  }
}

describe('assertDriverWellPerformanceAccess', () => {
  const ok = {
    authPresent: true,
    authSource: 'claims' as const,
    authority: { active: true, companyId: 'liquid-gold' },
    profileExists: true,
    eligibilityStatus: 'eligible',
    eligibilityReason: 'scope_ok',
    requestedWell: 'Gabriel 1',
    snapshotWells: gabrielWells,
  };

  it('anonymous denied', () => {
    expectDenied(
      () => assertDriverWellPerformanceAccess({ ...ok, authPresent: false }),
      'unauthenticated',
      'authentication_required',
    );
  });

  it('legacy-hash-only identity denied', () => {
    expectDenied(
      () => assertDriverWellPerformanceAccess({ ...ok, authSource: 'legacy_hash' }),
      'permission-denied',
      'legacy_hash_denied',
    );
  });

  it('inactive driver denied', () => {
    expectDenied(
      () => assertDriverWellPerformanceAccess({
        ...ok,
        authority: { active: false, companyId: 'liquid-gold' },
      }),
      'permission-denied',
      'driver_inactive',
    );
  });

  it('missing company denied', () => {
    expectDenied(
      () => assertDriverWellPerformanceAccess({
        ...ok,
        authority: { active: true, companyId: '' },
      }),
      'failed-precondition',
      'company_required',
    );
  });

  it('missing/malformed assignment denied', () => {
    expectDenied(
      () => assertDriverWellPerformanceAccess({
        ...ok,
        eligibilityStatus: 'unknown',
        eligibilityReason: 'scope_missing',
      }),
      'failed-precondition',
      'scope_missing',
    );
    expectDenied(
      () => assertDriverWellPerformanceAccess({
        ...ok,
        eligibilityStatus: 'unknown',
        eligibilityReason: 'scope_malformed',
      }),
      'failed-precondition',
      'scope_malformed',
    );
  });

  it('authorized Gabriel well allowed', () => {
    expect(() => assertDriverWellPerformanceAccess(ok)).not.toThrow();
  });

  it('unassigned and other-company well denied', () => {
    expectDenied(
      () => assertDriverWellPerformanceAccess({ ...ok, requestedWell: 'Gabriel 9' }),
      'permission-denied',
      'well_not_authorized',
    );
    expectDenied(
      () => assertDriverWellPerformanceAccess({ ...ok, requestedWell: 'Other Co 1' }),
      'permission-denied',
      'well_not_authorized',
    );
  });
});
