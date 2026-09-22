import { readFileSync } from 'fs';
import { join } from 'path';
import {
  persistJobPacketRevision,
  revisionDocId,
  validatePublishInput,
  SERVER_IMPLEMENTED_EFFECTS,
  type RevisionStoreTx,
} from '../jobPacketRevisionStore';
import { stampDispatchBinding } from '../dispatchPacketPin';
import {
  EXECUTABLE_DISPATCH_STATUSES,
  parseResolveExecutionBindingRequest,
  readDispatchExecutionContext,
  RESOLVE_FORBIDDEN_KEYS,
  runResolveExecutionBinding,
} from '../resolveExecutionBinding';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const COMPANY = 'liquid-gold';
const OTHER = 'other-hauler';
const PUBLISHER = 'uid-staff-1';
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const OTHER_DRIVER = 'ffffffff-0000-0000-0000-ffffffffffff';
const JOB = 'W0Om3TsAHAJ4bu8d8K49';

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageId: 'water-hauling',
    revision: 1,
    displayVersion: '1.0.0',
    industryId: 'oil-gas',
    segmentId: 'produced-water',
    capabilities: [
      { capabilityId: 'lifecycle', moduleVersion: 1, configuration: {} },
      { capabilityId: 'pickup', moduleVersion: 1, configuration: { unit: 'bbl' } },
    ],
    jobTypes: [
      { jobTypeId: 'pw', label: 'Production Water', capabilities: ['lifecycle', 'pickup'] },
    ],
    policyRefs: [],
    definition: {
      schemaVersion: 1,
      packetId: 'water-hauling',
      industryId: 'oil-gas',
      segmentId: 'produced-water',
      label: 'Water Hauling',
    },
    supersedes: null,
    ...overrides,
  };
}

class MemoryStore implements RevisionStoreTx {
  revisions = new Map<string, Record<string, unknown>>();
  claims = new Map<string, Record<string, unknown>>();
  async getRevision(docId: string) {
    const v = this.revisions.get(docId);
    return v ? { ...v } : null;
  }
  async getClaim(docId: string) {
    const v = this.claims.get(docId);
    return v ? { ...v } : null;
  }
  createRevision(docId: string, data: Record<string, unknown>) {
    if (this.revisions.has(docId)) throw new Error('already-exists');
    this.revisions.set(docId, { ...data });
  }
  createClaim(docId: string, data: Record<string, unknown>) {
    if (this.claims.has(docId)) throw new Error('already-exists');
    this.claims.set(docId, { ...data });
  }
}

async function publishRevision(store: MemoryStore, overrides: Record<string, unknown> = {}, companyId = COMPANY) {
  const built = validatePublishInput(validPayload(overrides), {
    companyId,
    publishedByUid: PUBLISHER,
  });
  if (!built.ok) throw new Error(built.reason);
  const persisted = await persistJobPacketRevision(
    store,
    { envelope: built.envelope, contentHash: built.contentHash },
    'ts-1',
  );
  if (!persisted.ok) throw new Error(persisted.reason);
  return persisted.revision;
}

function dispatchFrom(rev: Awaited<ReturnType<typeof publishRevision>>, over: Record<string, unknown> = {}) {
  const binding = stampDispatchBinding(rev);
  return {
    companyId: COMPANY,
    driverId: DRIVER,
    status: 'accepted',
    jobType: 'pw',
    wellName: 'Python',
    ndicWellName: 'PYTHON 1',
    ...binding,
    ...over,
  };
}

