/**
 * Phase B — governed initial company binding, driven dynamically against
 * in-memory stores with injected failures.
 *
 * The property under test is the one that motivated the operation: a
 * canonical driver's profile binding and shift authority may NEVER disagree
 * after a reported success, across crashes, retries, and concurrency.
 * Source-text greps cannot prove that; these tests run the real decision +
 * orchestration modules (executeCompanyBinding) end to end.
 */
import {
  decideCompanyBinding,
  decideBindingOutcome,
  executeCompanyBinding,
  type BindingIo,
  type CompanyBindingJournalEntry,
  type DriverProfileView,
  type CompanyView,
} from '../operational/companyBinding';
import {
  decideEnsureEmptyAuthority,
  type ShiftAuthorityRecord,
} from '../operational/shiftAuthority';

const DRIVER = 'uuid-7f3a-4b21-9c00-driver';
const CO = 'liquid-gold';
const OTHER_CO = 'dakota-hauling';
const LEGACY_HASH = 'a'.repeat(64);

// ── in-memory world ───────────────────────────────────────────────────────

class World {
  profiles = new Map<string, Record<string, unknown>>();
  companies = new Map<string, Record<string, unknown>>();
  authority = new Map<string, ShiftAuthorityRecord>();
  journal = new Map<string, CompanyBindingJournalEntry>();
  audit: string[] = [];
  /** Injected failure seams. */
  failProfileWrite = false;
  failAfterAuthority = false;

  io(): BindingIo {
    return {
      readProfile: async (driverId): Promise<DriverProfileView> => {
        const v = this.profiles.get(driverId);
        if (!v) return { exists: false };
        return {
          exists: true,
          active: v.active !== false,
          companyId: typeof v.companyId === 'string' ? v.companyId : null,
          companyName: typeof v.companyName === 'string' ? v.companyName : null,
        };
      },
      readCompany: async (companyId): Promise<CompanyView> => {
        const v = this.companies.get(companyId);
        if (!v) return { exists: false };
        return {
          exists: true,
          status: typeof v.status === 'string' ? v.status : null,
          name: typeof v.name === 'string' ? v.name : null,
        };
      },
      readAuthority: async (driverId) => {
        const record = this.authority.get(driverId) ?? null;
        return { record, malformed: false };
      },
      ensureAuthority: async (driverId, companyId) => {
        const d = decideEnsureEmptyAuthority({
          driverId,
          companyId,
          existing: this.authority.get(driverId) ?? null,
        });
        if (d.action === 'create' || d.action === 'initialize_uninitialized') {
          this.authority.set(driverId, { ...d.record });
        }
        if (this.failAfterAuthority) {
          throw new Error('injected: crashed after authority write');
        }
        return d.action as 'create' | 'noop' | 'initialize_uninitialized' | 'refuse' | 'skip';
      },
      writeProfileBinding: async (driverId, companyId, companyName) => {
        if (this.failProfileWrite) {
          throw new Error('injected: profile write failed');
        }
        const prev = this.profiles.get(driverId) ?? {};
        this.profiles.set(driverId, { ...prev, companyId, companyName });
      },
      journal: {
        read: async (driverId) => this.journal.get(driverId) ?? null,
        claim: async (driverId, candidate) => {
          const existing = this.journal.get(driverId);
          if (existing) return existing;
          this.journal.set(driverId, { ...candidate });
          return this.journal.get(driverId)!;
        },
        markCompleted: async (driverId) => {
          const e = this.journal.get(driverId);
          if (e) this.journal.set(driverId, { ...e, completed: true });
        },
      },
    };
  }
}

function world(): World {
  const w = new World();
  w.profiles.set(DRIVER, { displayName: 'MikeZfold', active: true });
  w.companies.set(CO, { name: 'Liquid Gold Trucking LLC', status: 'active' });
  w.companies.set(OTHER_CO, { name: 'Dakota Hauling', status: 'active' });
  return w;
}

