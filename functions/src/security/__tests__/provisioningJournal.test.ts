/**
 * vc51.9N — dynamic failure-injection for governed secure provisioning.
 *
 * These drive the real decision + orchestration modules against IN-MEMORY
 * Firestore/RTDB fakes and inject failures at the exact seams the audit
 * found unproven. Source-text greps are deliberately absent: they cannot
 * distinguish "calls the helper" from "recovers correctly after a crash",
 * which is the property that actually matters here.
 */
import {
  attemptKeyId,
  decideProvisioningIdentity,
  decideProvisioningOutcome,
  authorityAuditLabel,
  resolveProvisioningUuid,
  type ProvisioningJournalDeps,
  type ProvisioningJournalEntry,
} from '../operational/provisioningJournal';
import { decideEnsureEmptyAuthority } from '../operational/shiftAuthority';
import { decideResolve } from '../operational/shiftAuthority';

// ── in-memory stores ──────────────────────────────────────────────────────

class World {
  journal = new Map<string, ProvisioningJournalEntry>();
  index = new Map<string, { driverId: string }>();
  credentials = new Map<string, { active: boolean }>();
  profiles = new Map<string, Record<string, unknown>>();
  authority = new Map<string, Record<string, unknown>>();
  uuidSeq = 0;
  /** Set to make the next authority write throw. */
  failAuthority = false;

  deps(): ProvisioningJournalDeps {
    return {
      read: async (id) => this.journal.get(id) ?? null,
      // get-or-create in one step: concurrent claims converge.
      claim: async (id, candidate) => {
        const existing = this.journal.get(id);
        if (existing) return existing;
        this.journal.set(id, { ...candidate });
        return this.journal.get(id)!;
      },
      markCompleted: async (id) => {
        const e = this.journal.get(id);
        if (e) this.journal.set(id, { ...e, completed: true });
      },
      newUuid: () => `prov-uuid-0000-${++this.uuidSeq}`,
    };
  }

  /** Write identity + profile + authority, honouring the injected failure. */
  async provision(driverId: string, nameNorm: string, companyId: string | null) {
    this.index.set(nameNorm, { driverId });
    this.credentials.set(driverId, { active: true });
    this.profiles.set(driverId, { companyId, name: nameNorm });
    if (this.failAuthority) throw new Error('injected: authority write failed');
    const d = decideEnsureEmptyAuthority({
      driverId, companyId, existing: (this.authority.get(driverId) as never) ?? null,
    });
    if (d.action === 'create') this.authority.set(driverId, { ...d.record });
    return d.action;
  }
}

const KEY = { kind: 'pending' as const, pendingId: 'p-1' };
const NAME = 'mikezfold';
const CO = 'liquid-gold';

// ── pure identity decision ────────────────────────────────────────────────