describe('resolveExecutionBinding', () => {
  it('1-3. assigned driver resolves the pinned revision definition and binding', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const job = dispatchFrom(rev);
    const writes: unknown[] = [];
    const r = await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => job,
      getRevision: async (id) => {
        const data = await store.getRevision(id);
        return { exists: !!data, data: data || undefined };
      },
      writes,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jobId).toBe(JOB);
    expect(r.companyId).toBe(COMPANY);
    expect(r.driverId).toBe(DRIVER);
    expect(r.binding).toEqual(stampDispatchBinding(rev));
    expect(r.execution).toEqual({ jobTypeId: 'pw', wellName: 'Python', ndicWellName: 'PYTHON 1' });
    expect(r.definition).toEqual(rev.definition);
    expect(r.implementedEffects).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('4. caller authority and binding fields are rejected', () => {
    for (const key of RESOLVE_FORBIDDEN_KEYS) {
      expect(parseResolveExecutionBindingRequest({ jobId: JOB, [key]: 'x' })).toMatchObject({
        ok: false,
        reason: 'caller_authority_field',
      });
    }
    expect(parseResolveExecutionBindingRequest({ jobId: JOB, extra: true })).toMatchObject({
      ok: false,
      reason: 'unknown_field',
    });
  });

  it('5-8. other driver, other company, missing dispatch, and pending status fail', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const job = dispatchFrom(rev);
    const getRev = async (id: string) => {
      const data = await store.getRevision(id);
      return { exists: !!data, data: data || undefined };
    };
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: OTHER_DRIVER, companyId: COMPANY },
      getDispatch: async () => job,
      getRevision: getRev,
    })).toMatchObject({ ok: false, reason: 'other_driver' });
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: OTHER },
      getDispatch: async () => job,
      getRevision: getRev,
    })).toMatchObject({ ok: false, reason: 'wrong_company' });
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => null,
      getRevision: getRev,
    })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => ({ ...job, status: 'pending' }),
      getRevision: getRev,
    })).toMatchObject({ ok: false, reason: 'invalid_status' });
    expect([...EXECUTABLE_DISPATCH_STATUSES]).toEqual(['accepted', 'in_progress', 'paused']);
  });

  it('9-13. missing/partial binding, missing revision, tamper, and hash mismatches fail', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const job = dispatchFrom(rev);
    const getRev = async (id: string) => {
      const data = await store.getRevision(id);
      return { exists: !!data, data: data || undefined };
    };
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => {
        const { packageId, ...rest } = job;
        void packageId;
        return rest;
      },
      getRevision: getRev,
    })).toMatchObject({ ok: false, reason: 'partial_authority_group' });
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => ({ ...job, contentHash: undefined }),
      getRevision: getRev,
    }).then((r) => r.ok)).toBe(false);
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => job,
      getRevision: async () => ({ exists: false }),
    })).toMatchObject({ ok: false, reason: 'revision_not_found' });
    const tamperedId = revisionDocId(COMPANY, 'water-hauling', 1);
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => job,
      getRevision: async (id) => {
        const data = await store.getRevision(id);
        if (!data || id !== tamperedId) return { exists: !!data, data: data || undefined };
        return { exists: true, data: { ...data, definition: { ...rev.definition, label: 'HACK' } } };
      },
    }).then((r) => r.ok)).toBe(false);
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => ({ ...job, contentHash: 'a'.repeat(64) }),
      getRevision: getRev,
    })).toMatchObject({ ok: false, reason: 'content_hash_mismatch' });
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => ({ ...job, policyHash: 'b'.repeat(64) }),
      getRevision: getRev,
    })).toMatchObject({ ok: false, reason: 'policy_hash_mismatch' });
  });

  it('14-16. newer package head cannot move a pin; caller ids cannot redirect; zero writes', async () => {
    const store = new MemoryStore();
    const rev1 = await publishRevision(store, { revision: 1, displayVersion: '1.0.0' });
    await publishRevision(store, {
      revision: 2,
      displayVersion: '2.0.0',
      definition: {
        schemaVersion: 1,
        packetId: 'water-hauling',
        industryId: 'oil-gas',
        segmentId: 'produced-water',
        label: 'Water Hauling v2',
      },
    });
    const job = dispatchFrom(rev1);
    const writes: unknown[] = ['sentinel'];
    const r = await runResolveExecutionBinding({
      jobId: { jobId: JOB, packageId: 'other-pkg', revision: 2 },
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => job,
      getRevision: async (id) => {
        const data = await store.getRevision(id);
        return { exists: !!data, data: data || undefined };
      },
      writes,
    });
    expect(r).toMatchObject({ ok: false, reason: 'caller_authority_field' });
    const ok = await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => job,
      getRevision: async (id) => {
        const data = await store.getRevision(id);
        return { exists: !!data, data: data || undefined };
      },
      writes,
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.binding.packetRevision).toBe(1);
    expect(ok.binding.contentHash).toBe(rev1.contentHash);
    expect(writes).toEqual([]);
  });

  it('17-18. empty implemented effects and single export', () => {
    expect([...SERVER_IMPLEMENTED_EFFECTS]).toEqual([]);
    const callable = readFileSync(join(ROOT, 'functions', 'src', 'security', 'resolveExecutionBindingCallable.ts'), 'utf8');
    expect(callable).toMatch(/requireSecureDriver\(request, \{ allowLegacyHash: false \}\)/);
    expect(callable).not.toMatch(/requireManageDrivers/);
    expect(callable).not.toMatch(/allowLegacyHash: true/);
    const index = readFileSync(join(ROOT, 'functions', 'src', 'index.ts'), 'utf8');
    expect(index).toMatch(/^\s*resolveExecutionBinding,$/m);
    expect(index.match(/^\s*resolveExecutionBinding,$/gm)?.length).toBe(1);
    const barrel = readFileSync(join(ROOT, 'functions', 'src', 'security', 'index.ts'), 'utf8');
    expect(barrel).toMatch(/export \{ resolveExecutionBinding \} from '\.\/resolveExecutionBindingCallable'/);
    expect(barrel.match(/export \{ resolveExecutionBinding \}/g)?.length).toBe(1);
  });
});

