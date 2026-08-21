import { runInviteEmployeeSaga, decideInviteLease, mayAdoptJournalOwnedAuth, type InviteSagaStores } from '../inviteEmployeeSaga';
import { inviteIntentDigest, type InviteJournalEntry } from '../inviteEmployeeJournal';
import { decideCompanyStaff } from '../canonicalAdminAuthority';

function memStores(over: Partial<{
  users: Record<string, { email: string; claims: Record<string, unknown> }>;
  failAt?: string;
}> = {}) {
  const journals: Record<string, InviteJournalEntry> = {};
  const auth: Record<string, { email: string; claims: Record<string, unknown> }> = { ...(over.users || {}) };
  const rtdb: Record<string, Record<string, unknown>> = {};
  const staff: Record<string, Record<string, unknown>> = {};
  const drivers: Record<string, Record<string, unknown>> = {};
  const platform: Record<string, { enabled?: boolean }> = {};
  let crash = over.failAt || '';
  const stores: InviteSagaStores = {
    nowMs: () => 1_000,
    newUid: () => 'reserved-uid-1',
    newOwnerToken: () => 'owner-a',
    readJournal: async (id) => journals[id] || null,
    writeJournal: async (entry) => {
      if (crash === 'after_journal_uid') {
        crash = '';
        throw new Error('crash_after_journal_uid');
      }
      journals[entry.attemptId] = entry;
      return entry;
    },
    claimJournal: async (entry, ownerToken, nowMs) => {
      const cur = journals[entry.attemptId];
      if (cur?.leaseUntil && cur.leaseUntil > nowMs && cur.ownerToken && cur.ownerToken !== ownerToken) {
        return { ok: false, reason: 'invite_lease_collision' };
      }
      const next = { ...entry, ownerToken, leaseUntil: nowMs + 90_000 };
      journals[entry.attemptId] = next;
      if (crash === 'after_journal_reservation') {
        crash = '';
        throw new Error('crash_after_journal_reservation');
      }
      return { ok: true, entry: next };
    },
    getUserByEmail: async (email) => {
      const hit = Object.entries(auth).find(([, u]) => u.email === email);
      return hit ? { uid: hit[0], email: hit[1].email, claims: hit[1].claims } : null;
    },
    createUser: async ({ uid, email }) => {
      if (crash === 'after_auth_create') {
        auth[uid] = { email, claims: {} };
        crash = '';
        throw new Error('crash_after_auth_create');
      }
      auth[uid] = { email, claims: {} };
      return { uid };
    },
    getUser: async (uid) => ({ uid, email: auth[uid]?.email, claims: auth[uid]?.claims || {} }),
    setClaims: async (uid, claims) => {
      if (crash === 'after_claims') {
        crash = '';
        throw new Error('crash_after_claims');
      }
      auth[uid] = { email: auth[uid]?.email || '', claims };
    },
    getRtdb: async (uid) => rtdb[uid] || null,
    setRtdb: async (uid, data) => {
      if (crash === 'after_rtdb') {
        crash = '';
        throw new Error('crash_after_rtdb');
      }
      rtdb[uid] = { ...(rtdb[uid] || {}), ...data };
    },
    getStaff: async (uid) => staff[uid] || null,
    setStaff: async (uid, data) => {
      if (crash === 'after_staff') {
        crash = '';
        throw new Error('crash_after_staff');
      }
      staff[uid] = { ...(staff[uid] || {}), ...data };
    },
    getPlatformAdmin: async (uid) => platform[uid] || null,
    getDriver: async (hash) => drivers[hash] || null,
    setDriver: async (hash, data) => {
      if (crash === 'after_driver') {
        crash = '';
        throw new Error('crash_after_driver');
      }
      drivers[hash] = { ...(drivers[hash] || {}), ...data };
    },
    findDriverByDashboardUid: async (uid) => {
      const hit = Object.entries(drivers).find(([, d]) => d.dashboardUid === uid);
      return hit ? { hash: hit[0], data: hit[1] } : null;
    },
  };
  return { stores, journals, auth, rtdb, staff, drivers, platform };
}