const emptyAuthority = (companyId = CO): ShiftAuthorityRecord => ({
  driverId: DRIVER,
  companyId,
  initialized: true,
  openPeriodId: null,
  originLocalDate: null,
  version: 1,
});

// ── happy path ────────────────────────────────────────────────────────────

describe('initial binding', () => {
  test('unbound canonical driver + active company succeeds, both stores agree', async () => {
    const w = world();
    const r = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect(r).toMatchObject({ ok: true, companyId: CO, alreadyBound: false, authority: 'created' });
    expect(w.profiles.get(DRIVER)?.companyId).toBe(CO);
    expect(w.authority.get(DRIVER)?.companyId).toBe(CO);
    expect(w.journal.get(DRIVER)?.completed).toBe(true);
  });

  test('the authority is keyed by the canonical UUID, never anything else', async () => {
    const w = world();
    await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect([...w.authority.keys()]).toEqual([DRIVER]);
    expect(w.authority.get(DRIVER)?.driverId).toBe(DRIVER);
  });

  test('a created authority is initialized-empty: resolve must answer none, not open', async () => {
    const w = world();
    await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    const rec = w.authority.get(DRIVER)!;
    expect(rec.initialized).toBe(true);
    expect(rec.openPeriodId).toBeNull();
    expect(rec.originLocalDate).toBeNull();
  });
});

// ── refusals ──────────────────────────────────────────────────────────────

describe('refusals', () => {
  test('a 64-hex legacy hash is refused as identity before any store is touched', async () => {
    const w = world();
    w.profiles.set(LEGACY_HASH, { displayName: 'MikeZfold', active: true });
    const r = await executeCompanyBinding(w.io(), { driverId: LEGACY_HASH, companyId: CO });
    expect(r).toEqual({ ok: false, reason: 'not_canonical_driver_id' });
    expect(w.authority.size).toBe(0);
    expect(w.journal.size).toBe(0);
  });

  test('an unknown driver is refused', async () => {
    const w = world();
    const r = await executeCompanyBinding(w.io(), { driverId: 'uuid-none-none-none', companyId: CO });
    expect(r).toEqual({ ok: false, reason: 'unknown_driver' });
  });

  test('an inactive driver is refused', async () => {
    const w = world();
    w.profiles.set(DRIVER, { displayName: 'MikeZfold', active: false });
    const r = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect(r).toEqual({ ok: false, reason: 'inactive_driver' });
  });

  test('a missing company is refused', async () => {
    const w = world();
    const r = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: 'no-such-co' });
    expect(r).toEqual({ ok: false, reason: 'unknown_company' });
  });

  test('an explicitly inactive company is refused', async () => {
    const w = world();
    w.companies.set(CO, { name: 'Liquid Gold Trucking LLC', status: 'archived' });
    const r = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect(r).toEqual({ ok: false, reason: 'inactive_company' });
  });

  test('a company doc with NO status field still binds (legacy docs)', async () => {
    const w = world();
    w.companies.set(CO, { name: 'Liquid Gold Trucking LLC' });
    const r = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect(r.ok).toBe(true);
  });

  test('already bound elsewhere is refused — this is NOT a transfer path', async () => {
    const w = world();
    w.profiles.set(DRIVER, { displayName: 'MikeZfold', active: true, companyId: OTHER_CO });
    const r = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect(r).toEqual({ ok: false, reason: 'already_bound_elsewhere' });
    // Nothing moved.
    expect(w.profiles.get(DRIVER)?.companyId).toBe(OTHER_CO);
    expect(w.authority.size).toBe(0);
  });

  test('an open work period refuses and is preserved untouched', async () => {
    const w = world();
    w.profiles.set(DRIVER, { displayName: 'MikeZfold', active: true, companyId: CO });
    w.authority.set(DRIVER, {
      ...emptyAuthority(),
      openPeriodId: '2026-08-12_073000',
      originLocalDate: '2026-08-12',
      version: 4,
    });
    const r = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect(r).toEqual({ ok: false, reason: 'open_shift' });
    expect(w.authority.get(DRIVER)?.openPeriodId).toBe('2026-08-12_073000');
    expect(w.authority.get(DRIVER)?.version).toBe(4);
  });

  test('an authority for a different company is a mismatch, never overwritten', async () => {
    const w = world();
    w.authority.set(DRIVER, emptyAuthority(OTHER_CO));
    const r = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect(r).toEqual({ ok: false, reason: 'authority_mismatch' });
    expect(w.authority.get(DRIVER)?.companyId).toBe(OTHER_CO);
  });

  test('a half-open authority shape is refused as malformed', async () => {
    const w = world();
    w.profiles.set(DRIVER, { displayName: 'MikeZfold', active: true, companyId: CO });
    w.authority.set(DRIVER, {
      ...emptyAuthority(),
      openPeriodId: '2026-08-12_073000', // period without origin date
    });
    const r = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect(r).toEqual({ ok: false, reason: 'authority_malformed' });
  });

  test('a structurally malformed authority doc is refused', async () => {
    const w = world();
    const io = w.io();
    io.readAuthority = async () => ({ record: null, malformed: true });
    const r = await executeCompanyBinding(io, { driverId: DRIVER, companyId: CO });
    expect(r).toEqual({ ok: false, reason: 'authority_malformed' });
  });
});

