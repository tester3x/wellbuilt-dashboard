/**
 * Durable provisioning journal — one canonical UUID per governed attempt.
 *
 * WHY THIS EXISTS. Secure onboarding spans three stores: Firestore identity
 * records (name index + credentials), an RTDB profile, and a Firestore
 * shift-authority pointer. No transaction spans them, so an attempt can
 * fail part-way. Before this, a retry MINTED A NEW UUID — leaving the first
 * identity stranded and the driver with no authority — and the approval
 * path deleted the pending credential before the authority existed, so the
 * attempt could not be resumed at all.
 *
 * The journal fixes both by making the UUID a DURABLE DECISION rather than
 * a per-invocation accident: the first attempt writes {attemptKey → uuid},
 * every retry reads it back, and the attempt is finalized only once the
 * required state actually exists.
 *
 * NEVER ADOPTS A STRANGER. A matching normalized display name is NOT
 * evidence of a retry — two unrelated people can share one. Only the
 * journal entry for THIS attempt key authorizes reusing a UUID, and an
 * index owned by anyone else is refused rather than absorbed.
 *
 * Pure decisions here; the transactional I/O adapter is injected, so the
 * whole failure/retry matrix runs against in-memory fakes.
 */

/** Identifies ONE governed provisioning attempt, durably. */
export type ProvisioningAttemptKey =
  /** Approval of a specific pending registration. */
  | { kind: 'pending'; pendingId: string }
  /** Migration of a specific legacy approved row. */
  | { kind: 'legacy'; legacyHash: string }
  /** Direct secure creation for a normalized display name. */
  | { kind: 'name'; nameNorm: string };

export function attemptKeyId(key: ProvisioningAttemptKey): string {
  switch (key.kind) {
    case 'pending': return `pending:${key.pendingId}`;
    case 'legacy': return `legacy:${key.legacyHash}`;
    case 'name': return `name:${key.nameNorm}`;
  }
}

/** The stored journal entry. Carries NO credential material, ever. */
export interface ProvisioningJournalEntry {
  attemptId: string;
  driverId: string;
  nameNorm: string;
  companyId: string | null;
  /** Set once the attempt's required state exists. */
  completed: boolean;
}

export type ProvisioningIdentityDecision =
  /** No prior attempt — mint and record a fresh UUID. */
  | { action: 'mint'; reason: 'new_attempt' }
  /** A prior attempt exists — reuse its UUID. */
  | { action: 'reuse'; driverId: string; reason: 'journal_retry' | 'caller_supplied' | 'established_driver' }
  /** Already finished — report the same logical success. */
  | { action: 'already_completed'; driverId: string }
  /** Refuse rather than absorb someone else's identity. */
  | { action: 'refuse'; reason: 'unrelated_name_owner' | 'journal_name_mismatch' | 'journal_driver_conflict' };

/**
 * Decide which canonical UUID a provisioning attempt must use.
 *
 * Precedence, and why:
 *   1. journal entry     — the durable record of THIS attempt. Highest,
 *                          because it is the only evidence that survives a
 *                          crash and cannot be confused with another driver.
 *   2. caller-supplied   — an explicit reset/second call for a known driver.
 *   3. established owner — the name index points at an ACTIVE credential
 *                          for this same attempt's target, i.e. a reset.
 *   4. mint              — genuinely new.
 *
 * An index owned by an active credential that this attempt did not create
 * is `unrelated_name_owner`: refused, never adopted.
 */
export function decideProvisioningIdentity(input: {
  /** Explicit driverId from the caller, when the client knows it. */
  requestedDriverId?: string | null;
  /** Journal entry for this attempt key, if any. */
  journal?: ProvisioningJournalEntry | null;
  /** Current owner of the normalized name, if any. */
  indexOwnerDriverId?: string | null;
  /** Whether that owner's credential is active. */
  indexOwnerActive?: boolean;
  /** Normalized display name this attempt is provisioning. */
  nameNorm: string;
  /** True when the attempt is an admin reset of an established driver. */
  isReset?: boolean;
}): ProvisioningIdentityDecision {
  const requested = (input.requestedDriverId ?? '').trim();
  const journal = input.journal ?? null;
  const owner = (input.indexOwnerDriverId ?? '').trim();

  // 1. The durable record of this attempt wins outright.
  if (journal) {
    if (journal.nameNorm !== input.nameNorm) {
      // The attempt key was reused for a different name — refuse rather
      // than provision one person's identity under another's attempt.
      return { action: 'refuse', reason: 'journal_name_mismatch' };
    }
    // A weak attempt key (a normalized display name) can outlive the driver
    // it was minted for. If the name has since changed hands to an ACTIVE
    // different credential, the journal entry describes someone else — reuse
    // would write this attempt's credential onto their identity.
    if (owner && input.indexOwnerActive !== false && owner !== journal.driverId) {
      return { action: 'refuse', reason: 'unrelated_name_owner' };
    }
    // The caller named a different driver than the durable record. One of
    // the two is wrong; silently preferring either would provision blind.
    if (requested && requested !== journal.driverId) {
      return { action: 'refuse', reason: 'journal_driver_conflict' };
    }
    if (journal.completed) {
      return { action: 'already_completed', driverId: journal.driverId };
    }
    return { action: 'reuse', driverId: journal.driverId, reason: 'journal_retry' };
  }

  // 2. The caller naming a driver is an explicit, authorized statement.
  if (requested) {
    return { action: 'reuse', driverId: requested, reason: 'caller_supplied' };
  }

  // 3/4. No journal, no caller id: the name index is the only signal, and a
  // matching name is NOT proof of a retry.
  if (owner && input.indexOwnerActive !== false) {
    if (input.isReset) {
      return { action: 'reuse', driverId: owner, reason: 'established_driver' };
    }
    return { action: 'refuse', reason: 'unrelated_name_owner' };
  }

  return { action: 'mint', reason: 'new_attempt' };
}

