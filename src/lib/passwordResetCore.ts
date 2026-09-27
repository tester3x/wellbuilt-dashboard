/**
 * Pure, framework-free logic for Dashboard login + forgot-password. No Firebase, no
 * DOM — so validation, non-enumerating messaging, and the client cooldown are fully
 * node-testable. The page and the auth wrapper consume these; nothing here logs.
 */

/** Always-generic acknowledgement — never reveals whether an account exists. */
export const GENERIC_RESET_ACK =
  'If an account exists for that email, a password-reset link has been sent.';

/** Collapsed, non-enumerating sign-in failure message. */
export const GENERIC_LOGIN_ERROR = 'Email or password is incorrect.';

/** Restrained client cooldown between reset submissions (ms). */
export const RESET_COOLDOWN_MS = 30_000;

/** Basic local email-shape check (not validation of existence). */
export function isValidEmailShape(email: string): boolean {
  const e = (email || '').trim();
  if (e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/**
 * Sign-in error copy. user-not-found / wrong-password / invalid-credential collapse to
 * ONE non-enumerating message; only genuinely-distinct, non-enumerating states differ.
 */
export function loginErrorMessage(code: string | undefined | null): string {
  switch (code) {
    case 'auth/invalid-email':
      return 'Enter a valid email address.';
    case 'auth/network-request-failed':
      return 'Network unavailable. Check your connection and try again.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please try again later.';
    default:
      // includes auth/user-not-found, auth/wrong-password, auth/invalid-credential, unknown
      return GENERIC_LOGIN_ERROR;
  }
}

/**
 * Reset-flow error copy. user-not-found NEVER reaches here (the wrapper swallows it),
 * and any unknown/other code falls back to the generic ack so the response stays
 * non-enumerating; only invalid-email / network / rate-limit surface distinctly.
 */
export function resetErrorMessage(code: string | undefined | null): string {
  switch (code) {
    case 'auth/invalid-email':
      return 'Enter a valid email address.';
    case 'auth/network-request-failed':
      return 'Network unavailable. Check your connection and try again.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please try again later.';
    default:
      return GENERIC_RESET_ACK;
  }
}

/** Milliseconds remaining before another reset may be submitted (0 = ready). */
export function cooldownRemainingMs(
  lastSentAt: number | null,
  nowMs: number,
  cooldownMs: number = RESET_COOLDOWN_MS,
): number {
  if (lastSentAt == null) return 0;
  return Math.max(0, cooldownMs - (nowMs - lastSentAt));
}

/** Whether the reset button should be enabled right now. */
export function canSubmitReset(
  email: string,
  pending: boolean,
  lastSentAt: number | null,
  nowMs: number,
  cooldownMs: number = RESET_COOLDOWN_MS,
): boolean {
  return !pending && isValidEmailShape(email) && cooldownRemainingMs(lastSentAt, nowMs, cooldownMs) === 0;
}
