/**
 * Governed INITIAL company binding for a canonical secure driver.
 *
 * WHY THIS EXISTS. The Dashboard's Company action patches
 * drivers/approved/{hash} client-side. A canonical secure driver lives at
 * drivers/profiles/{driverId} with a Firestore driver_shift_authority
 * pointer keyed by the SAME canonical UUID — a client-side company patch
 * can bind a profile without ever creating that authority, leaving Start
 * Shift permanently unverifiable (`authority_absent`). Binding a canonical
 * driver to a company is therefore a SERVER decision that must leave both
 * stores agreeing before it may report success.
 *
 * SCOPE, STATED PLAINLY. This is initial binding ONLY:
 *   - unbound canonical active driver → one existing active company.
 *   - a driver already bound to the SAME company is idempotent (the
 *     authority is ensured and the same logical success is reported);
 *   - a driver bound to a DIFFERENT company is a failed precondition.
 *     Cross-company transfer moves history and authority between tenants
 *     and is deliberately NOT implemented here.
 *
 * DURABLE ATTEMPT. Like secure provisioning, the write spans Firestore
 * (authority) and RTDB (profile) with no cross-store transaction. A journal
 * entry keyed by the driver id records the target BEFORE any write:
 *   - a crash between stores leaves an incomplete entry; the retry reads it
 *     back and converges on the same driver/company target;
 *   - concurrent same-target attempts converge on one entry;
 *   - a concurrent DIFFERENT-target attempt sees the entry and refuses —
 *     it can never interleave half of one binding with half of another.
 *
 * PURE. Decisions here take plain views of both stores and return data.
 * The transactional/network adapter is injected (see BindingIo), so the
 * whole refusal/crash/retry matrix runs against in-memory fakes.
 */
import {
  decideResolve,
  isCanonicalDriverIdShape,
  type ShiftAuthorityRecord,
} from './shiftAuthority';

/** One attempt per driver — the doc id IS the canonical driver id. */
export const COMPANY_BINDING_JOURNAL_COLLECTION = 'driver_company_binding_attempts';

/** Carries NO credential material, ever. */
export interface CompanyBindingJournalEntry {
  driverId: string;
  companyId: string;
  completed: boolean;
}

/** Minimal view of drivers/profiles/{driverId} this decision needs. */
export interface DriverProfileView {
  exists: boolean;
  active?: boolean;
  companyId?: string | null;
  companyName?: string | null;
  displayName?: string | null;
}

/** Minimal view of companies/{companyId}. */
export interface CompanyView {
  exists: boolean;
  /**
   * Firestore companies/{id}.status. Docs created by the Dashboard carry
   * 'active'; legacy docs may omit the field entirely, and absence must not
   * strand them — only an EXPLICIT non-active status refuses.
   */
  status?: string | null;
  name?: string | null;
}

export type BindingRefusal =
  | 'not_canonical_driver_id'
  | 'unknown_driver'
  | 'inactive_driver'
  | 'unknown_company'
  | 'inactive_company'
  | 'already_bound_elsewhere'
  | 'open_shift'
  | 'authority_mismatch'
  | 'authority_malformed'
  | 'binding_attempt_conflict';

export type BindingDecision =
  | { action: 'bind' }
  /** Same target again — report the same logical success, never a second bind. */
  | { action: 'already_bound_same' }
  | { action: 'refuse'; reason: BindingRefusal };

/**
 * Pure precondition decision. No I/O.
 *
 * Refusal order is deliberate: identity shape first (a legacy hash must be
 * rejected before any store is consulted), then the durable attempt record
 * (a different in-flight target refuses regardless of store state), then
 * subject/company existence, then binding state, then authority health.
 */
