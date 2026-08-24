/** Central governed driver-account recovery protocol. Pure/testable rules. */
import { createHash, timingSafeEqual } from 'crypto';
export const DRIVER_RECOVERY_TTL_MS = 15 * 60 * 1000;
export const DRIVER_RECOVERY_MAX_ATTEMPTS = 5;

export type DriverRecoveryPurpose =
  | 'forgot_login'
  | 'forgot_passcode'
  | 'legacy_upgrade';

export type DriverRecoveryState =
  | 'pending'
  | 'authorized'
  | 'redeeming'
  | 'used'
  | 'denied'
  | 'cancelled'
  | 'expired';

export const RECOVERY_AUDIENCES = [
  'wellbuilt-suite',
  'wellbuilt-mobile',
  'wellbuilt-tickets',
  'wellbuilt-jsa',
  'wellbuilt-equipment',
] as const;

export type RecoveryAudience = typeof RECOVERY_AUDIENCES[number];

const RETURN_URIS: Record<RecoveryAudience, readonly string[]> = {
  'wellbuilt-suite': ['wellbuilt://account-recovery'],
  'wellbuilt-mobile': ['wellbuilt-mobile://account-recovery'],
  'wellbuilt-tickets': ['wellbuilt-tickets://account-recovery'],
  'wellbuilt-jsa': ['wellbuilt-jsa://account-recovery'],
  'wellbuilt-equipment': ['wellbuilt-equipment://account-recovery'],
};

export function allowedRecoveryReturnUri(
  audience: unknown,
  returnUri: unknown,
): string | null {
  if (typeof audience !== 'string' || typeof returnUri !== 'string') return null;
  if (!(audience in RETURN_URIS)) return null;
  const allowed = RETURN_URIS[audience as RecoveryAudience];
  return allowed.includes(returnUri) ? returnUri : null;
}

export function recoverySecretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function validSecretHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function secretsMatch(secret: string, expectedHash: string): boolean {
  if (!validSecretHash(expectedHash) || !secret) return false;
  const actual = Buffer.from(recoverySecretHash(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function genericRequestReceipt(): { ok: true; message: string } {
  return {
    ok: true,
    message: 'If the information can be matched, an authorized WellBuilt administrator will contact you privately.',
  };
}

export function classifyRedemption(input: {
  state: DriverRecoveryState;
  now: number;
  expiresAt: number;
  attempts: number;
  secretMatches: boolean;
  profileDigestMatches: boolean;
  companyMatches: boolean;
  credentialGenerationMatches: boolean;
  sameRedemptionAttempt: boolean;
}): { allow: true } | { allow: false; reason: string } {
  if (input.state === 'cancelled' || input.state === 'denied' || input.state === 'used') {
    return { allow: false, reason: 'terminal' };
  }
  if (input.now >= input.expiresAt) return { allow: false, reason: 'expired' };
  if (input.attempts >= DRIVER_RECOVERY_MAX_ATTEMPTS) return { allow: false, reason: 'attempt_limit' };
  if (input.state === 'redeeming' && !input.sameRedemptionAttempt) {
    return { allow: false, reason: 'already_redeeming' };
  }
  if (input.state !== 'authorized' && input.state !== 'redeeming') {
    return { allow: false, reason: 'not_authorized' };
  }
  if (!input.secretMatches) return { allow: false, reason: 'invalid_secret' };
  if (!input.profileDigestMatches) return { allow: false, reason: 'profile_changed' };
  if (!input.companyMatches) return { allow: false, reason: 'company_changed' };
  if (!input.credentialGenerationMatches) return { allow: false, reason: 'credential_changed' };
  return { allow: true };
}
