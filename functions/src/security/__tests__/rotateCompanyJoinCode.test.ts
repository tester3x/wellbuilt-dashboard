import * as fs from 'fs';
import * as path from 'path';
import {
  companyJoinCodeDigest,
  normalizeCompanyJoinCode,
  decideRotateCompanyJoinCodeTenantAccess,
  executeRotateJoinCode,
  type JoinCodeStoreOps,
  type JoinCodeTransactionOps,
} from '../companyOnboarding';

// ── In-Memory Transactional Store for Join Code Lifecycle ──────────────────

interface JoinCodeDoc {
  companyId: string;
  code: string;
  active: boolean;
  createdAt?: unknown;
  createdBy?: string;
  revokedAt?: unknown;
  revokedBy?: string;
}

interface PointerDoc {
  digest: string;
  updatedAt?: unknown;
  updatedBy?: string;
}

class InMemoryJoinCodeStore implements JoinCodeStoreOps {
  codes = new Map<string, JoinCodeDoc>();
  pointers = new Map<string, PointerDoc>();
  companies = new Map<string, { name: string; status: string }>();
  auditLogs: Array<{ action: string; actorUid: string; detail: Record<string, unknown> }> = [];

  failWrite = false;
  failInTransaction = false;
  generateCode?: () => string;

  async getPointer(companyId: string) {
    const p = this.pointers.get(companyId);
    return p ? { digest: p.digest } : null;
  }

  async getJoinCode(digest: string) {
    const c = this.codes.get(digest);
    if (!c) return { exists: false };
    return { exists: true, active: c.active, companyId: c.companyId, code: c.code };
  }

  async writeAudit(audit: { action: string; actorUid: string; detail: Record<string, unknown> }) {
    this.auditLogs.push(audit);
  }

  // Simulated transaction runner with snapshot isolation and rollback
  async runTransaction<T>(fn: (tx: JoinCodeTransactionOps) => Promise<T>): Promise<T> {
    // Take snapshot of current state
    const snapshotCodes = new Map(this.codes);
    const snapshotPointers = new Map(this.pointers);
    const snapshotAudits = [...this.auditLogs];

    // Staged mutations
    const stagedDeactivations = new Map<string, { actorUid: string }>();
    const stagedCreations = new Map<string, JoinCodeDoc>();
    const stagedPointers = new Map<string, PointerDoc>();
    const stagedAudits: Array<{ action: string; actorUid: string; detail: Record<string, unknown> }> = [];

    const tx: JoinCodeTransactionOps = {
      getPointer: async (companyId: string) => {
        const p = this.pointers.get(companyId);
        return p ? { digest: p.digest } : null;
      },
      getJoinCode: async (digest: string) => {
        const c = this.codes.get(digest);
        if (!c) return { exists: false };
        return { exists: true, active: c.active, companyId: c.companyId, code: c.code };
      },
      deactivateCode: (digest: string, actorUid: string) => {
        stagedDeactivations.set(digest, { actorUid });
      },
      createCode: (digest: string, code: string, companyId: string, actorUid: string) => {
        stagedCreations.set(digest, {
          companyId,
          code,
          active: true,
          createdBy: actorUid,
          createdAt: Date.now(),
        });
      },
      setPointer: (companyId: string, digest: string, actorUid: string) => {
        stagedPointers.set(companyId, {
          digest,
          updatedBy: actorUid,
          updatedAt: Date.now(),
        });
      },
      writeAudit: (audit) => {
        stagedAudits.push(audit);
      },
    };

    try {
      const result = await fn(tx);

      if (this.failInTransaction) {
        throw new Error('injected_transaction_failure');
      }
      if (this.failWrite) {
        throw new Error('injected_write_failure');
      }

      // Commit staged changes
      for (const [digest, { actorUid }] of stagedDeactivations.entries()) {
        const existing = this.codes.get(digest);
        if (existing) {
          this.codes.set(digest, {
            ...existing,
            active: false,
            revokedAt: Date.now(),
            revokedBy: actorUid,
          });
        }
      }
      for (const [digest, doc] of stagedCreations.entries()) {
        this.codes.set(digest, doc);
      }
      for (const [companyId, ptr] of stagedPointers.entries()) {
        this.pointers.set(companyId, ptr);
      }
      for (const a of stagedAudits) {
        this.auditLogs.push(a);
      }

      return result;
    } catch (err) {
      // Rollback: restore snapshots, discard staged
      this.codes = snapshotCodes;
      this.pointers = snapshotPointers;
      this.auditLogs = snapshotAudits;
      throw err;
    }
  }

