/** Human audit labels. Never print uid, driver hash, or approved-row key. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_HASH_RE = /^[0-9a-f]{32,128}$/i;
const FIREBASE_UID_RE = /^[A-Za-z0-9]{20,36}$/;

export function isMachineIdentity(raw: unknown): boolean {
  if (typeof raw !== 'string') return true;
  const s = raw.trim();
  if (!s) return true;
  if (UUID_RE.test(s)) return true;
  if (HEX_HASH_RE.test(s)) return true;
  if (FIREBASE_UID_RE.test(s) && !/\s/.test(s) && !/[a-z].*[A-Z]|[A-Z].*[a-z]/.test(s) && !/\s/.test(s)) {
    // Firebase uids are mixed alnum without spaces; person names have spaces or mixed case words.
    if (!s.includes(' ') && /[0-9]/.test(s) && /[A-Za-z]/.test(s)) return true;
  }
  return false;
}

export function looksLikePersonName(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (s.length < 2) return false;
  if (isMachineIdentity(s)) return false;
  return /[A-Za-z]/.test(s);
}

/**
 * Resolve the printed audit/driver label.
 * legalName / displayName win; a person-shaped driver field is next;
 * machine identifiers are never printed.
 */
export function resolveHumanAuditLabel(input: {
  legalName?: unknown;
  displayName?: unknown;
  driverField?: unknown;
  submittedBy?: unknown;
}): string {
  const legal = typeof input.legalName === 'string' ? input.legalName.trim() : '';
  if (looksLikePersonName(legal)) return legal;
  const display = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (looksLikePersonName(display)) return display;
  const driver = typeof input.driverField === 'string' ? input.driverField.trim() : '';
  if (looksLikePersonName(driver)) return driver;
  return 'Unknown driver';
}
