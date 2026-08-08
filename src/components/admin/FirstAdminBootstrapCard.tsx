'use client';

/**
 * vc51.9Z — the one-time bootstrap surface, with email verification.
 *
 * Shown ONLY when the session is authenticated but carries no
 * wellbuiltAdmin claim ('ordinary'). It is a display affordance and
 * nothing more: the server re-decides authorization on the call, an
 * unauthorized caller is refused with a bare "denied", and this card being
 * visible grants no one anything.
 *
 * The bootstrap callable requires a verified email. That precondition is
 * not weakened here — instead the card runs the normal authenticated
 * Firebase verification flow so the operator can satisfy it themselves.
 * Everything is scoped to auth.currentUser: there is no address field and
 * no uid field, so a verification mail cannot be aimed anywhere else.
 *
 * Verification never activates anything on its own. Proving the mailbox
 * only reveals the activation button; the grant still requires its own
 * deliberate click.
 *
 * TEMPORARY. Removed together with the endpoint once bootstrap completes.
 */

import { useCallback, useEffect, useState } from 'react';
import { runFirstAdminBootstrap } from '@/lib/firstAdminBootstrap';
import {
  RESEND_COOLDOWN_MS,
  canSendVerification,
  cooldownRemainingMs,
  currentVerificationStatus,
  refreshVerificationStatus,
  sendVerificationToCurrentUser,
  verificationCopy,
} from '@/lib/emailVerification';

export function FirstAdminBootstrapCard({ onGranted }: { onGranted: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);

  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [verifyNote, setVerifyNote] = useState<string | null>(null);

  /** Drop every transient value — used on unmount and on sign-out. */
  const clearTransient = useCallback(() => {
    setSending(false);
    setChecking(false);
    setLastSentAt(null);
    setVerifyNote(null);
    setNote(null);
  }, []);

  useEffect(() => {
    const s = currentVerificationStatus();
    setSignedIn(s.signedIn);
    setEmail(s.email);
    setEmailVerified(s.emailVerified);
    if (!s.signedIn) clearTransient();
    return clearTransient;
  }, [clearTransient]);

  // Ticks only while a cooldown is actually running, so the countdown is
  // live without polling the rest of the time.
  useEffect(() => {
    if (lastSentAt === null) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lastSentAt]);

  const remainingMs = cooldownRemainingMs(lastSentAt, nowMs);
  const remainingSec = Math.ceil(remainingMs / 1000);
  const maySend = canSendVerification({ signedIn, emailVerified, sending, lastSentAt, now: nowMs });

  const send = async () => {
    if (!maySend) return;
    setSending(true);
    setVerifyNote(null);
    try {
      const r = await sendVerificationToCurrentUser();
      if (r.ok) {
        setLastSentAt(Date.now());
        setNowMs(Date.now());
        setVerifyNote(verificationCopy.sent);
      } else {
        setVerifyNote(r.message);
      }
    } finally {
      setSending(false);
    }
  };

  const refreshStatus = async () => {
    if (checking) return;
    setChecking(true);
    setVerifyNote(null);
    try {
      const s = await refreshVerificationStatus();
      setSignedIn(s.signedIn);
      setEmail(s.email);
      setEmailVerified(s.emailVerified);
      if (!s.emailVerified) setVerifyNote(verificationCopy.stillUnverified);
    } finally {
      setChecking(false);
    }
  };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await runFirstAdminBootstrap();
      if (r.ok) {
        setNote('Platform administrator access granted. Re-checking your session…');
        await onGranted();
      } else {
        setNote(r.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-gray-800 border border-amber-600/50 rounded-lg p-4 max-w-xl mb-4">
      <h3 className="text-white text-sm font-medium mb-1">Platform administration not yet activated</h3>
      <p className="text-gray-300 text-sm">
        This installation has no enabled platform administrator. If this account is the
        designated platform owner, activate it once here. Your password is never sent —
        your existing sign-in is the proof.
      </p>

      {!emailVerified && (
        <div className="mt-3 border-t border-gray-600 pt-3">
          <p className="text-gray-300 text-sm">
            Activation requires proving control of the mailbox for{' '}
            <span className="text-white break-words">{email ?? 'this account'}</span>.
            We will send a verification link to that address — the one you are signed in as,
            and no other.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => { void send(); }}
              disabled={!maySend}
              className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              {sending
                ? 'Sending…'
                : remainingMs > 0
                  ? `Send verification email (${remainingSec}s)`
                  : 'Send verification email'}
            </button>
            <button
              onClick={() => { void refreshStatus(); }}
              disabled={checking}
              className="px-3 py-1.5 rounded bg-gray-600 hover:bg-gray-500 disabled:opacity-50 text-white text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
            >
              {checking ? 'Checking…' : 'I verified my email — refresh status'}
            </button>
          </div>
          {verifyNote && <p className="mt-3 text-sm text-gray-200 break-words">{verifyNote}</p>}
          <p className="mt-3 text-xs text-gray-400">
            Verifying your email does not activate anything by itself.
          </p>
        </div>
      )}

      {emailVerified && (
        <div className="mt-3 border-t border-gray-600 pt-3">
          <p className="text-green-300 text-sm">
            Email verified for <span className="break-words">{email ?? 'this account'}</span>.
          </p>
          <button
            onClick={() => { void run(); }}
            disabled={busy}
            className="mt-3 px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
          >
            {busy ? 'Activating…' : 'Activate platform administration'}
          </button>
          {note && <p className="mt-3 text-sm text-gray-200 break-words">{note}</p>}
        </div>
      )}

      <p className="mt-3 text-xs text-gray-500">
        Resend is limited to once every {Math.round(RESEND_COOLDOWN_MS / 1000)} seconds.
      </p>
    </div>
  );
}