const manager = decideCompanyStaff({
  uid: 'mgr',
  staff: { enabled: true, companyId: 'company-a', role: 'manager' },
});

describe('inviteEmployee saga', () => {
  it('refuses platform identity before store mutation', async () => {
    const mem = memStores({
      users: { plat: { email: 'p@x.com', claims: { wellbuiltAdmin: true, platformAdminEnabled: true } } },
    });
    mem.platform.plat = { enabled: true };
    const r = await runInviteEmployeeSaga(mem.stores, {
      authority: manager,
      email: 'p@x.com',
      role: 'viewer',
      companyId: 'company-a',
      invitedBy: 'mgr',
    });
    expect(r).toMatchObject({ ok: false, reason: 'existing_platform_admin' });
    expect(mem.rtdb.plat).toBeUndefined();
    expect(mem.staff.plat).toBeUndefined();
  });

  it('retries after Auth create by adopting journal-owned unscoped user', async () => {
    const mem = memStores({ failAt: 'after_auth_create' });
    const first = runInviteEmployeeSaga(mem.stores, {
      authority: manager,
      email: 'a@x.com',
      role: 'viewer',
      companyId: 'company-a',
      invitedBy: 'mgr',
      ownerToken: 'owner-a',
    });
    await expect(first).rejects.toThrow('crash_after_auth_create');
    const retry = await runInviteEmployeeSaga(mem.stores, {
      authority: manager,
      email: 'a@x.com',
      role: 'viewer',
      companyId: 'company-a',
      invitedBy: 'mgr',
      ownerToken: 'owner-a',
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.uid).toBe('reserved-uid-1');
  });

  it('concurrent same-intent calls have one owner', async () => {
    const mem = memStores();
    const a = runInviteEmployeeSaga(mem.stores, {
      authority: manager,
      email: 'a@x.com',
      role: 'viewer',
      companyId: 'company-a',
      invitedBy: 'mgr',
      ownerToken: 't1',
    });
    const b = runInviteEmployeeSaga(mem.stores, {
      authority: manager,
      email: 'a@x.com',
      role: 'viewer',
      companyId: 'company-a',
      invitedBy: 'mgr',
      ownerToken: 't2',
    });
    const settled = await Promise.all([a, b]);
    const oks = settled.filter((s) => s.ok);
    const collisions = settled.filter((s) => !s.ok && s.reason === 'invite_lease_collision');
    expect(oks.length).toBe(1);
    expect(collisions.length).toBe(1);
  });

  it('lease helper distinguishes acquire/resume/collision', () => {
    expect(decideInviteLease({ journal: null, ownerToken: 'a', nowMs: 1 })).toBe('acquire');
    expect(decideInviteLease({
      journal: { ownerToken: 'b', leaseUntil: 50 } as InviteJournalEntry,
      ownerToken: 'a',
      nowMs: 10,
    })).toBe('collision');
  });

  it('journal ownership requires uid/email/digest/creator', () => {
    const digest = inviteIntentDigest({
      email: 'a@x.com', companyId: 'company-a', role: 'viewer', rebind: false,
    });
    expect(mayAdoptJournalOwnedAuth({
      journal: {
        attemptId: 'x', email: 'a@x.com', uid: 'u1', reservedUid: 'u1',
        companyId: 'company-a', role: 'viewer', phase: 'auth_created',
        rebind: false, intentDigest: digest, createdByThisOperation: true,
        ownerToken: 't', invitedBy: 'mgr',
      },
      existingUid: 'u1',
      email: 'a@x.com',
      intentDigest: digest,
      ownerToken: 't',
      invitedBy: 'mgr',
    })).toBe(true);
    expect(mayAdoptJournalOwnedAuth({
      journal: {
        attemptId: 'x', email: 'a@x.com', uid: 'u1', reservedUid: 'u1',
        companyId: 'company-a', role: 'viewer', phase: 'auth_created',
        rebind: false, intentDigest: digest, createdByThisOperation: true,
        ownerToken: 't', invitedBy: 'mgr', leaseUntil: 50,
      },
      existingUid: 'u1',
      email: 'a@x.com',
      intentDigest: digest,
      ownerToken: 'other',
      invitedBy: 'mgr',
      nowMs: 10,
    })).toBe(false);
  });

  async function retryAfter(failAt: string) {
    const extra = failAt === 'after_driver' ? { driverHash: 'drv-a' } : {};
    const mem = memStores({ failAt });
    if (failAt === 'after_driver') mem.drivers['drv-a'] = { companyId: 'company-a' };
    const first = runInviteEmployeeSaga(mem.stores, {
      authority: manager,
      email: 'a@x.com',
      role: 'viewer',
      companyId: 'company-a',
      invitedBy: 'mgr',
      ownerToken: 'owner-a',
      ...extra,
    });
    await expect(first).rejects.toThrow(`crash_${failAt}`);
    const retry = await runInviteEmployeeSaga(mem.stores, {
      authority: manager,
      email: 'a@x.com',
      role: 'viewer',
      companyId: 'company-a',
      invitedBy: 'mgr',
      ownerToken: 'owner-a',
      ...extra,
    });
    expect(retry.ok).toBe(true);
    return mem;
  }

  it('recovers after journal reservation crash', async () => {
    await retryAfter('after_journal_reservation');
  });

  it('recovers after journal UID persist crash', async () => {
    await retryAfter('after_journal_uid');
  });

  it('recovers after RTDB crash', async () => {
    await retryAfter('after_rtdb');
  });

  it('recovers after staff crash', async () => {
    await retryAfter('after_staff');
  });

  it('recovers after claims crash', async () => {
    await retryAfter('after_claims');
  });

  it('recovers after driver link crash', async () => {
    await retryAfter('after_driver');
  });

  it('reconciles completed journal with drifted stores', async () => {
    const mem = memStores();
    const first = await runInviteEmployeeSaga(mem.stores, {
      authority: manager,
      email: 'a@x.com',
      role: 'viewer',
      companyId: 'company-a',
      invitedBy: 'mgr',
      ownerToken: 'owner-a',
    });
    expect(first.ok).toBe(true);
    mem.rtdb['reserved-uid-1'].role = 'dispatch';
    const retry = await runInviteEmployeeSaga(mem.stores, {
      authority: manager,
      email: 'a@x.com',
      role: 'viewer',
      companyId: 'company-a',
      invitedBy: 'mgr',
      ownerToken: 'owner-a',
    });
    expect(retry.ok).toBe(true);
    expect(mem.rtdb['reserved-uid-1'].role).toBe('viewer');
  });

  it('removing driverHash clears both sides of the link', async () => {
    const mem = memStores();
    mem.drivers['drv-a'] = { companyId: 'company-a' };
    const first = await runInviteEmployeeSaga(mem.stores, {
      authority: manager,
      email: 'a@x.com',
      role: 'viewer',
      companyId: 'company-a',
      invitedBy: 'mgr',
      ownerToken: 'owner-a',
      driverHash: 'drv-a',
    });
    expect(first.ok).toBe(true);
    expect(mem.rtdb['reserved-uid-1'].driverHash).toBe('drv-a');
    expect(mem.drivers['drv-a'].dashboardUid).toBe('reserved-uid-1');
    const cleared = await runInviteEmployeeSaga(mem.stores, {
      authority: manager,
      email: 'a@x.com',
      role: 'viewer',
      companyId: 'company-a',
      invitedBy: 'mgr',
      ownerToken: 'owner-a',
      driverHash: null,
    });
    expect(cleared.ok).toBe(true);
    expect(mem.rtdb['reserved-uid-1'].driverHash).toBeNull();
    expect(mem.drivers['drv-a'].dashboardUid).toBeNull();
  });
});
