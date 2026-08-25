/** Human audit labels. Never print uid, driver hash, or approved-row key. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCanonicalDriverUuid(raw: unknown): raw is string {
  return typeof raw === 'string' && UUID_RE.test(raw.trim());
}

export function isMachineIdentity(raw: unknown): boolean {
  if (typeof raw !== 'string') return true;
  const s = raw.trim();
  if (!s) return true;
  if (UUID_RE.test(s)) return true;
  if (/^[0-9a-f]{32,128}$/i.test(s)) return true;
  if (/^[A-Za-z0-9]{20,36}$/.test(s) && /[0-9]/.test(s) && /[A-Za-z]/.test(s) && !/\s/.test(s)) {
    return true;
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

/** Stable canonical driver id from ticket/invoice identity fields. Never a name. */
export function canonicalDriverIdFromRecords(input: {
  ownerDriverId?: unknown;
  driverId?: unknown;
  submittedBy?: unknown;
  invoiceOwnerDriverId?: unknown;
  invoiceDriverId?: unknown;
}): string {
  const candidates = [
    input.ownerDriverId,
    input.driverId,
    input.invoiceOwnerDriverId,
    input.invoiceDriverId,
    input.submittedBy,
  ];
  for (const c of candidates) {
    if (isCanonicalDriverUuid(c)) return String(c).trim();
  }
  return '';
}

/**
 * Printed label: profile names from a BY-ID lookup, else a historical
 * person-shaped field already stored on the ticket, else Unknown driver.
 * Never scans a directory by name.
 */
export function resolveHumanAuditLabel(input: {
  legalName?: unknown;
  displayName?: unknown;
  historicalLabel?: unknown;
}): string {
  const legal = typeof input.legalName === 'string' ? input.legalName.trim() : '';
  if (looksLikePersonName(legal)) return legal;
  const display = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (looksLikePersonName(display)) return display;
  const historical = typeof input.historicalLabel === 'string' ? input.historicalLabel.trim() : '';
  if (looksLikePersonName(historical)) return historical;
  return 'Unknown driver';
}