  // Helper resolving join code like resolveCompanyJoinCode
  resolveJoinCode(rawCode: unknown): { ok: boolean; companyId?: string; companyName?: string; error?: string } {
    const normalized = normalizeCompanyJoinCode(rawCode);
    if (normalized.length !== 8) {
      return { ok: false, error: 'Enter the 8-character company join code' };
    }
    const digest = companyJoinCodeDigest(normalized);
    const codeDoc = this.codes.get(digest);
    if (!codeDoc || codeDoc.active !== true) {
      return { ok: false, error: 'Company join code was not found' };
    }
    const company = this.companies.get(codeDoc.companyId);
    if (!company || company.status === 'archived') {
      return { ok: false, error: 'Company is not available for employee registration' };
    }
    return { ok: true, companyId: codeDoc.companyId, companyName: company.name };
  }
}

// ── Test Suites ────────────────────────────────────────────────────────────

describe('rotateCompanyJoinCode — Tenant Boundary & Authorization', () => {
  it('denies cross-tenant rotation when tenant admin requests a different company', () => {
    const caller = { uid: 'tenant-admin-1', companyId: 'company-a', isPlatformAdmin: false, caps: ['manageDrivers'] };
    const decision = decideRotateCompanyJoinCodeTenantAccess(caller, 'company-b');
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe('permission-denied');
    expect(decision.error).toContain('platform_admin_required');
  });

  it('allows tenant admin to rotate their own company when companyId is specified', () => {
    const caller = { uid: 'tenant-admin-1', companyId: 'company-a', isPlatformAdmin: false, caps: ['manageDrivers'] };
    const decision = decideRotateCompanyJoinCodeTenantAccess(caller, 'company-a');
    expect(decision.ok).toBe(true);
    expect(decision.companyId).toBe('company-a');
  });

  it('allows tenant admin to rotate when companyId is omitted (defaults to caller tenant)', () => {
    const caller = { uid: 'tenant-admin-1', companyId: 'company-a', isPlatformAdmin: false, caps: ['manageDrivers'] };
    const decision = decideRotateCompanyJoinCodeTenantAccess(caller, undefined);
    expect(decision.ok).toBe(true);
    expect(decision.companyId).toBe('company-a');
  });

  it('allows verified platform admin to rotate any target company', () => {
    const caller = { uid: 'pa-1', companyId: null, isPlatformAdmin: true, caps: ['manageDrivers'] };
    const decision = decideRotateCompanyJoinCodeTenantAccess(caller, 'liquid-gold', { ok: true });
    expect(decision.ok).toBe(true);
    expect(decision.companyId).toBe('liquid-gold');
  });

  it('denies platform admin when no target companyId is provided', () => {
    const caller = { uid: 'pa-1', companyId: null, isPlatformAdmin: true, caps: ['manageDrivers'] };
    const decision = decideRotateCompanyJoinCodeTenantAccess(caller, '', { ok: true });
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe('invalid-argument');
    expect(decision.error).toBe('companyId required for platform admin rotation');
  });

  it('never authorizes cross-company actions from an unscoped admin or it role string alone', () => {
    // Caller has role 'admin' in RTDB, but lacks verified platform_admins record
    const caller = { uid: 'fake-admin-1', companyId: null, isPlatformAdmin: false, caps: ['manageDrivers'] };
    const decision = decideRotateCompanyJoinCodeTenantAccess(caller, 'liquid-gold', {
      ok: false,
      reason: 'missing_admin_record',
    });
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe('permission-denied');
    expect(decision.error).toBe('platform_admin_required:missing_admin_record');
  });

  it('denies unauthenticated caller', () => {
    const caller = { uid: '', companyId: 'company-a', isPlatformAdmin: false, caps: ['manageDrivers'] };
    const decision = decideRotateCompanyJoinCodeTenantAccess(caller, 'company-a');
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe('unauthenticated');
    expect(decision.error).toBe('Must be signed in');
  });

  it('denies caller lacking manageDrivers capability', () => {
    const caller = { uid: 'viewer-1', companyId: 'company-a', isPlatformAdmin: false, caps: ['viewer'] };
    const decision = decideRotateCompanyJoinCodeTenantAccess(caller, 'company-a');
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe('permission-denied');
  });

  it('denies caller without companyId who is not a verified platform admin', () => {
    const caller = { uid: 'unassigned-user', companyId: null, isPlatformAdmin: false, caps: ['manageDrivers'] };
    const decision = decideRotateCompanyJoinCodeTenantAccess(caller, 'liquid-gold', {
      ok: false,
      reason: 'missing_admin_record',
    });
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe('permission-denied');
    expect(decision.error).toContain('platform_admin_required');
  });
});

