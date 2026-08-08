/**
 * vc51.9Z — first-platform-admin bootstrap: the decision, and the order.
 *
 * WHY THIS EXISTS. Normal admin authority needs both gates
 * (admin/authority.ts): the verified `wellbuiltAdmin` claim AND an enabled
 * `platform_admins/{uid}` record. Firestore rules deny all client access
 * to that collection and no callable writes it, so the only writer was a
 * local Admin SDK script requiring a service-account key. A fresh
 * WellBuilt installation therefore had no path to its first administrator
 * that did not involve handling a private key.
 *
 * WHAT IT MUST NOT BECOME. This does not weaken the dual gate and it never
 * treats a company-level role — Owner included — as proof of anything. It
 * is a one-time, self-only, deployment-authorized promotion, and it
 * refuses permanently once it has succeeded.
 *
 * THREAT MODEL, in the order the checks run:
 *
 *   1. Unauthenticated callers are refused before anything else.
 *   2. The allowlist is deployment-controlled (an environment variable set
 *      at deploy time, never client input, never a Firestore document a
 *      client could influence) and is EMPTY by default, so an
 *      unconfigured deployment is closed, not open.
 *   3. The allowlist is checked BEFORE any world state. A caller who is
 *      not on it learns only "denied" — never whether bootstrap is still
 *      available, whether an admin already exists, or how many attempts
 *      remain. Refusals carry `detailSafe` to enforce that at the edge.
 *   4. Email entries require a VERIFIED email, so control of an unverified
 *      address is worthless.
 *   5. The subject is always the caller. There is no target-uid input to
 *      spoof; `decideBootstrap` returns the caller's own uid and the
 *      callable writes only to that uid.
 *   6. An existing enabled administrator for any other uid closes it.
 *   7. A completion marker closes it permanently.
 *   8. Attempts are capped so a compromised allowlisted session cannot be
 *      used to grind at the remaining conditions.
 *
 * ORDERING. Auth custom claims and Firestore cannot share a transaction,
 * so this is interruptible at every step. The order is chosen so that
 * every reachable intermediate state fails the dual gate:
 *
 *   write_pending_record (enabled:false) -> set_claim -> verify_claim
 *     -> enable_record -> mark_completed
 *
 *   after write_pending_record : no claim              -> missing_admin_claim
 *   after set_claim            : record disabled       -> admin_record_disabled
 *   crash before enable_record : record disabled       -> admin_record_disabled
 *   claim write lost entirely  : no claim              -> missing_admin_claim
 *
 * None of those grant authority, to the caller or to anyone else — the
 * record is read at `platform_admins/{caller uid}`, so an enabled record
 * can never be borrowed by a different uid. Retry is idempotent: the plan
 * is derived from observed state, so it resumes rather than repeats, and
 * the completion marker is written last so an interrupted run is still
 * finishable while a finished one is closed forever.
 */

import { ADMIN_POLICY_VERSION } from './authority';

/** Bumped only when the stored record's shape changes. */
export const PLATFORM_ADMIN_RECORD_SCHEMA_VERSION = 1 as const;

/** Default attempt cap per deployment, before completion. */
export const BOOTSTRAP_MAX_ATTEMPTS = 10 as const;

export type BootstrapRefusalReason =
  | 'unauthenticated'
  | 'not_allowlisted'
  | 'email_unverified'
  | 'bootstrap_completed'
  | 'admin_already_exists'
  | 'rate_limited';

export interface BootstrapCaller {
  authenticated: boolean;
  uid: string | null;
  email: string | null;
  emailVerified: boolean;
}

export interface BootstrapWorld {
  /** Deployment-controlled. Empty means bootstrap is disabled. */
  allowlist: readonly string[];
  completed: boolean;
  /** An enabled platform_admins record exists for some OTHER uid. */
  enabledAdminExistsElsewhere: boolean;
  attemptsUsed: number;
  maxAttempts: number;
}

export type BootstrapDecision =
  | { ok: true; uid: string }
  | { ok: false; reason: BootstrapRefusalReason; detailSafe: boolean };

/**
 * Parse the deployment-controlled allowlist.
 *
 * Entries are either a verified email address or `uid:<AUTH_UID>`. Emails
 * are lowercased; uid entries keep their exact case because Firebase UIDs
 * are case-sensitive. Anything empty is dropped, so a blank or unset
 * variable yields an empty list — a closed deployment.
 */
