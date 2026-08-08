/**
 * vc51.9V — server-authoritative rule for claiming a driver name index.
 *
 * `driver_name_index/{nameNorm}` is what authenticateDriver resolves a
 * display name through, so whoever holds it effectively owns that login
 * name. adminSetDriverPasscode claimed it unconditionally:
 *
 *   await fs().collection('driver_name_index').doc(nameNorm).set({ driverId });
 *
 * An authorized create/reset for one name could therefore repoint another
 * ACTIVE secure driver's index at a different driverId, sending that
 * driver's next sign-in to someone else's credential record.
 * adminApproveDriverRegistration already guards this transactionally; this
 * lifts the same rule into a pure function so every outcome is provable
 * without an emulator, and so an unreadable incumbent is an EXPLICIT
 * refusal rather than an accident of control flow.
 *
 * Nothing here sees a passcode, hash, or token — only identity and status.
 */

/** What we could learn about the credential the index currently points at. */
export type IncumbentCredentialState =
  /** No credential document — a legacy or orphaned binding. */
  | 'absent'
  /** Exists and `active !== false`. */
  | 'active'
  /** Exists and explicitly deactivated. */
  | 'inactive'
  /** The read failed. Status is unknown. */
  | 'unreadable';

export interface NameIndexClaimInput {
  /** Owner of nameNorm: an id, null when unbound, 'malformed' when unusable. */
  existingDriverId: string | null | 'malformed';
  /** The driverId about to be bound. */
  targetDriverId: string;
  incumbentCredential: IncumbentCredentialState;
}

export type NameIndexClaimDecision =
  | {
      allow: true;
      reason: 'absent' | 'same_driver' | 'incumbent_missing' | 'incumbent_inactive';
    }
  | { allow: false; reason: 'name_taken' | 'indeterminate' | 'malformed_owner' };

/**
 * Read the owner out of an index document.
 *
 * An index doc that EXISTS but carries no usable driverId is malformed, not
 * absent — something wrote a shape we do not understand, and overwriting it
 * could silently detach a real driver. Returns the sentinel so the caller
 * refuses rather than treating it as free.
 */
export function readIndexOwner(
  indexExists: boolean,
  raw: unknown,
): string | null | 'malformed' {
  if (!indexExists) return null;
  const id = (raw as { driverId?: unknown } | undefined)?.driverId;
  if (typeof id !== 'string') return 'malformed';
  if (id.trim() === '') return 'malformed';
  return id;
}

/**
 * Classify the incumbent's credential.
 *
 * `active` is only honored when it is a real boolean. Anything else —
 * missing, string, number, null — is NOT read as inactive: the schema does
 * not license that interpretation, and guessing "inactive" would hand away
 * a live driver's login name. Unknown shapes refuse.
 */
export function readIncumbentCredential(
  credentialExists: boolean,
  raw: unknown,
): IncumbentCredentialState {
  if (!credentialExists) return 'absent';
  const active = (raw as { active?: unknown } | undefined)?.active;
  if (active === false) return 'inactive';
  if (active === true || active === undefined) return 'active';
  // Present but uninterpretable — refuse rather than assume.
  return 'unreadable';
}

/**
 * May `targetDriverId` claim this name index?
 *
 * Order matters. Identity is checked before status, so reclaiming our own
 * index never depends on reading a credential — otherwise a transient read
 * failure would block a driver from resetting their own passcode.
 */
export function decideNameIndexClaim(
  input: NameIndexClaimInput,
): NameIndexClaimDecision {
  const { existingDriverId, targetDriverId, incumbentCredential } = input;

  if (existingDriverId === 'malformed') {
    return { allow: false, reason: 'malformed_owner' };
  }
  if (!existingDriverId) return { allow: true, reason: 'absent' };
  if (existingDriverId === targetDriverId) {
    return { allow: true, reason: 'same_driver' };
  }

  // A different driver holds it. Refuse unless we can positively establish
  // the incumbent is not a live secure identity.
  switch (incumbentCredential) {
    case 'unreadable':
      // Never guess about someone else's login name.
      return { allow: false, reason: 'indeterminate' };
    case 'absent':
      return { allow: true, reason: 'incumbent_missing' };
    case 'inactive':
      return { allow: true, reason: 'incumbent_inactive' };
    case 'active':
    default:
      return { allow: false, reason: 'name_taken' };
  }
}

/** Message shown to an admin when the claim is refused. Never leaks the holder. */
export function claimRefusalMessage(
  reason: 'name_taken' | 'indeterminate' | 'malformed_owner',
): string {
  if (reason === 'name_taken') {
    return 'Display name already taken by an active secure driver';
  }
  return 'Could not verify the current owner of this display name; try again';
}