// ── idempotency and history preservation ──────────────────────────────────

describe('idempotency', () => {
  test('already bound to the SAME company is idempotent, not an error', async () => {
    const w = world();
    const first = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect(first.ok).toBe(true);
    const again = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect(again).toMatchObject({ ok: true, alreadyBound: true, authority: 'preserved' });
    // Authority untouched by the repeat.
    expect(w.authority.get(DRIVER)?.version).toBe(1);
  });

  test('valid history (lastClosedPeriodId) survives a repeat binding', async () => {
    const w = world();
    w.profiles.set(DRIVER, { displayName: 'MikeZfold', active: true, companyId: CO });
    w.authority.set(DRIVER, {
      ...emptyAuthority(),
      lastClosedPeriodId: '2026-08-10_063000',
      version: 7,
    });
    const r = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect(r).toMatchObject({ ok: true, alreadyBound: true, authority: 'preserved' });
    expect(w.authority.get(DRIVER)?.lastClosedPeriodId).toBe('2026-08-10_063000');
    expect(w.authority.get(DRIVER)?.version).toBe(7);
  });

  test('an uninitialized empty pointer is completed, preserving version semantics', async () => {
    const w = world();
    w.authority.set(DRIVER, { ...emptyAuthority(), initialized: false, version: 2 });
    const r = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect(r).toMatchObject({ ok: true, authority: 'initialized' });
    expect(w.authority.get(DRIVER)?.initialized).toBe(true);
  });
});

// ── crash and retry ───────────────────────────────────────────────────────

