import {
  DRIVER_RECOVERY_MAX_ATTEMPTS,
  allowedRecoveryReturnUri,
  classifyRedemption,
  genericRequestReceipt,
  recoverySecretHash,
  secretsMatch,
} from '../driverRecoveryContract';
import { previewCanonicalHydration } from '../operational/canonicalProfileHydration';

const base = {
  state: 'authorized' as const, now: 100, expiresAt: 200, attempts: 0,
  secretMatches: true, profileDigestMatches: true, companyMatches: true,
  credentialGenerationMatches: true, sameRedemptionAttempt: false,
};

describe('central driver recovery contract', () => {
  test('only exact app return URIs are allowed; open redirects fall back', () => {
    expect(allowedRecoveryReturnUri('wellbuilt-mobile', 'wellbuiltmobile://account-recovery')).toBeTruthy();
    expect(allowedRecoveryReturnUri('wellbuilt-mobile', 'https://evil.invalid')).toBeNull();
    expect(allowedRecoveryReturnUri('unknown', 'wellbuiltmobile://account-recovery')).toBeNull();
  });
  test('forgot-login receipt is enumeration resistant', () => {
    expect(genericRequestReceipt()).toEqual(genericRequestReceipt());
    expect(genericRequestReceipt().message).not.toMatch(/login|driver|account exists/i);
  });
  test('secret comparison is hashed and constant-shape', () => {
    const secret = 'private-one-time-value'; const hash = recoverySecretHash(secret);
    expect(hash).not.toContain(secret); expect(secretsMatch(secret, hash)).toBe(true);
    expect(secretsMatch('wrong', hash)).toBe(false);
  });
  test.each([
    [{ ...base, now: 200 }, 'expired'],
    [{ ...base, state: 'used' as const }, 'terminal'],
    [{ ...base, state: 'cancelled' as const }, 'terminal'],
    [{ ...base, attempts: DRIVER_RECOVERY_MAX_ATTEMPTS }, 'attempt_limit'],
    [{ ...base, secretMatches: false }, 'invalid_secret'],
    [{ ...base, profileDigestMatches: false }, 'profile_changed'],
    [{ ...base, companyMatches: false }, 'company_changed'],
    [{ ...base, credentialGenerationMatches: false }, 'credential_changed'],
    [{ ...base, state: 'redeeming' as const }, 'already_redeeming'],
  ])('denies replay/expiry/cross-binding %#', (input, reason) => {
    expect(classifyRedemption(input)).toEqual({ allow: false, reason });
  });
  test('same redemption attempt may idempotently resume', () => {
    expect(classifyRedemption({ ...base, state: 'redeeming', sameRedemptionAttempt: true })).toEqual({ allow: true });
  });
  test('iPhone16 fixture preserves company and all three routes', () => {
    const legacy = { displayName: 'iPhone16', legalName: 'Michael Burger', active: true,
      companyId: 'liquid-gold', assignedRoutes: ['Watford', 'Gabriels', 'Test Route'] };
    const p = previewCanonicalHydration(null, legacy, {
      driverId: '11111111-2222-4333-8444-555555555555', approvedKey: 'a'.repeat(64),
    });
    expect(p.copy.companyId).toBe('liquid-gold');
    expect(p.copy.assignedRoutes).toEqual(['Watford', 'Gabriels', 'Test Route']);
  });
});
