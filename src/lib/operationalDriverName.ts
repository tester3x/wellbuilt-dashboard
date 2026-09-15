/**
 * Operational driver name for human-facing Dashboard UI — pure, node-testable.
 *
 * Central identity policy: PREFER displayName (the operational name), fall back to
 * legalName (reserved for legal docs / when displayName is truly absent), then
 * 'Driver'. A login/username must NEVER appear.
 *
 * Field reality that forces the login guard: a driver profile's `displayName` can
 * literally be the login string — e.g. Mike ZFold7 Burger's profile has
 * displayName "Mikezfold" (his login) and legalName "Mike ZFold7 Burger" (his real
 * name). Applying displayName-first blindly would surface "Mikezfold". So when
 * displayName equals the known login alias, we fall through to legalName — which
 * both honors "prefer displayName for genuine display names" AND guarantees the
 * login never shows. (Acceptance: Coverage renders "Mike ZFold7 Burger", not
 * "Mikezfold", and not a blanket legal-name override for drivers whose displayName
 * is a real distinct name.)
 */

const t = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export interface DriverNameFields {
  displayName?: string | null;
  legalName?: string | null;
  /** The login/username alias (drivers/approved `name`). Never displayed. */
  loginAlias?: string | null;
}

export function operationalDriverName(d: DriverNameFields | null | undefined): string {
  const display = t(d?.displayName);
  const legal = t(d?.legalName);
  const login = t(d?.loginAlias);
  // Prefer displayName only when it is a genuine display name — not the login.
  if (display && (!login || display.toLowerCase() !== login.toLowerCase())) return display;
  if (legal) return legal;
  // displayName was only the login and there is no legal name — still never leak
  // the login: fall to the neutral placeholder.
  return 'Driver';
}