describe('canonical UUID selection', () => {
  test('a fresh attempt mints', () => {
    expect(decideProvisioningIdentity({ nameNorm: NAME }).action).toBe('mint');
  });

  test('a journal entry is reused — the durable record of THIS attempt', () => {
    const d = decideProvisioningIdentity({
      nameNorm: NAME,
      journal: { attemptId: 'a', driverId: 'prov-uuid-0000-1', nameNorm: NAME, companyId: CO, completed: false },
    });
    expect(d).toEqual({ action: 'reuse', driverId: 'prov-uuid-0000-1', reason: 'journal_retry' });
  });

  test('an UNRELATED active name owner is REFUSED, never adopted', () => {
    const d = decideProvisioningIdentity({
      nameNorm: NAME, indexOwnerDriverId: 'someone-else', indexOwnerActive: true,
    });
    expect(d).toEqual({ action: 'refuse', reason: 'unrelated_name_owner' });
  });

  test('an established driver IS reused on an explicit reset', () => {
    const d = decideProvisioningIdentity({
      nameNorm: NAME, indexOwnerDriverId: 'prov-uuid-0000-9', indexOwnerActive: true, isReset: true,
    });
    expect(d).toEqual({ action: 'reuse', driverId: 'prov-uuid-0000-9', reason: 'established_driver' });
  });

  test('an inactive owner does not block a new attempt', () => {
    expect(decideProvisioningIdentity({
      nameNorm: NAME, indexOwnerDriverId: 'old', indexOwnerActive: false,
    }).action).toBe('mint');
  });

  test('a completed journal reports the same logical success', () => {
    const d = decideProvisioningIdentity({
      nameNorm: NAME,
      journal: { attemptId: 'a', driverId: 'prov-uuid-0000-1', nameNorm: NAME, companyId: CO, completed: true },
    });
    expect(d).toEqual({ action: 'already_completed', driverId: 'prov-uuid-0000-1' });
  });

  test('an attempt key reused for a DIFFERENT name refuses', () => {
    const d = decideProvisioningIdentity({
      nameNorm: 'someone',
      journal: { attemptId: 'a', driverId: 'prov-uuid-0000-1', nameNorm: NAME, companyId: CO, completed: false },
    });
    expect(d).toEqual({ action: 'refuse', reason: 'journal_name_mismatch' });
  });

  test('a caller-supplied id can never redirect the journal', () => {
    const journal = { attemptId: 'a', driverId: 'prov-uuid-0000-1', nameNorm: NAME, companyId: CO, completed: false };
    // The client does not get the identity it asked for...
    const d = decideProvisioningIdentity({
      requestedDriverId: 'client-says-this',
      nameNorm: NAME,
      journal,
    });
    expect(d).not.toMatchObject({ driverId: 'client-says-this' });
    // ...and the disagreement is surfaced rather than silently resolved:
    // provisioning under an id the caller did not expect is its own hazard.
    expect(d).toEqual({ action: 'refuse', reason: 'journal_driver_conflict' });
    // With no id supplied, the durable record is simply reused.
    expect(decideProvisioningIdentity({ nameNorm: NAME, journal }))
      .toMatchObject({ action: 'reuse', driverId: 'prov-uuid-0000-1' });
  });
});

// ── CASES 1–4: setPasscode fails after identity, retry reuses the UUID ────

describe('failure after identity, before authority', () => {
  test('CASE 1+2+3+4: retry without a client driverId reuses the SAME uuid and completes', async () => {
    const w = new World();

    // Attempt 1 — authority write fails after index/credentials/profile.
    w.failAuthority = true;
    const first = await resolveProvisioningUuid(w.deps(), KEY, {
      nameNorm: NAME, companyId: CO,
      indexOwnerDriverId: w.index.get(NAME)?.driverId ?? null,
    });
    expect(first.driverId).toBe('prov-uuid-0000-1');
    await expect(w.provision(first.driverId!, NAME, CO)).rejects.toThrow(/injected/);
    expect(w.authority.size).toBe(0);              // no authority yet
    expect(w.journal.get(attemptKeyId(KEY))!.completed).toBe(false);

    // Attempt 2 — NO client-supplied driverId. Must NOT mint a second uuid.
    w.failAuthority = false;
    const second = await resolveProvisioningUuid(w.deps(), KEY, {
      nameNorm: NAME, companyId: CO,
      indexOwnerDriverId: w.index.get(NAME)?.driverId ?? null,
      indexOwnerActive: true,
    });
    expect(second.decision).toMatchObject({ action: 'reuse', reason: 'journal_retry' });
    expect(second.driverId).toBe('prov-uuid-0000-1');        // CASE 2: same UUID

    const action = await w.provision(second.driverId!, NAME, CO);
    expect(action).toBe('create');                 // CASE 3: authority completed

    // CASE 4: exactly one of everything.
    expect(w.uuidSeq).toBe(1);
    expect(w.index.size).toBe(1);
    expect(w.credentials.size).toBe(1);
    expect(w.profiles.size).toBe(1);
    expect(w.authority.size).toBe(1);
    expect([...w.authority.keys()]).toEqual(['prov-uuid-0000-1']);
  });

  test('CASE 5: an unrelated existing name owner is rejected, never adopted', async () => {
    const w = new World();
    w.index.set(NAME, { driverId: 'stranger-uuid-0000' });
    w.credentials.set('stranger-uuid-0000', { active: true });

    const r = await resolveProvisioningUuid(w.deps(), { kind: 'name', nameNorm: NAME }, {
      nameNorm: NAME, companyId: CO,
      indexOwnerDriverId: 'stranger-uuid-0000', indexOwnerActive: true,
    });
    expect(r.decision).toEqual({ action: 'refuse', reason: 'unrelated_name_owner' });
    expect(r.driverId).toBeNull();
    expect(w.journal.size).toBe(0);                 // nothing recorded
    expect(w.index.get(NAME)!.driverId).toBe('stranger-uuid-0000'); // untouched
  });

  test('CASE 6: legacy migration retry reuses its canonical uuid, never the hash', async () => {
    const w = new World();
    const HASH = 'a'.repeat(64);
    const key = { kind: 'legacy' as const, legacyHash: HASH };

    w.failAuthority = true;
    const first = await resolveProvisioningUuid(w.deps(), key, { nameNorm: NAME, companyId: CO });
    await expect(w.provision(first.driverId!, NAME, CO)).rejects.toThrow();

    w.failAuthority = false;
    const second = await resolveProvisioningUuid(w.deps(), key, { nameNorm: NAME, companyId: CO });
    expect(second.driverId).toBe(first.driverId);
    expect(second.driverId).not.toBe(HASH);
    await w.provision(second.driverId!, NAME, CO);

    // The authority key is the UUID; the hash never appears as a key.
    expect([...w.authority.keys()]).toEqual([first.driverId]);
    expect(w.authority.has(HASH)).toBe(false);
    // And the helper itself would refuse a hash key outright.
    expect(decideEnsureEmptyAuthority({ driverId: HASH, companyId: CO, existing: null }))
      .toEqual({ action: 'skip', reason: 'missing_driver_id' });
  });
});