export function parseBootstrapAllowlist(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.toLowerCase().startsWith('uid:') ? `uid:${s.slice(4).trim()}` : s.toLowerCase()));
}

/**
 * THE decision. Pure: every input is a fact the caller cannot forge, and
 * the order is part of the security property (see the threat model above).
 */
export function decideBootstrap(caller: BootstrapCaller, world: BootstrapWorld): BootstrapDecision {
  // 1. Authentication, before anything is revealed.
  if (!caller.authenticated || !caller.uid) {
    return { ok: false, reason: 'unauthenticated', detailSafe: false };
  }

  // 2/3. Deployment authorization, before ANY world state is consulted.
  //      A uid: entry authorizes without an email match; an email entry
  //      requires the address to be both matching and verified, so an
  //      unverified address is never sufficient on its own.
  const byUid = world.allowlist.includes(`uid:${caller.uid}`);
  const email = typeof caller.email === 'string' ? caller.email.toLowerCase() : null;
  const byEmail = email !== null && world.allowlist.includes(email);
  if (!byUid && !byEmail) {
    return { ok: false, reason: 'not_allowlisted', detailSafe: false };
  }

  // 4. Past this point the caller is deployment-authorized, so a specific
  //    reason is safe to disclose — it tells them what to fix, and they
  //    already hold the strongest fact (allowlist membership).
  if (!caller.emailVerified) {
    return { ok: false, reason: 'email_unverified', detailSafe: true };
  }
  if (world.completed) {
    return { ok: false, reason: 'bootstrap_completed', detailSafe: true };
  }
  if (world.enabledAdminExistsElsewhere) {
    return { ok: false, reason: 'admin_already_exists', detailSafe: true };
  }
  if (world.attemptsUsed >= world.maxAttempts) {
    return { ok: false, reason: 'rate_limited', detailSafe: true };
  }

  // 5. The subject is the caller. There is no other candidate in scope.
  return { ok: true, uid: caller.uid };
}

export type BootstrapStep =
  | 'write_pending_record'
  | 'set_claim'
  | 'verify_claim'
  | 'enable_record'
  | 'mark_completed';

export interface BootstrapObservedState {
  claimTrue: boolean;
  recordExists: boolean;
  recordEnabled: boolean;
}

/**
 * The fail-closed plan, derived from observed state so a retry resumes
 * instead of repeating. Every prefix of this plan leaves the dual gate
 * unsatisfied; only running it to completion grants authority.
 */
export function bootstrapPlan(state: BootstrapObservedState): BootstrapStep[] {
  const steps: BootstrapStep[] = [];
  // The record is created DISABLED first: if the claim write then lands
  // and everything else is lost, the surviving state is claim + disabled
  // record, which authorizeAdminCall refuses.
  if (!state.recordExists || !state.recordEnabled) steps.push('write_pending_record');
  if (!state.claimTrue) steps.push('set_claim');
  if (!state.claimTrue) steps.push('verify_claim');
  if (!state.recordEnabled) steps.push('enable_record');
  steps.push('mark_completed');
  return steps;
}

/** The stored platform_admins record. Created disabled; enabled last. */
export function buildPlatformAdminRecord(
  actor: { uid: string; email: string | null },
  serverTimestamp: unknown,
): Record<string, unknown> {
  return {
    enabled: false,
    policyVersion: ADMIN_POLICY_VERSION,
    schemaVersion: PLATFORM_ADMIN_RECORD_SCHEMA_VERSION,
    role: 'platform_admin',
    scope: 'platform',
    createdAt: serverTimestamp,
    createdBy: actor.uid,
    createdVia: 'first_admin_bootstrap',
    createdEmail: actor.email,
  };
}

/**
 * The audit record. Deliberately carries no claim values, no token
 * material and no credential-derived material — only who, how and when.
 */
export function buildBootstrapAudit(
  actor: { uid: string; email: string | null; method: string },
  serverTimestamp: unknown,
): Record<string, unknown> {
  return {
    operation: 'bootstrap_first_platform_admin',
    targetType: 'platform_admin',
    targetId: actor.uid,
    actorUid: actor.uid,
    actorEmail: actor.email,
    method: actor.method,
    at: serverTimestamp,
    adminPolicyVersion: ADMIN_POLICY_VERSION,
    schemaVersion: PLATFORM_ADMIN_RECORD_SCHEMA_VERSION,
  };
}
