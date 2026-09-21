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