describe('rotateCompanyJoinCode — Atomic Pointer Replacement, Deactivation, & Rejection', () => {
  let store: InMemoryJoinCodeStore;
  const COMPANY_ID = 'liquid-gold';
  const OLD_CODE = 'ABCD-1234';
  const OLD_DIGEST = companyJoinCodeDigest(OLD_CODE);

  beforeEach(() => {
    store = new InMemoryJoinCodeStore();
    store.companies.set(COMPANY_ID, { name: 'Liquid Gold Trucking LLC', status: 'active' });

    // Seed existing active code and pointer
    store.codes.set(OLD_DIGEST, {
      companyId: COMPANY_ID,
      code: OLD_CODE,
      active: true,
      createdBy: 'initial-setup',
    });
    store.pointers.set(COMPANY_ID, {
      digest: OLD_DIGEST,
      updatedBy: 'initial-setup',
    });
  });

  it('atomically deactivates old code, writes new code, and points to new digest', async () => {
    const actorUid = 'admin-user-1';
    const newCode = await executeRotateJoinCode(COMPANY_ID, actorUid, store);

    expect(newCode).toBeDefined();
    expect(newCode).not.toBe(OLD_CODE);

    const newDigest = companyJoinCodeDigest(newCode);

    // 1. Pointer updated to new digest
    const pointer = await store.getPointer(COMPANY_ID);
    expect(pointer?.digest).toBe(newDigest);

    // 2. Old code deactivated
    const oldRecord = store.codes.get(OLD_DIGEST);
    expect(oldRecord?.active).toBe(false);
    expect(oldRecord?.revokedBy).toBe(actorUid);
    expect(oldRecord?.revokedAt).toBeDefined();

    // 3. New code active
    const newRecord = store.codes.get(newDigest);
    expect(newRecord?.active).toBe(true);
    expect(newRecord?.code).toBe(newCode);
    expect(newRecord?.companyId).toBe(COMPANY_ID);
    expect(newRecord?.createdBy).toBe(actorUid);
  });

  it('rejects old code on resolution after rotation (old-code rejection)', async () => {
    // Before rotation: old code resolves
    const before = store.resolveJoinCode(OLD_CODE);
    expect(before.ok).toBe(true);
    expect(before.companyId).toBe(COMPANY_ID);

    // Rotate
    const newCode = await executeRotateJoinCode(COMPANY_ID, 'admin-1', store);

    // After rotation: old code is rejected
    const oldAttempt = store.resolveJoinCode(OLD_CODE);
    expect(oldAttempt.ok).toBe(false);
    expect(oldAttempt.error).toBe('Company join code was not found');

    // Case and spacing variations of old code are also rejected
    expect(store.resolveJoinCode(OLD_CODE.toLowerCase()).ok).toBe(false);
    expect(store.resolveJoinCode(` ${OLD_CODE} `).ok).toBe(false);

    // New code is accepted
    const newAttempt = store.resolveJoinCode(newCode);
    expect(newAttempt.ok).toBe(true);
    expect(newAttempt.companyId).toBe(COMPANY_ID);
    expect(newAttempt.companyName).toBe('Liquid Gold Trucking LLC');
  });

  it('never logs plaintext code in security audit', async () => {
    const actorUid = 'admin-user-1';
    const newCode = await executeRotateJoinCode(COMPANY_ID, actorUid, store);

    expect(store.auditLogs).toHaveLength(1);
    const log = store.auditLogs[0];
    expect(log.action).toBe('rotateCompanyJoinCode');
    expect(log.actorUid).toBe(actorUid);
    expect(log.detail.companyId).toBe(COMPANY_ID);

    // Ensure NO plaintext join code or secrets leaked into audit log
    const auditString = JSON.stringify(log);
    expect(auditString).not.toContain(newCode);
    expect(auditString).not.toContain(OLD_CODE);
  });
});

