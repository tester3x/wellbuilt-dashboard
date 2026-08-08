/**
 * vc51.9Z-3 — verify-before-update email change for the current user.
 *
 * Three verification sends to the owner's address were accepted by
 * Firebase and none arrived. The project uses the DEFAULT sender with no
 * template customization and no custom domain, so mail leaves as
 * noreply@wellbuilt-sync.firebaseapp.com — a domain shared by every
 * Firebase project, with SPF and DKIM but no DMARC policy — and Firebase
 * publishes no delivery, bounce or suppression telemetry for it. There is
 * nothing to repair in configuration and nothing to observe downstream, so
 * the supported move is to point the account at a mailbox that receives.
 *
 * THE GATE IS NOT WEAKENED. verifyBeforeUpdateEmail sends the link to the
 * NEW address and commits the change only after that link is followed, so
 * mailbox control is still proven — by the same mechanism, just for a
 * different mailbox. updateEmail is deliberately never used: it would move
 * the address first and verify afterwards, which is exactly the inversion
 * this whole bootstrap is built to avoid.
 *
 * The UID is untouched, so the Owner profile, roles and every history
 * binding survive the change. Nothing here reads or writes a role, a
 * driver identity, or a company.
 */

import { verifyBeforeUpdateEmail } from 'firebase/auth';
import { getFirebaseAuth } from './firebase';

/** Same authorized origin the verification flow returns to. */
export const EMAIL_CHANGE_CONTINUE_URL = 'https://wellbuilt-sync.web.app/admin';

// Deliberately permissive: the mailbox itself is the real validator, and a
// clever pattern here would only reject addresses that actually work.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type NewEmailCheck = { ok: true } | { ok: false; message: string };

export function validateNewEmail(next: string, current: string | null): NewEmailCheck {
  const v = next.trim();
  if (!v) return { ok: false, message: 'Enter the address you want to use.' };
  if (!EMAIL_RE.test(v)) return { ok: false, message: 'That does not look like an email address.' };
  if (current && v.toLowerCase() === current.trim().toLowerCase()) {
    return { ok: false, message: 'That is already this account’s address. Choose a mailbox you can receive at.' };
  }
  return { ok: true };
}

/** Fixed guidance per Firebase code — the raw error is never surfaced. */
export function mapEmailChangeError(code: string): string {
  switch (code) {
    case 'auth/email-already-in-use':
      // Says that it cannot be used; says nothing about who holds it.
      return 'That address is already in use. Choose a different one.';
    case 'auth/requires-recent-login':
      return 'For this change Firebase requires a fresh sign-in. Sign out, sign in again, and retry.';
    case 'auth/invalid-email':
      return 'That does not look like an email address.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes before trying again.';
    case 'auth/operation-not-allowed':
      return 'This project does not permit changing the address this way.';
    default:
      return 'Could not start the address change. Try again shortly.';
  }
}

export type EmailChangeResult = { ok: true } | { ok: false; message: string };

/**
 * Start the change for the CURRENT user. The address is supplied by the
 * authenticated operator for their own account; there is no uid parameter,
 * so this can never be aimed at someone else's record.
 */
export async function startEmailChange(nextEmail: string): Promise<EmailChangeResult> {
  const user = getFirebaseAuth().currentUser;
  if (!user) return { ok: false, message: 'Your session is no longer valid. Sign in again and retry.' };

  const check = validateNewEmail(nextEmail, user.email);
  if (!check.ok) return check;

  try {
    await verifyBeforeUpdateEmail(user, nextEmail.trim(), {
      url: EMAIL_CHANGE_CONTINUE_URL,
      handleCodeInApp: false,
    });
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? '';
    return { ok: false, message: mapEmailChangeError(code) };
  }
}