describe('G-015 authoritative execution context', () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'g015-execution-binding-response.json'), 'utf8'));

  it('1. valid response contains the dispatch authoritative execution context', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const job = dispatchFrom(rev);
    const r = await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => job,
      getRevision: async (id) => {
        const data = await store.getRevision(id);
        return { exists: !!data, data: data || undefined };
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.execution).toEqual({
      jobTypeId: 'pw',
      wellName: 'Python',
      ndicWellName: 'PYTHON 1',
    });
    expect(r.execution.wellName).not.toBe(r.execution.ndicWellName);
  });

  it('2. request remains exactly { jobId }', () => {
    expect(parseResolveExecutionBindingRequest({ jobId: JOB })).toEqual({ ok: true, jobId: JOB });
    expect(Object.keys(parseResolveExecutionBindingRequest({ jobId: JOB }))).toEqual(['ok', 'jobId']);
  });

  it('3. caller wellName/ndicWellName/jobTypeId fields are rejected', () => {
    for (const key of ['wellName', 'ndicWellName', 'jobType', 'jobTypeId', 'execution', 'well']) {
      expect(parseResolveExecutionBindingRequest({ jobId: JOB, [key]: 'Python' })).toMatchObject({
        ok: false,
        reason: 'caller_authority_field',
        field: key,
      });
    }
  });

  it('4. other-driver and other-company lookups fail', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const job = dispatchFrom(rev);
    const getRev = async (id: string) => {
      const data = await store.getRevision(id);
      return { exists: !!data, data: data || undefined };
    };
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: OTHER_DRIVER, companyId: COMPANY },
      getDispatch: async () => job,
      getRevision: getRev,
    })).toMatchObject({ ok: false, reason: 'other_driver' });
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: OTHER },
      getDispatch: async () => job,
      getRevision: getRev,
    })).toMatchObject({ ok: false, reason: 'wrong_company' });
  });

  it('5. missing well identity fails closed', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const job = dispatchFrom(rev);
    const { wellName, ...noWell } = job;
    void wellName;
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => noWell,
      getRevision: async (id) => {
        const data = await store.getRevision(id);
        return { exists: !!data, data: data || undefined };
      },
    })).toMatchObject({ ok: false, reason: 'missing_well_identity' });
  });

  it('6. partial well identity fails closed', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => dispatchFrom(rev, { ndicWellName: '   ' }),
      getRevision: async (id) => {
        const data = await store.getRevision(id);
        return { exists: !!data, data: data || undefined };
      },
    })).toMatchObject({ ok: false, reason: 'partial_well_identity', field: 'ndicWellName' });
  });

  it('7. malformed well identity fails closed', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => dispatchFrom(rev, { wellName: { name: 'Python' } }),
      getRevision: async (id) => {
        const data = await store.getRevision(id);
        return { exists: !!data, data: data || undefined };
      },
    })).toMatchObject({ ok: false, reason: 'malformed_well_identity', field: 'wellName' });
  });

  it('8. caller cannot redirect the result to another well', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const r = await runResolveExecutionBinding({
      jobId: { jobId: JOB, wellName: 'Gab 1', ndicWellName: 'GAB 1' },
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => dispatchFrom(rev),
      getRevision: async (id) => {
        const data = await store.getRevision(id);
        return { exists: !!data, data: data || undefined };
      },
    });
    expect(r).toMatchObject({ ok: false, reason: 'caller_authority_field' });
  });

  it('9. canonical job type comes from the stored dispatch', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const r = await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => dispatchFrom(rev, { jobType: 'pw' }),
      getRevision: async (id) => {
        const data = await store.getRevision(id);
        return { exists: !!data, data: data || undefined };
      },
    });
    expect(r.ok && r.execution.jobTypeId).toBe('pw');
    expect(readDispatchExecutionContext(dispatchFrom(rev)).ok && (readDispatchExecutionContext(dispatchFrom(rev)) as any).execution.jobTypeId).toBe('pw');
  });

  it('10. tampered packet/pins still fail', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const job = dispatchFrom(rev);
    expect(await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => ({ ...job, contentHash: 'a'.repeat(64) }),
      getRevision: async (id) => {
        const data = await store.getRevision(id);
        return { exists: !!data, data: data || undefined };
      },
    })).toMatchObject({ ok: false, reason: 'content_hash_mismatch' });
  });

  it('11. resolver performs no writes', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const writes: unknown[] = ['sentinel'];
    const r = await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => dispatchFrom(rev),
      getRevision: async (id) => {
        const data = await store.getRevision(id);
        return { exists: !!data, data: data || undefined };
      },
      writes,
    });
    expect(r.ok).toBe(true);
    expect(writes).toEqual([]);
  });

  it('14. stored dispatch missing ndicWellName fails closed with missing_well_identity', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const job = dispatchFrom(rev);
    const { ndicWellName, ...noNdic } = job;
    void ndicWellName;
    const r = await runResolveExecutionBinding({
      jobId: JOB,
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => noNdic,
      getRevision: async (id) => {
        const data = await store.getRevision(id);
        return { exists: !!data, data: data || undefined };
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('missing_well_identity');
    expect(r.field).toBe('ndicWellName');
  });

  it('15. unbound legacy dispatch fails closed with unbound_dispatch:binding (never resolves against head)', async () => {
    const store = new MemoryStore();
    await publishRevision(store);
    const legacyJob = {
      companyId: COMPANY,
      driverId: DRIVER,
      status: 'accepted',
      jobType: 'pw',
      wellName: 'Gabriel 1',
      ndicWellName: 'GABRIEL 1-36-25H',
    };
    const r = await runResolveExecutionBinding({
      jobId: 'd-legacy-1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => legacyJob,
      getRevision: async (id) => {
        const data = await store.getRevision(id);
        return { exists: !!data, data: data || undefined };
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unbound_dispatch');
    expect(r.field).toBe('binding');
  });

  it('12-13. inventory/effects remain empty; fixture names match the operational API', () => {
    expect([...SERVER_IMPLEMENTED_EFFECTS]).toEqual([]);
    expect(Object.keys(fixture)).toEqual([
      'ok', 'jobId', 'companyId', 'driverId', 'binding', 'execution', 'definition', 'implementedEffects',
    ]);
    expect(Object.keys(fixture.binding)).toEqual(['packageId', 'packetRevision', 'contentHash', 'policyHash']);
    expect(Object.keys(fixture.execution)).toEqual(['jobTypeId', 'wellName', 'ndicWellName']);
    expect(fixture.implementedEffects).toEqual([]);
    const callable = readFileSync(join(ROOT, 'functions', 'src', 'security', 'resolveExecutionBindingCallable.ts'), 'utf8');
    expect(callable).toMatch(/execution: outcome\.execution/);
    expect(callable).not.toMatch(/\.set\(|\.update\(|\.delete\(/);
  });

  it('R1: zero getHead references exist in resolveExecutionBinding or resolveExecutionBindingCallable', () => {
    const operational = readFileSync(join(__dirname, '..', 'resolveExecutionBinding.ts'), 'utf8');
    const callable = readFileSync(join(ROOT, 'functions', 'src', 'security', 'resolveExecutionBindingCallable.ts'), 'utf8');
    expect(operational).not.toMatch(/getHead/);
    expect(operational).not.toMatch(/packageIndexDocId/);
    expect(callable).not.toMatch(/getHead/);
    expect(callable).not.toMatch(/INDEX_COLLECTION/);
  });
});