describe('rotateCompanyJoinCode — Concurrency & Collision Handling', () => {
  it('retries and succeeds when code generation collides with an existing code', async () => {
    const store = new InMemoryJoinCodeStore();
    const COMPANY_ID = 'dakota-hauling';
    store.companies.set(COMPANY_ID, { name: 'Dakota Hauling', status: 'active' });

    const COLLIDING_CODE = 'AAAA-1111';
    const COLLIDING_DIGEST = companyJoinCodeDigest(COLLIDING_CODE);
    store.codes.set(COLLIDING_DIGEST, {
      companyId: 'other-company',
      code: COLLIDING_CODE,
      active: true,
    });

    let generatorCalls = 0;
    store.generateCode = () => {
      generatorCalls += 1;
      if (generatorCalls === 1) return COLLIDING_CODE; // Collision on first try
      return 'BBBB-2222'; // Unique on second try
    };

    const result = await executeRotateJoinCode(COMPANY_ID, 'admin-1', store);
    expect(result).toBe('BBBB-2222');
    expect(generatorCalls).toBe(2);

    const pointer = await store.getPointer(COMPANY_ID);
    expect(pointer?.digest).toBe(companyJoinCodeDigest('BBBB-2222'));
  });

  it('handles multiple sequential rotations cleanly, leaving only the latest code active', async () => {
    const store = new InMemoryJoinCodeStore();
    const COMPANY_ID = 'liquid-gold';
    store.companies.set(COMPANY_ID, { name: 'Liquid Gold', status: 'active' });

    const codes: string[] = [];
    codes.push(await executeRotateJoinCode(COMPANY_ID, 'admin-1', store));
    codes.push(await executeRotateJoinCode(COMPANY_ID, 'admin-1', store));
    codes.push(await executeRotateJoinCode(COMPANY_ID, 'admin-1', store));

    expect(codes).toHaveLength(3);

    // First two codes must be rejected
    expect(store.resolveJoinCode(codes[0]).ok).toBe(false);
    expect(store.resolveJoinCode(codes[1]).ok).toBe(false);

    // Third (latest) code must be accepted
    const latest = store.resolveJoinCode(codes[2]);
    expect(latest.ok).toBe(true);
    expect(latest.companyId).toBe(COMPANY_ID);

    // Pointer points to latest code
    const pointer = await store.getPointer(COMPANY_ID);
    expect(pointer?.digest).toBe(companyJoinCodeDigest(codes[2]));
  });
});

describe('rotateCompanyJoinCode — Failure Rollback', () => {
  it('rolls back all mutations if an error occurs during transaction commit', async () => {
    const store = new InMemoryJoinCodeStore();
    const COMPANY_ID = 'liquid-gold';
    store.companies.set(COMPANY_ID, { name: 'Liquid Gold Trucking LLC', status: 'active' });
    const OLD_CODE = 'ORIG-1234';
    const OLD_DIGEST = companyJoinCodeDigest(OLD_CODE);

    store.codes.set(OLD_DIGEST, {
      companyId: COMPANY_ID,
      code: OLD_CODE,
      active: true,
      createdBy: 'init',
    });
    store.pointers.set(COMPANY_ID, {
      digest: OLD_DIGEST,
      updatedBy: 'init',
    });

    // Inject write failure
    store.failWrite = true;

    await expect(
      executeRotateJoinCode(COMPANY_ID, 'admin-1', store),
    ).rejects.toThrow('injected_write_failure');

    // Verification of complete rollback:
    // 1. Pointer still points to OLD_DIGEST
    const pointer = await store.getPointer(COMPANY_ID);
    expect(pointer?.digest).toBe(OLD_DIGEST);

    // 2. Old code is STILL active
    const oldRecord = store.codes.get(OLD_DIGEST);
    expect(oldRecord?.active).toBe(true);
    expect(oldRecord?.revokedAt).toBeUndefined();

    // 3. Old code still resolves
    const resolveRes = store.resolveJoinCode(OLD_CODE);
    expect(resolveRes.ok).toBe(true);

    // 4. No audit log was recorded
    expect(store.auditLogs).toHaveLength(0);
  });
});

describe('rotateCompanyJoinCode — Export & Dispatch Boundary', () => {
  it('is exported by functions/src/index.ts and functions/src/security/index.ts', () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, '../../index.ts'), 'utf8');
    const secIndexSrc = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf8');

    expect(indexSrc).toMatch(/\brotateCompanyJoinCode\b/);
    expect(secIndexSrc).toMatch(/\brotateCompanyJoinCode\b/);
  });
});