// ── injected I/O ──────────────────────────────────────────────────────────

export interface ProvisioningJournalDeps {
  /** Transactional get-or-create. Concurrent callers MUST converge. */
  claim(attemptId: string, candidate: ProvisioningJournalEntry): Promise<ProvisioningJournalEntry>;
  read(attemptId: string): Promise<ProvisioningJournalEntry | null>;
  markCompleted(attemptId: string): Promise<void>;
  newUuid(): string;
}

/**
 * Resolve the canonical UUID for an attempt, recording it durably.
 *
 * `claim` is get-or-create inside one transaction, so two concurrent
 * retries converge on whichever entry commits first — neither mints a
 * second identity.
 */
export async function resolveProvisioningUuid(
  deps: ProvisioningJournalDeps,
  key: ProvisioningAttemptKey,
  input: {
    requestedDriverId?: string | null;
    nameNorm: string;
    companyId: string | null;
    indexOwnerDriverId?: string | null;
    indexOwnerActive?: boolean;
    isReset?: boolean;
  },
): Promise<{ decision: ProvisioningIdentityDecision; driverId: string | null; attemptId: string }> {
  const attemptId = attemptKeyId(key);
  const journal = await deps.read(attemptId);
  const decision = decideProvisioningIdentity({ ...input, journal });

  if (decision.action === 'refuse') {
    return { decision, driverId: null, attemptId };
  }
  if (decision.action === 'already_completed' || decision.action === 'reuse') {
    // A caller-supplied or established id still gets journaled, so the NEXT
    // retry is decided by the durable record rather than by the index again.
    if (!journal && decision.action === 'reuse') {
      const entry = await deps.claim(attemptId, {
        attemptId,
        driverId: decision.driverId,
        nameNorm: input.nameNorm,
        companyId: input.companyId,
        completed: false,
      });
      return { decision, driverId: entry.driverId, attemptId };
    }
    return { decision, driverId: decision.driverId, attemptId };
  }

  // Mint — but through claim(), so a concurrent attempt that already
  // committed its own UUID wins and this one adopts it.
  const entry = await deps.claim(attemptId, {
    attemptId,
    driverId: deps.newUuid(),
    nameNorm: input.nameNorm,
    companyId: input.companyId,
    completed: false,
  });
  return { decision, driverId: entry.driverId, attemptId };
}

// ── completion gate ───────────────────────────────────────────────────────

/** What the caller observed after attempting each provisioning step. */
export interface ProvisioningState {
  identityWritten: boolean;
  profileWritten: boolean;
  /** From ensureInitializedEmptyShiftAuthority. */
  authorityAction: 'create' | 'noop' | 'initialize_uninitialized' | 'skip' | 'refuse' | 'not_attempted';
  /** The company the profile was bound to, or null for standalone. */
  companyId: string | null;
}

export type ProvisioningOutcome =
  | { ok: true; authority: 'created' | 'initialized' | 'preserved' | 'skipped_standalone' }
  | { ok: false; reason: 'identity_incomplete' | 'profile_incomplete' | 'authority_refused' | 'authority_missing_for_company' };

/**
 * May this attempt be reported as successful and finalized?
 *
 * A COMPANY-BOUND attempt that skipped authority is a failure, not a
 * success — `skip` means no company was seen, which contradicts the
 * binding and would leave the driver unable to claim a shift. Only a
 * genuinely unbound standalone driver may skip.
 */
export function decideProvisioningOutcome(state: ProvisioningState): ProvisioningOutcome {
  if (!state.identityWritten) return { ok: false, reason: 'identity_incomplete' };
  if (!state.profileWritten) return { ok: false, reason: 'profile_incomplete' };

  if (state.authorityAction === 'refuse') return { ok: false, reason: 'authority_refused' };

  if (state.companyId) {
    switch (state.authorityAction) {
      case 'create': return { ok: true, authority: 'created' };
      case 'initialize_uninitialized': return { ok: true, authority: 'initialized' };
      case 'noop': return { ok: true, authority: 'preserved' };
      // A company was bound but ensure saw none, or was never run.
      case 'skip':
      case 'not_attempted':
      default:
        return { ok: false, reason: 'authority_missing_for_company' };
    }
  }
  // Standalone: skipping is the correct, honest outcome.
  return state.authorityAction === 'skip' || state.authorityAction === 'not_attempted'
    ? { ok: true, authority: 'skipped_standalone' }
    : { ok: true, authority: state.authorityAction === 'create' ? 'created'
      : state.authorityAction === 'initialize_uninitialized' ? 'initialized' : 'preserved' };
}

/** Bounded, secret-free audit label for the authority outcome. */
export function authorityAuditLabel(outcome: ProvisioningOutcome): string {
  return outcome.ok ? outcome.authority : `failed:${outcome.reason}`;
}