export function decideCompanyBinding(input: {
  driverId: string;
  companyId: string;
  profile: DriverProfileView;
  company: CompanyView;
  authority: ShiftAuthorityRecord | null;
  /** True when an authority doc exists but could not be read as a record. */
  authorityMalformed?: boolean;
  journal: CompanyBindingJournalEntry | null;
}): BindingDecision {
  const driverId = (input.driverId || '').trim();
  const companyId = (input.companyId || '').trim();

  // A 64-hex legacy passcode hash is credential material, not identity —
  // it can never become an authority document id through this path.
  if (!driverId || !isCanonicalDriverIdShape(driverId)) {
    return { action: 'refuse', reason: 'not_canonical_driver_id' };
  }
  if (!companyId) {
    return { action: 'refuse', reason: 'unknown_company' };
  }

  // The durable attempt record wins over store state: an in-flight or
  // completed attempt for a DIFFERENT company means this call and that
  // attempt disagree about the target, and neither may proceed blind.
  if (input.journal && input.journal.companyId !== companyId) {
    return { action: 'refuse', reason: 'binding_attempt_conflict' };
  }

  if (!input.profile.exists) {
    return { action: 'refuse', reason: 'unknown_driver' };
  }
  if (input.profile.active === false) {
    return { action: 'refuse', reason: 'inactive_driver' };
  }
  if (!input.company.exists) {
    return { action: 'refuse', reason: 'unknown_company' };
  }
  if (typeof input.company.status === 'string' && input.company.status !== 'active') {
    return { action: 'refuse', reason: 'inactive_company' };
  }

  const boundTo = (input.profile.companyId || '').trim();
  if (boundTo && boundTo !== companyId) {
    // NOT a transfer path. The caller gets an explicit precondition
    // failure; moving a driver between companies is a separate, future,
    // deliberately-designed operation.
    return { action: 'refuse', reason: 'already_bound_elsewhere' };
  }

  // Authority health. Absence is fine (ensure will create); presence must
  // belong to THIS driver and THIS company, and must not be half-written.
  if (input.authorityMalformed) {
    return { action: 'refuse', reason: 'authority_malformed' };
  }
  const record = input.authority;
  if (record) {
    if (record.driverId !== driverId || record.companyId !== companyId) {
      // A pointer for another subject or tenant is never overwritten.
      return { action: 'refuse', reason: 'authority_mismatch' };
    }
    const resolved = decideResolve(record, { driverId, companyId });
    if (resolved.state === 'open') {
      // An open work period must never be disturbed by a binding call.
      return { action: 'refuse', reason: 'open_shift' };
    }
    if (resolved.state === 'unverifiable') {
      // Uninitialized-but-empty is completable (ensure initializes it);
      // any half-open or inconsistent shape refuses.
      const hasPeriod = record.openPeriodId !== null && record.openPeriodId !== undefined;
      const hasDate = record.originLocalDate !== null && record.originLocalDate !== undefined;
      if (hasPeriod || hasDate || resolved.reason !== 'authority_uninitialized') {
        return { action: 'refuse', reason: 'authority_malformed' };
      }
    }
  }

  return boundTo === companyId
    ? { action: 'already_bound_same' }
    : { action: 'bind' };
}

// ── completion gate ───────────────────────────────────────────────────────

/** What the orchestrator observed AFTER attempting the writes. */
export interface BindingState {
  targetCompanyId: string;
  /** Read back from the profile after the write. */
  profileCompanyId: string | null;
  /** From ensureInitializedEmptyShiftAuthority. */
  authorityAction: 'create' | 'noop' | 'initialize_uninitialized' | 'refuse' | 'skip' | 'not_attempted';
  /** Read back from the authority record after ensure. */
  authorityCompanyId: string | null;
}

export type BindingOutcome =
  | { ok: true; authority: 'created' | 'initialized' | 'preserved' }
  | { ok: false; reason: 'authority_refused' | 'authority_missing' | 'profile_mismatch' };

/**
 * May this attempt be reported as successful and finalized? ONLY when both
 * stores agree on the target. A binding whose profile write never landed, or
 * whose authority ensure was skipped/refused, is a failure — reporting it as
 * success is exactly the defect this operation exists to close.
 */
export function decideBindingOutcome(state: BindingState): BindingOutcome {
  if (state.authorityAction === 'refuse') return { ok: false, reason: 'authority_refused' };
  if (state.authorityAction === 'skip' || state.authorityAction === 'not_attempted') {
    return { ok: false, reason: 'authority_missing' };
  }
  if (state.authorityCompanyId !== state.targetCompanyId) {
    return { ok: false, reason: 'authority_missing' };
  }
  if (state.profileCompanyId !== state.targetCompanyId) {
    return { ok: false, reason: 'profile_mismatch' };
  }
  switch (state.authorityAction) {
    case 'create': return { ok: true, authority: 'created' };
    case 'initialize_uninitialized': return { ok: true, authority: 'initialized' };
    default: return { ok: true, authority: 'preserved' };
  }
}