describe('cross-store recovery', () => {
  test('crash after the authority write leaves an inert incomplete journal entry', async () => {
    const w = world();
    w.failAfterAuthority = true;
    await expect(
      executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO }),
    ).rejects.toThrow('injected');
    expect(w.journal.get(DRIVER)).toMatchObject({ companyId: CO, completed: false });
    expect(w.profiles.get(DRIVER)?.companyId).toBeUndefined();
  });

  test('the retry completes the SAME attempt: same target, stores converge', async () => {
    const w = world();
    w.failAfterAuthority = true;
    await expect(
      executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO }),
    ).rejects.toThrow('injected');
    w.failAfterAuthority = false;
    const r = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect(r.ok).toBe(true);
    expect(w.profiles.get(DRIVER)?.companyId).toBe(CO);
    expect(w.authority.get(DRIVER)?.companyId).toBe(CO);
    expect(w.journal.get(DRIVER)?.completed).toBe(true);
    // ONE authority, ONE identity — the retry minted nothing new.
    expect(w.authority.size).toBe(1);
  });

  test('a failed profile write is NOT reported as success and is retryable', async () => {
    const w = world();
    w.failProfileWrite = true;
    await expect(
      executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO }),
    ).rejects.toThrow('injected');
    expect(w.journal.get(DRIVER)?.completed).toBe(false);
    w.failProfileWrite = false;
    const r = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO });
    expect(r.ok).toBe(true);
  });

  test('no success until both stores agree: a verify mismatch fails the attempt', async () => {
    const w = world();
    const io = w.io();
    // Simulate a profile write that silently landed elsewhere/not at all.
    io.writeProfileBinding = async () => { /* lost write */ };
    const r = await executeCompanyBinding(io, { driverId: DRIVER, companyId: CO });
    expect(r).toEqual({ ok: false, reason: 'profile_mismatch' });
    expect(w.journal.get(DRIVER)?.completed).toBe(false);
  });
});

// ── concurrency ───────────────────────────────────────────────────────────

describe('concurrency', () => {
  test('concurrent same-target attempts converge on one binding', async () => {
    const w = world();
    const [a, b] = await Promise.all([
      executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO }),
      executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: CO }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(w.journal.size).toBe(1);
    expect(w.authority.size).toBe(1);
    expect(w.profiles.get(DRIVER)?.companyId).toBe(CO);
  });

  test('a concurrent DIFFERENT-target attempt refuses instead of interleaving', async () => {
    const w = world();
    // First attempt claimed liquid-gold durably but has not completed.
    w.journal.set(DRIVER, { driverId: DRIVER, companyId: CO, completed: false });
    const r = await executeCompanyBinding(w.io(), { driverId: DRIVER, companyId: OTHER_CO });
    expect(r).toEqual({ ok: false, reason: 'binding_attempt_conflict' });
    expect(w.profiles.get(DRIVER)?.companyId).toBeUndefined();
  });

  test('a different target racing past the precondition read still refuses at claim', async () => {
    const w = world();
    const io = w.io();
    // Interleave: the journal is empty at read time, but another attempt
    // commits liquid-gold before this dakota-hauling attempt claims.
    const originalClaim = io.journal.claim.bind(io.journal);
    io.journal.read = async () => null;
    w.journal.set(DRIVER, { driverId: DRIVER, companyId: CO, completed: false });
    io.journal.claim = originalClaim;
    const r = await executeCompanyBinding(io, { driverId: DRIVER, companyId: OTHER_CO });
    expect(r).toEqual({ ok: false, reason: 'binding_attempt_conflict' });
  });
});

// ── audit surface (pure) ──────────────────────────────────────────────────

describe('bounded outcomes', () => {
  test('the outcome gate refuses skip/not_attempted for a company-bound target', () => {
    expect(decideBindingOutcome({
      targetCompanyId: CO, profileCompanyId: CO,
      authorityAction: 'skip', authorityCompanyId: null,
    })).toEqual({ ok: false, reason: 'authority_missing' });
    expect(decideBindingOutcome({
      targetCompanyId: CO, profileCompanyId: CO,
      authorityAction: 'not_attempted', authorityCompanyId: null,
    })).toEqual({ ok: false, reason: 'authority_missing' });
  });

  test('refusal reasons carry no credential material', () => {
    const d = decideCompanyBinding({
      driverId: LEGACY_HASH,
      companyId: CO,
      profile: { exists: true, active: true },
      company: { exists: true, status: 'active', name: 'LG' },
      authority: null,
      journal: null,
    });
    expect(d).toEqual({ action: 'refuse', reason: 'not_canonical_driver_id' });
    expect(JSON.stringify(d)).not.toContain(LEGACY_HASH);
  });
});
