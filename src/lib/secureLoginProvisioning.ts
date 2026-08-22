/**
 * vc51.9U — deciding what a driver row's secure-credential action means.
 *
 * Two operations look similar in the UI and are NOT interchangeable:
 *
 *   CREATE SECURE LOGIN — the row is a legacy-only entry whose "id" is the
 *     passcode hash itself (RTDB drivers/approved/{hash}). There is no
 *     canonical identity to reset. A brand-new random driverId is minted;
 *     old records stay under the old id and do not follow the driver.
 *
 *   RESET PASSCODE — the row already has a canonical, non-credential-derived
 *     driverId. Only the credential is replaced; identity and history are
 *     untouched.
 *
 * Conflating them is destructive in both directions: resetting against a
 * hash-derived id would permanently enshrine credential material as
 * identity, and minting a fresh id for an already-secure driver would
 * orphan live records.
 *
 * The request builder supplies NEITHER `driverId` NOR `legacyHash` when
 * creating. It DOES send `approvedKey` equal to the exact RTDB row the
 * admin clicked so the server can copy WB-M routes and stamp
 * `migratedToDriverId` on that row. `legacyHash` is still forbidden: that
 * branch writes `migratedFromLegacyHashPrefix` into the new profile.
 */

/** Minimum shape this module needs from a driver row. */
export interface DriverRowLike {
  /** RTDB key. For legacy rows this IS the passcode hash. */
  key: string;
  displayName: string;
  legalName?: string;
  companyId?: string;
  companyName?: string;
  /** Canonical id, when the row has already been provisioned. */
  driverId?: string;
}

export type CredentialAction = 'create_secure_login' | 'reset_passcode';

/**
 * A canonical id must not be the RTDB key: for legacy rows that key is the
 * passcode hash, and treating it as identity is exactly what this decision
 * exists to prevent.
 */
export function hasCanonicalDriverId(row: DriverRowLike): boolean {
  const id = (row.driverId || '').trim();
  if (!id) return false;
  return id !== row.key;
}

/** Which operation does this row need? */
export function credentialActionFor(row: DriverRowLike): CredentialAction {
  return hasCanonicalDriverId(row) ? 'reset_passcode' : 'create_secure_login';
}

/** Server-authoritative policy, mirrored as guidance only. */
export const PASSCODE_GUIDANCE =
  'At least 6 characters. Short numeric PINs are not accepted.';

/**
 * Client-side gate. Deliberately permissive relative to the server: it
 * blocks only what the server certainly rejects, so the server stays the
 * authority and a stricter client can never silently diverge from it.
 */
export function localPolicyError(passcode: string): string | null {
  if (passcode.length < 6) return 'Must be at least 6 characters.';
  if (/^\d{1,5}$/.test(passcode)) return 'Short numeric PINs are not accepted.';
  return null;
}

export function canSubmit(input: {
  passcode: string;
  confirm: string;
  submitting: boolean;
}): boolean {
  if (input.submitting) return false;
  if (!input.passcode || !input.confirm) return false;
  if (input.passcode !== input.confirm) return false;
  return localPolicyError(input.passcode) === null;
}

export interface SetPasscodeRequest {
  displayName: string;
  passcode: string;
  temporary: false;
  driverId?: string;
  legalName?: string;
  companyId?: string;
  companyName?: string;
  /** Exact drivers/approved key of the row being converted. Never a name. */
  approvedKey?: string;
}

/**
 * Build the callable payload.
 *
 * `temporary` is ALWAYS false and always explicit. The server defaults it
 * to true (`data.temporary !== false`), and the forced-change lifecycle is
 * incomplete — `driverChangeOwnPasscode` is not deployed and WB-S has no
 * mandatory change screen — so an omitted flag would strand the account
 * with a `mustResetPasscode` nothing can clear.
 */
/**
 * Emergency convert-from-approved request. Profile metadata is owned by
 * the approved row on the server — the client must not send it.
 */
export function buildConvertApprovedDriverRequest(
  row: DriverRowLike,
  passcode: string,
): {
  displayName: string;
  passcode: string;
  temporary: false;
  approvedKey: string;
} {
  return {
    displayName: row.displayName,
    passcode,
    temporary: false,
    approvedKey: row.key,
  };
}

export function buildSetPasscodeRequest(
  row: DriverRowLike,
  passcode: string,
): SetPasscodeRequest {
  const base: SetPasscodeRequest = {
    displayName: row.displayName,
    passcode,
    temporary: false,
  };
  if (row.legalName) base.legalName = row.legalName;
  if (row.companyId) base.companyId = row.companyId;
  if (row.companyName) base.companyName = row.companyName;

  if (credentialActionFor(row) === 'reset_passcode') {
    // Canonical id only — never the RTDB key.
    base.driverId = (row.driverId || '').trim();
  } else {
    // Create: bind the exact approved row the admin clicked — not a name search.
    base.approvedKey = row.key;
  }
  return base;
}

// ── Company action routing (Phase C) ─────────────────────────────────────
//
// The Company modal serves two very different kinds of row:
//
//   LEGACY-ONLY row — its key is the passcode hash and no canonical profile
//     exists. Company selection there is STAGING METADATA: it rides along
//     into buildSetPasscodeRequest when the secure login is later created.
//     The pre-existing client RTDB write to drivers/approved is acceptable
//     for that, because nothing reads it as canonical authority.
//
//   CANONICAL row — a secure profile and (if bound) a shift authority exist
//     under the canonical UUID. Binding one client-side can produce a
//     profile company with NO authority, which is the exact defect the
//     governed adminBindDriverCompany callable closes. So canonical rows
//     route to the callable — and ONLY for initial binding: transfer and
//     unbind are refused with explicit copy, never silently patched.

export type CompanyActionRoute =
  /** Canonical row, initial (or idempotent same-target) bind → callable. */
  | 'governed_bind'
  /** Canonical row already bound to a DIFFERENT company — not supported here. */
  | 'blocked_transfer'
  /** Canonical row, removal requested — no governed unbind exists yet. */
  | 'blocked_unbind'
  /** Legacy-only row — staging metadata for the future secure creation. */
  | 'legacy_staging';

export function companyActionRouteFor(
  row: DriverRowLike & { companyId?: string },
  targetCompanyId: string,
): CompanyActionRoute {
  if (!hasCanonicalDriverId(row)) return 'legacy_staging';
  const target = targetCompanyId.trim().toLowerCase();
  if (!target) return 'blocked_unbind';
  const bound = (row.companyId || '').trim();
  if (bound && bound !== target) return 'blocked_transfer';
  return 'governed_bind';
}

/** Copy shown before a destructive-by-omission operation. */
export function confirmationCopyFor(action: CredentialAction): string[] {
  if (action === 'create_secure_login') {
    return [
      'A new secure driver identity will be created.',
      'Existing history stays under the old identity and will not appear under this new login.',
      'Nothing is deleted by this operation.',
    ];
  }
  return ['The existing secure identity is kept. Only the passcode is replaced.'];
}