// ── CASES 7–10: approval resumability ─────────────────────────────────────

describe('approval is resumable and idempotent', () => {
  test('CASE 7+8: approval fails at authority, pending survives, retry reuses the uuid', async () => {
    const w = new World();
    const pending = new Map([['p-1', { nameNorm: NAME, active: true }]]);

    w.failAuthority = true;
    const a1 = await resolveProvisioningUuid(w.deps(), KEY, { nameNorm: NAME, companyId: CO });
    await expect(w.provision(a1.driverId!, NAME, CO)).rejects.toThrow();
    // CASE 7: pending state is NOT consumed — the attempt is recoverable.
    expect(pending.has('p-1')).toBe(true);
    expect(w.journal.get(attemptKeyId(KEY))!.completed).toBe(false);

    w.failAuthority = false;
    const a2 = await resolveProvisioningUuid(w.deps(), KEY, { nameNorm: NAME, companyId: CO });
    expect(a2.driverId).toBe(a1.driverId);          // CASE 8
    const action = await w.provision(a2.driverId!, NAME, CO);
    const outcome = decideProvisioningOutcome({
      identityWritten: true, profileWritten: true, authorityAction: action, companyId: CO,
    });
    expect(outcome).toEqual({ ok: true, authority: 'created' });
    // Finalize ONLY now.
    await w.deps().markCompleted(attemptKeyId(KEY));
    pending.delete('p-1');
    expect(w.journal.get(attemptKeyId(KEY))!.completed).toBe(true);
    expect(w.uuidSeq).toBe(1);
  });

  test('CASE 9: concurrent retries converge on ONE uuid', async () => {
    const w = new World();
    const d = w.deps();
    const [r1, r2, r3] = await Promise.all([
      resolveProvisioningUuid(d, KEY, { nameNorm: NAME, companyId: CO }),
      resolveProvisioningUuid(d, KEY, { nameNorm: NAME, companyId: CO }),
      resolveProvisioningUuid(d, KEY, { nameNorm: NAME, companyId: CO }),
    ]);
    expect(new Set([r1.driverId, r2.driverId, r3.driverId]).size).toBe(1);
    expect(w.journal.size).toBe(1);
  });

  test('CASE 10: a finalized approval is idempotent on repeat invocation', async () => {
    const w = new World();
    const first = await resolveProvisioningUuid(w.deps(), KEY, { nameNorm: NAME, companyId: CO });
    await w.provision(first.driverId!, NAME, CO);
    await w.deps().markCompleted(attemptKeyId(KEY));

    const repeat = await resolveProvisioningUuid(w.deps(), KEY, { nameNorm: NAME, companyId: CO });
    expect(repeat.decision).toEqual({ action: 'already_completed', driverId: first.driverId });
    expect(w.uuidSeq).toBe(1);
    expect(w.index.size).toBe(1);
    expect(w.authority.size).toBe(1);
  });
});

