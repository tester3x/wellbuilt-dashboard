import {
  authorizeDiagnosticDriver,
  extractBearerToken,
  sanitizeDiagnosticValue,
  validateDiagnosticSchema,
} from '../diagnosticAuth';

describe('writeDiagnosticLog authorization decision', () => {
  it('missing or non-bearer headers are 401, never authenticated by length', () => {
    expect(extractBearerToken(undefined)).toMatchObject({ ok: false, status: 401 });
    expect(extractBearerToken('')).toMatchObject({ ok: false, status: 401 });
    expect(extractBearerToken('xxxxxxxxxxxxxxxx')).toMatchObject({ ok: false, status: 401 });
    expect(extractBearerToken('Basic abcdefghijklmnop')).toMatchObject({ ok: false, status: 401 });
    const dummy = extractBearerToken('Bearer xxxxxxxxxxxxxxxx');
    expect(dummy.ok).toBe(true);
    if (dummy.ok) expect(dummy.token).toBe('xxxxxxxxxxxxxxxx');
  });

  it('rejects client identity-selection fields before a write can be considered', () => {
    const r = validateDiagnosticSchema({
      app: 'wbt',
      area: 'auth',
      result: 'ok',
      event: 'x',
      driverId: 'drv-a',
      companyId: 'liquid-gold',
      isAdmin: true,
    });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'identity_field_forbidden' });
    expect(validateDiagnosticSchema({
      app: 'wbt', area: 'auth', result: 'ok', event: 'x', driverHash: 'aa'.repeat(16),
    })).toMatchObject({ ok: false, status: 400, code: 'identity_field_forbidden' });
  });

  it('accepts the current field-app schema without identity fields', () => {
    const r = validateDiagnosticSchema({
      app: 'wbt', area: 'auth', result: 'ok', event: 'recert', extra: { passcode: 'SECRET' },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects oversized and malformed schema', () => {
    expect(validateDiagnosticSchema(null)).toMatchObject({ ok: false, status: 400 });
    expect(validateDiagnosticSchema({ app: 'nope', area: 'auth', result: 'ok', event: 'x' }))
      .toMatchObject({ ok: false, status: 400, code: 'bad_app' });
    expect(validateDiagnosticSchema({
      app: 'wbt', area: 'auth', result: 'ok', event: 'x', pad: 'z'.repeat(20_000),
    })).toMatchObject({ ok: false, status: 400, code: 'payload_too_large' });
  });

  it('authorizes only a live driver bound to token claims + profile', () => {
    const profile = { active: true, companyId: 'acme-demo', displayName: 'B' };
    const claims = { kind: 'driver', driverId: 'drv-b', companyId: 'acme-demo' };
    expect(authorizeDiagnosticDriver({
      uid: 'driver_drvb', claims, profile,
    })).toMatchObject({ ok: true, driverId: 'drv-b', companyId: 'acme-demo' });
    expect(authorizeDiagnosticDriver({
      uid: 'driver_drvb', claims: {}, profile,
    })).toMatchObject({ ok: false, status: 401 });
    expect(authorizeDiagnosticDriver({
      uid: 'driver_drvb', claims, profile: { ...profile, active: false },
    })).toMatchObject({ ok: false, status: 403 });
    expect(authorizeDiagnosticDriver({
      uid: 'driver_drva', claims, profile,
    })).toMatchObject({ ok: false, status: 403 });
  });

  it('redacts sensitive extra keys', () => {
    const out = sanitizeDiagnosticValue({ passcode: 'SECRET', token: 'LEAK', note: 'ok' }) as Record<string, unknown>;
    expect(out.passcode).toBe('[redacted]');
    expect(out.token).toBe('[redacted]');
    expect(out.note).toBe('ok');
  });
});
