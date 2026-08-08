/**
 * vc51.9Z — client side of the one-time first-platform-admin bootstrap.
 *
 * Sends NOTHING. The payload is exactly `{}`: the caller's existing
 * Firebase session is the proof, there is no target-uid field to fill in,
 * and no password or token is ever transmitted by this module.
 *
 * The claim is minted on the Auth user, so the caller's current ID token
 * predates it. `forceTokenRefresh` is therefore part of the operation, not
 * an afterthought — without it the very next protected call still fails.
 */

import { httpsCallable } from 'firebase/functions';
import { getFirebaseAuth, getFirebaseFunctions } from './firebase';

export type BootstrapOutcome =
  | { ok: true; steps: string[] }
  | { ok: false; code: string; message: string };

/** Operator-facing copy per server refusal. Never echoes the raw error. */
export function bootstrapMessage(code: string): string {
  switch (code) {
    case 'unauthenticated':
      return 'Sign in to the Dashboard first.';
    case 'denied':
      return 'This account is not authorized to bootstrap platform administration.';
    case 'email_unverified':
      return 'Verify this account’s email address, then try again.';
    case 'bootstrap_completed':
      return 'Platform administration has already been bootstrapped. This action is permanently closed.';
    case 'admin_already_exists':
      return 'An enabled platform administrator already exists. Ask them to grant access instead.';
    case 'rate_limited':
      return 'Too many bootstrap attempts. Contact WellBuilt support.';
    case 'claim_not_persisted':
      return 'The access claim did not persist. Nothing was granted — it is safe to try again.';
    default:
      return 'Bootstrap failed. Nothing was granted.';
  }
}

/**
 * Invoke the bootstrap, then force an ID-token refresh so the new claim is
 * present in the session before anything re-checks authority.
 */
export async function runFirstAdminBootstrap(): Promise<BootstrapOutcome> {
  try {
    const fn = httpsCallable(getFirebaseFunctions(), 'bootstrapFirstPlatformAdmin');
    const res = await fn({});
    const data = (res.data ?? {}) as { ok?: boolean; steps?: string[] };

    // The claim lives on the Auth user; the current token predates it.
    const current = getFirebaseAuth().currentUser;
    if (current) await current.getIdToken(true);

    return { ok: true, steps: Array.isArray(data.steps) ? data.steps : [] };
  } catch (err) {
    const raw = (err as { code?: string; message?: string }) ?? {};
    const code = (raw.code ?? '').replace(/^functions\//, '');
    // The server puts its reason in the message; map it, never render it.
    const reason = raw.message && raw.message.length < 64 ? raw.message : code;
    return { ok: false, code: reason, message: bootstrapMessage(reason) };
  }
}