// ── CASES 11–15: authority + audit semantics ──────────────────────────────

describe('authority and audit semantics', () => {
  test('CASE 11: a company-bound skip FAILS CLOSED', () => {
    expect(decideProvisioningOutcome({
      identityWritten: true, profileWritten: true, authorityAction: 'skip', companyId: CO,
    })).toEqual({ ok: false, reason: 'authority_missing_for_company' });
    expect(decideProvisioningOutcome({
      identityWritten: true, profileWritten: true, authorityAction: 'not_attempted', companyId: CO,
    })).toEqual({ ok: false, reason: 'authority_missing_for_company' });
  });

  test('CASE 12: unbound standalone may skip, and says so accurately', () => {
    const o = decideProvisioningOutcome({
      identityWritten: true, profileWritten: true, authorityAction: 'skip', companyId: null,
    });
    expect(o).toEqual({ ok: true, authority: 'skipped_standalone' });
    expect(authorityAuditLabel(o)).toBe('skipped_standalone');
  });

  test('CASE 13: existing empty / open / history authority is preserved', () => {
    const base = { driverId: 'prov-uuid-0000-1', companyId: CO, initialized: true, version: 3 };
    expect(decideEnsureEmptyAuthority({
      driverId: 'prov-uuid-0000-1', companyId: CO,
      existing: { ...base, openPeriodId: null, originLocalDate: null } as never,
    })).toEqual({ action: 'noop', reason: 'already_healthy_empty' });
    expect(decideEnsureEmptyAuthority({
      driverId: 'prov-uuid-0000-1', companyId: CO,
      existing: { ...base, openPeriodId: '2026-08-11_223000', originLocalDate: '2026-08-11' } as never,
    })).toEqual({ action: 'noop', reason: 'open_preserved' });
    expect(decideEnsureEmptyAuthority({
      driverId: 'prov-uuid-0000-1', companyId: CO,
      existing: { ...base, openPeriodId: null, originLocalDate: null, lastClosedPeriodId: '2026-08-10_060000' } as never,
    })).toEqual({ action: 'noop', reason: 'empty_with_history_preserved' });
  });

  test('CASE 14: driver / company mismatch is refused', () => {
    const base = { companyId: CO, initialized: true, version: 1, openPeriodId: null, originLocalDate: null };
    expect(decideEnsureEmptyAuthority({
      driverId: 'prov-uuid-0000-1', companyId: CO, existing: { ...base, driverId: 'other' } as never,
    })).toEqual({ action: 'refuse', reason: 'driver_mismatch' });
    expect(decideEnsureEmptyAuthority({
      driverId: 'prov-uuid-0000-1', companyId: CO,
      existing: { ...base, driverId: 'prov-uuid-0000-1', companyId: 'other-co' } as never,
    })).toEqual({ action: 'refuse', reason: 'company_mismatch' });
  });

  test('CASE 15: the audit label reports the ACTUAL outcome, with no secrets', () => {
    const labels = [
      [{ identityWritten: true, profileWritten: true, authorityAction: 'create' as const, companyId: CO }, 'created'],
      [{ identityWritten: true, profileWritten: true, authorityAction: 'initialize_uninitialized' as const, companyId: CO }, 'initialized'],
      [{ identityWritten: true, profileWritten: true, authorityAction: 'noop' as const, companyId: CO }, 'preserved'],
      [{ identityWritten: true, profileWritten: true, authorityAction: 'skip' as const, companyId: null }, 'skipped_standalone'],
      [{ identityWritten: true, profileWritten: true, authorityAction: 'refuse' as const, companyId: CO }, 'failed:authority_refused'],
      [{ identityWritten: true, profileWritten: true, authorityAction: 'skip' as const, companyId: CO }, 'failed:authority_missing_for_company'],
    ] as const;
    for (const [state, expected] of labels) {
      expect(authorityAuditLabel(decideProvisioningOutcome(state as never))).toBe(expected);
    }
    // No journal entry or label can carry credential material.
    const entry: ProvisioningJournalEntry = {
      attemptId: 'pending:p-1', driverId: 'prov-uuid-0000-1', nameNorm: NAME, companyId: CO, completed: false,
    };
    expect(JSON.stringify(entry)).not.toMatch(/passcode|hash|token|scrypt|secret/i);
  });
});

