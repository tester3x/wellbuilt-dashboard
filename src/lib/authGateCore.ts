/**
 * Auth/company hydration gate — pure, node-testable.
 *
 * Root-cause fix for "hard refresh of a deep-linked screen bounces to home":
 * capability-gated pages redirected with `router.push('/')` while `loading` was
 * already false but `userCompany` had not finished loading (it hydrates in a
 * separate effect after the user resolves). During that window a capability check
 * ran against a null company config, evaluated false, and navigated home.
 *
 * The fix is an EXPLICIT unresolved state: no fallback navigation is allowed until
 * BOTH auth and company hydration have settled. This never masks the race with a
 * timer — it waits on a real signal (`authResolved`).
 */

export type AuthGateDecision = 'wait' | 'login' | 'home' | 'allow';

/**
 * Decide what a capability-gated page should do.
 *   - not resolved yet            → 'wait'  (render a loading state; navigate nowhere)
 *   - resolved + no user          → 'login'
 *   - resolved + user + no access → 'home'
 *   - resolved + user + access    → 'allow'
 *
 * `authResolved` MUST be true only once auth AND the user's company config have
 * settled (see AuthContext.authResolved), so 'home' can never fire during hydration.
 */
export function resolveAuthGate(input: {
  authResolved: boolean;
  hasUser: boolean;
  hasAccess?: boolean; // omitted ⇒ page has no capability gate beyond being signed in
}): AuthGateDecision {
  if (!input.authResolved) return 'wait';
  if (!input.hasUser) return 'login';
  if (input.hasAccess === false) return 'home';
  return 'allow';
}

/**
 * Compute `authResolved` from the AuthContext primitives. Auth is resolved once the
 * auth subscription has settled (`!loading`) AND, when the user is scoped to a
 * company, that company's config has finished loading (`!companyLoading`). WB admins
 * (no companyId) need no company load, so they resolve as soon as auth settles.
 */
export function computeAuthResolved(input: {
  loading: boolean;
  companyLoading: boolean;
}): boolean {
  return !input.loading && !input.companyLoading;
}