// ── injected I/O ──────────────────────────────────────────────────────────

export interface CompanyBindingJournalDeps {
  read(driverId: string): Promise<CompanyBindingJournalEntry | null>;
  /** Transactional get-or-create. Concurrent claims MUST converge. */
  claim(driverId: string, candidate: CompanyBindingJournalEntry): Promise<CompanyBindingJournalEntry>;
  markCompleted(driverId: string): Promise<void>;
}

export interface BindingIo {
  readProfile(driverId: string): Promise<DriverProfileView>;
  readCompany(companyId: string): Promise<CompanyView>;
  readAuthority(driverId: string): Promise<{
    record: ShiftAuthorityRecord | null;
    malformed: boolean;
  }>;
  /** Wraps ensureInitializedEmptyShiftAuthority — transactional. */
  ensureAuthority(driverId: string, companyId: string): Promise<
    'create' | 'noop' | 'initialize_uninitialized' | 'refuse' | 'skip'
  >;
  writeProfileBinding(
    driverId: string,
    companyId: string,
    companyName: string | null,
  ): Promise<void>;
  journal: CompanyBindingJournalDeps;
}

export type BindingResult =
  | {
      ok: true;
      companyId: string;
      companyName: string | null;
      alreadyBound: boolean;
      authority: 'created' | 'initialized' | 'preserved';
    }
  | { ok: false; reason: BindingRefusal | 'authority_refused' | 'authority_missing' | 'profile_mismatch' };

/**
 * The whole governed operation, against injected I/O.
 *
 * Write order: journal → authority (Firestore) → profile (RTDB) → verify →
 * finalize. A crash after ANY step leaves either an inert incomplete journal
 * entry (safe: retry converges on the same target) or a completed pair of
 * agreeing stores. Success is only reported after both stores are read back
 * agreeing, and the journal is only marked completed after that.
 */
export async function executeCompanyBinding(
  io: BindingIo,
  input: { driverId: string; companyId: string },
): Promise<BindingResult> {
  const driverId = (input.driverId || '').trim();
  const companyId = (input.companyId || '').trim();

  const [profile, company, authority, journal] = [
    await io.readProfile(driverId),
    await io.readCompany(companyId),
    await io.readAuthority(driverId),
    await io.journal.read(driverId),
  ];

  const decision = decideCompanyBinding({
    driverId,
    companyId,
    profile,
    company,
    authority: authority.record,
    authorityMalformed: authority.malformed,
    journal,
  });
  if (decision.action === 'refuse') {
    return { ok: false, reason: decision.reason };
  }

  // Durable target claim BEFORE any store write. If a concurrent attempt
  // committed a different target between our read and this claim, the
  // returned entry names it and we refuse rather than interleave.
  const entry = await io.journal.claim(driverId, {
    driverId,
    companyId,
    completed: false,
  });
  if (entry.companyId !== companyId) {
    return { ok: false, reason: 'binding_attempt_conflict' };
  }

  // Authority first: it is the store whose ABSENCE is the standing defect.
  // ensure is idempotent and preserves healthy/open/history state by design.
  const authorityAction = await io.ensureAuthority(driverId, companyId);

  // Profile second. On the already-bound-same path this rewrite is a no-op
  // by value; on a crash-retry it is exactly the missing half.
  const companyName = company.name ?? null;
  if (authorityAction !== 'refuse') {
    await io.writeProfileBinding(driverId, companyId, companyName);
  }

  // Verify BOTH stores agree before reporting anything.
  const profileAfter = await io.readProfile(driverId);
  const authorityAfter = await io.readAuthority(driverId);
  const outcome = decideBindingOutcome({
    targetCompanyId: companyId,
    profileCompanyId: (profileAfter.companyId || '').trim() || null,
    authorityAction,
    authorityCompanyId: authorityAfter.record?.companyId ?? null,
  });
  if (!outcome.ok) {
    // NOT completed — the journal entry stays, and a retry converges on
    // this same driver/company target.
    return { ok: false, reason: outcome.reason };
  }

  await io.journal.markCompleted(driverId);
  return {
    ok: true,
    companyId,
    companyName,
    alreadyBound: decision.action === 'already_bound_same',
    authority: outcome.authority,
  };
}