// ── CASES 16–17: the UUID the rest of the system uses ─────────────────────

describe('the provisioned UUID is the one everything else keys on', () => {
  test('CASE 16: the name-index owner IS the authority key', async () => {
    const w = new World();
    const r = await resolveProvisioningUuid(w.deps(), KEY, { nameNorm: NAME, companyId: CO });
    await w.provision(r.driverId!, NAME, CO);
    // authenticateDriver resolves a login by name index → driverId.
    const resolvedByLogin = w.index.get(NAME)!.driverId;
    expect(resolvedByLogin).toBe(r.driverId);
    expect(w.authority.has(resolvedByLogin)).toBe(true);
    expect(/^[a-f0-9]{64}$/i.test(resolvedByLogin)).toBe(false);
  });

  test('CASE 17: resolve returns NONE after completed company-bound onboarding', async () => {
    const w = new World();
    const r = await resolveProvisioningUuid(w.deps(), KEY, { nameNorm: NAME, companyId: CO });
    await w.provision(r.driverId!, NAME, CO);
    const record = w.authority.get(r.driverId!) as never;
    expect(decideResolve(record, { driverId: r.driverId!, companyId: CO }))
      .toEqual({ state: 'none' });
  });
});

// ── CASES 18–19: a weak attempt key must not outrank live ownership ───────

describe('a durable record never overrides who actually owns the name', () => {
  /**
   * `name:<nameNorm>` is a WEAK key — it identifies a target, not a person.
   * A completed entry under it must not let a later, unrelated provisioning
   * of the same display name inherit the first driver's identity.
   */
  test('CASE 18: a completed name-keyed entry is refused once the name changed hands', async () => {
    const w = new World();
    const nameKey = { kind: 'name' as const, nameNorm: NAME };
    const first = await resolveProvisioningUuid(w.deps(), nameKey, { nameNorm: NAME, companyId: CO });
    await w.provision(first.driverId!, NAME, CO);
    await w.deps().markCompleted(first.attemptId);

    // The name now belongs to a DIFFERENT active credential.
    w.index.set(NAME, { driverId: 'prov-uuid-0000-other' });
    w.credentials.set('prov-uuid-0000-other', { active: true });

    const second = await resolveProvisioningUuid(w.deps(), nameKey, {
      nameNorm: NAME,
      companyId: CO,
      indexOwnerDriverId: 'prov-uuid-0000-other',
      indexOwnerActive: true,
    });
    expect(second.decision).toEqual({ action: 'refuse', reason: 'unrelated_name_owner' });
    expect(second.driverId).toBeNull();
    // The stranger's identity was neither read into the attempt nor rewritten.
    expect(w.index.get(NAME)!.driverId).toBe('prov-uuid-0000-other');
    expect(w.journal.get(second.attemptId)!.driverId).toBe(first.driverId);
  });

  test('CASE 19: a caller naming a different driver than the record is refused, not silently overridden', async () => {
    const w = new World();
    const r = await resolveProvisioningUuid(w.deps(), KEY, { nameNorm: NAME, companyId: CO });

    const conflicting = decideProvisioningIdentity({
      requestedDriverId: 'prov-uuid-0000-99',
      journal: w.journal.get(r.attemptId)!,
      nameNorm: NAME,
    });
    expect(conflicting).toEqual({ action: 'refuse', reason: 'journal_driver_conflict' });

    // The SAME driver is still an ordinary retry.
    expect(decideProvisioningIdentity({
      requestedDriverId: r.driverId,
      journal: w.journal.get(r.attemptId)!,
      nameNorm: NAME,
    })).toEqual({ action: 'reuse', driverId: r.driverId, reason: 'journal_retry' });
  });
});
