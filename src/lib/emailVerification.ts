/**
 * vc51.9Z-2 — email verification for the platform-admin bootstrap.
 *
 * The bootstrap callable refuses with `email_unverified` until the caller
 * has proven control of the allowlisted mailbox. That precondition is
 * deliberate and untouched: this module lets the operator satisfy it
 * through the normal authenticated Firebase flow, with no service-account
 * key and no administrative mutation of the Firebase user.
 *
 * SCOPE. Everything here is bound to `auth.currentUser`. There is no email
 * parameter and no uid parameter anywhere — a verification mail can only
 * ever be sent to the address the current session already proves control
 * of. That is what makes "cannot send for another address" a structural
 * property rather than a check that could be forgotten.
 *
 * DISCLOSURE. The copy below never states whether an address exists, is
 * registered, or is in use. Firebase's own error codes are mapped to fixed
 * guidance; a raw error is never surfaced, so a provider message cannot
 * leak account existence onto the screen.
 *
 * The continuation URL is https://wellbuilt-sync.web.app/admin — confirmed
 * present in this project's Firebase Auth authorizedDomains before being
 * relied on (alongside localhost and wellbuilt-sync.firebaseapp.com). It
 * is a plain route: no token, no code, no claim, no query payload. The
 * one-time code lives in Firebase's own action link, which this app never
 * reads, stores, or logs.
 */

import { sendEmailVerification } from 'firebase/auth';
import { getFirebaseAuth } from './firebase';

/** Minimum gap between verification sends, client-side. */
export const RESEND_COOLDOWN_MS = 60_000;

/**
 * Where Firebase returns the operator after the link is confirmed.
 * The domain is authorized; the path is the page holding the card.
 */
export const VERIFICATION_CONTINUE_URL = 'https://wellbuilt-sync.web.app/admin';

export const verificationCopy = {
  sent: 'Verification email sent. Open it and click the link, then return here and refresh your status.',
  stillUnverified: 'This address still reads as unverified. If you just clicked the link, wait a moment and refresh again.',
} as const;

/** Fixed guidance per Firebase error code — never the raw error. */
export function mapVerificationError(code: string): string {
  switch (code) {
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes before trying again.';
    case 'auth/network-request-failed':
      return 'Connection problem. Check your network and try again.';
    case 'auth/user-token-expired':
    case 'auth/user-disabled':
    case 'auth/user-not-found':
      // Deliberately collapsed: none of these may distinguish account state.
      return 'Your session is no longer valid. Sign in again and retry.';
    default:
      return 'Could not send the verification email. Try again shortly.';
  }
}

export function cooldownRemainingMs(
  lastSentAt: number | null,
  now: number,
  cooldownMs: number = RESEND_COOLDOWN_MS,
): number {
  if (lastSentAt === null) return 0;
  return Math.max(0, cooldownMs - (now - lastSentAt));
}

export function canSendVerification(input: {
  signedIn: boolean;
  emailVerified: boolean;
  sending: boolean;
  lastSentAt: number | null;
  now: number;
}): boolean {
  if (!input.signedIn || input.emailVerified || input.sending) return false;
  return cooldownRemainingMs(input.lastSentAt, input.now) === 0;
}

export type VerificationSendResult = { ok: true } | { ok: false; message: string };

/**
 * Send to the CURRENT user. No argument: there is deliberately no way to
 * name a different address.
 */
export async function sendVerificationToCurrentUser(): Promise<VerificationSendResult> {
  const user = getFirebaseAuth().currentUser;
  if (!user) return { ok: false, message: mapVerificationError('auth/user-token-expired') };
  try {
    await sendEmailVerification(user, {
      url: VERIFICATION_CONTINUE_URL,
      handleCodeInApp: false,
    });
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? '';
    return { ok: false, message: mapVerificationError(code) };
  }
}

export interface VerificationStatus {
  signedIn: boolean;
  email: string | null;
  emailVerified: boolean;
}

/** Read the cached session state without touching the network. */
export function currentVerificationStatus(): VerificationStatus {
  const user = getFirebaseAuth().currentUser;
  return {
    signedIn: !!user,
    email: user?.email ?? null,
    emailVerified: user?.emailVerified === true,
  };
}

/**
 * Re-read verification state after the operator follows the emailed link.
 *
 * reload() refreshes the user record; getIdToken(true) then mints a token
 * that actually carries the new email_verified value. The bootstrap
 * callable reads that claim from the verified token, so without the forced
 * refresh the very next activation attempt would still be refused.
 *
 * No password is involved at any point.
 */
export async function refreshVerificationStatus(): Promise<VerificationStatus> {
  const user = getFirebaseAuth().currentUser;
  if (!user) return { signedIn: false, email: null, emailVerified: false };
  await user.reload();
  await user.getIdToken(true);
  return {
    signedIn: true,
    email: user.email ?? null,
    emailVerified: user.emailVerified === true,
  };
}
