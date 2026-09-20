import { readFileSync } from 'fs';
import { join } from 'path';
import {
  persistJobPacketRevision,
  revisionDocId,
  validatePublishInput,
  type RevisionStoreTx,
} from '../jobPacketRevisionStore';
import { evaluateAcceptDriverDispatch, runAcceptDriverDispatch } from '../acceptDriverDispatch';
import { stampDispatchBinding } from '../dispatchPacketPin';

const COMPANY = 'liquid-gold';
const OTHER = 'other-hauler';
const PUBLISHER = 'uid-staff-1';
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const OTHER_DRIVER = 'ffffffff-0000-0000-0000-ffffffffffff';

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

function boundJob(rev: { packageId: string; revision: number; contentHash: string; policyHash: string }, extra: Record<string, unknown> = {}) {
  return {
    companyId: COMPANY,
    driverId: DRIVER,
    status: 'pending',
    jobType: 'pw',
    wellName: 'Python',
    ndicWellName: 'PYTHON 1',
    packageId: rev.packageId,
    packetRevision: rev.revision,
    contentHash: rev.contentHash,
    policyHash: rev.policyHash,
    ...extra,
  };
}

describe('F1 acceptDriverDispatch provenance', () => {
  it('presence evaluator can succeed while runtime still loads the stored revision', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const existing = boundJob(rev);
    const presence = evaluateAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing,
    });
    expect(presence.ok).toBe(true);
    const requested: string[] = [];
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const missing = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => existing,
      getRevision: async (id) => {
        requested.push(id);
        return { exists: false };
      },
      applyUpdate: (id, patch) => { updates.push({ id, patch }); },
    });
    expect(requested).toEqual([revisionDocId(COMPANY, 'water-hauling', 1)]);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toBe('revision_not_found');
    expect(updates).toEqual([]);
  });

  it('valid authenticated assigned driver + verified stored revision succeeds', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const existing = boundJob(rev);
    const requested: string[] = [];
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const r = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => existing,
      getRevision: async (id) => {
        requested.push(id);
        const data = store.revisions.get(id);
        return data ? { exists: true, data: { ...data } } : { exists: false };
      },
      applyUpdate: (id, patch) => { updates.push({ id, patch }); },
    });
    expect(requested).toEqual([revisionDocId(COMPANY, 'water-hauling', 1)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe('accepted');
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.status).toBe('accepted');
    expect(updates[0].patch.packageId).toBeUndefined();
    expect(updates[0].patch.contentHash).toBeUndefined();
    expect(existing.packageId).toBe(rev.packageId);
    expect(existing.packetRevision).toBe(rev.revision);
    expect(existing.contentHash).toBe(rev.contentHash);
    expect(existing.policyHash).toBe(rev.policyHash);
    expect(existing.companyId).toBe(COMPANY);
    expect(existing.driverId).toBe(DRIVER);
    expect(existing.jobType).toBe('pw');
    expect(existing.wellName).toBe('Python');
  });

  it('nonexistent revision rejects and performs no update', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const existing = boundJob(rev);
    const updates: unknown[] = [];
    const r = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => existing,
      getRevision: async () => ({ exists: false }),
      applyUpdate: () => { updates.push(1); },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('revision_not_found');
    expect(updates).toEqual([]);
  });

  it('partial binding rejects', async () => {
    const updates: unknown[] = [];
    const r = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => ({
        companyId: COMPANY, driverId: DRIVER, status: 'pending', packageId: 'water-hauling',
      }),
      getRevision: async () => ({ exists: true, data: {} }),
      applyUpdate: () => { updates.push(1); },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('partial_authority_group');
    expect(updates).toEqual([]);
  });

  it('wrong package ID rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const updates: unknown[] = [];
    const r = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => boundJob(rev, { packageId: 'aggregate' }),
      getRevision: async (id) => {
        const data = store.revisions.get(id);
        return data ? { exists: true, data: { ...data } } : { exists: false };
      },
      applyUpdate: () => { updates.push(1); },
    });
    expect(r.ok).toBe(false);
    expect(updates).toEqual([]);
  });

  it('wrong revision rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const updates: unknown[] = [];
    const r = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => boundJob(rev, { packetRevision: 2 }),
      getRevision: async (id) => {
        const data = store.revisions.get(id);
        return data ? { exists: true, data: { ...data } } : { exists: false };
      },
      applyUpdate: () => { updates.push(1); },
    });
    expect(r.ok).toBe(false);
    expect(updates).toEqual([]);
  });

  it('wrong content hash rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const requested: string[] = [];
    const updates: unknown[] = [];
    const r = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => boundJob(rev, { contentHash: 'd'.repeat(64) }),
      getRevision: async (id) => {
        requested.push(id);
        const data = store.revisions.get(id);
        return data ? { exists: true, data: { ...data } } : { exists: false };
      },
      applyUpdate: () => { updates.push(1); },
    });
    expect(requested).toEqual([revisionDocId(COMPANY, 'water-hauling', 1)]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('content_hash_mismatch');
    expect(updates).toEqual([]);
  });

  it('wrong policy hash rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const updates: unknown[] = [];
    const r = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => boundJob(rev, { policyHash: 'e'.repeat(64) }),
      getRevision: async (id) => {
        const data = store.revisions.get(id);
        return data ? { exists: true, data: { ...data } } : { exists: false };
      },
      applyUpdate: () => { updates.push(1); },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('policy_hash_mismatch');
    expect(updates).toEqual([]);
  });

  it('altered stored content with unchanged hash rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const revId = revisionDocId(COMPANY, 'water-hauling', 1);
    const raw = JSON.parse(JSON.stringify(store.revisions.get(revId))) as Record<string, unknown>;
    const def = { ...(raw.definition as Record<string, unknown>), label: 'Tampered' };
    raw.definition = def;
    const updates: unknown[] = [];
    const r = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => boundJob(rev),
      getRevision: async () => ({ exists: true, data: raw }),
      applyUpdate: () => { updates.push(1); },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('content_hash_mismatch');
    expect(updates).toEqual([]);
  });

  it('altered policy references with unchanged hash rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store, {
      policyRefs: [{
        kind: 'company-policy',
        policyId: 'gate-1',
        revision: 1,
        contentHash: 'a'.repeat(64),
      }],
    });
    const revId = revisionDocId(COMPANY, 'water-hauling', 1);
    const raw = JSON.parse(JSON.stringify(store.revisions.get(revId))) as Record<string, unknown>;
    raw.policyRefs = [{
      kind: 'company-policy',
      policyId: 'gate-2',
      revision: 1,
      contentHash: 'a'.repeat(64),
    }];
    const updates: unknown[] = [];
    const r = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => boundJob(rev),
      getRevision: async () => ({ exists: true, data: raw }),
      applyUpdate: () => { updates.push(1); },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('policy_hash_mismatch');
    expect(updates).toEqual([]);
  });

  it('other-tenant revision rejects', async () => {
    const store = new MemoryStore();
    await publishRevision(store, {}, OTHER);
    const home = new MemoryStore();
    const rev = await publishRevision(home);
    const otherId = revisionDocId(OTHER, 'water-hauling', 1);
    const foreign = store.revisions.get(otherId);
    const updates: unknown[] = [];
    const r = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => boundJob(rev),
      getRevision: async () => foreign ? { exists: true, data: { ...foreign } } : { exists: false },
      applyUpdate: () => { updates.push(1); },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('revision_tenant_mismatch');
    expect(updates).toEqual([]);
  });

  it('job type absent from verified envelope rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const updates: unknown[] = [];
    const r = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => boundJob(rev, { jobType: 'service' }),
      getRevision: async (id) => {
        const data = store.revisions.get(id);
        return data ? { exists: true, data: { ...data } } : { exists: false };
      },
      applyUpdate: () => { updates.push(1); },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unknown_job_type');
    expect(updates).toEqual([]);
  });

  it('different assigned driver rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const updates: unknown[] = [];
    const r = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: OTHER_DRIVER, companyId: COMPANY },
      getDispatch: async () => boundJob(rev),
      getRevision: async (id) => {
        const data = store.revisions.get(id);
        return data ? { exists: true, data: { ...data } } : { exists: false };
      },
      applyUpdate: () => { updates.push(1); },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('other_driver');
    expect(updates).toEqual([]);
  });

  it('invalid status rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const updates: unknown[] = [];
    const r = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => boundJob(rev, { status: 'completed' }),
      getRevision: async () => ({ exists: true, data: {} }),
      applyUpdate: () => { updates.push(1); },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid_status');
    expect(updates).toEqual([]);
  });

  it('successful acceptance preserves all four pins and immutable identity', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const existing = boundJob(rev);
    const binding = stampDispatchBinding(rev);
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const r = await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => existing,
      getRevision: async (id) => {
        const data = store.revisions.get(id);
        return data ? { exists: true, data: { ...data } } : { exists: false };
      },
      applyUpdate: (id, patch) => { updates.push({ id, patch }); },
    });
    expect(r.ok).toBe(true);
    expect(existing.packageId).toBe(binding.packageId);
    expect(existing.packetRevision).toBe(binding.packetRevision);
    expect(existing.contentHash).toBe(binding.contentHash);
    expect(existing.policyHash).toBe(binding.policyHash);
    expect(updates[0].patch).not.toHaveProperty('packageId');
    expect(updates[0].patch).not.toHaveProperty('packetRevision');
    expect(updates[0].patch).not.toHaveProperty('contentHash');
    expect(updates[0].patch).not.toHaveProperty('policyHash');
    expect(updates[0].patch).not.toHaveProperty('companyId');
    expect(updates[0].patch).not.toHaveProperty('driverId');
    expect(updates[0].patch).not.toHaveProperty('jobType');
    expect(updates[0].patch).not.toHaveProperty('wellName');
  });

  it('caller authority/binding fields cannot alter the record', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const existing = boundJob(rev);
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    await runAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      getDispatch: async () => existing,
      getRevision: async (id) => {
        const data = store.revisions.get(id);
        return data ? { exists: true, data: { ...data } } : { exists: false };
      },
      applyUpdate: (id, patch) => { updates.push({ id, patch }); },
    });
    expect(Object.keys(updates[0].patch).every((k) => ![
      'packageId', 'packetRevision', 'contentHash', 'policyHash', 'companyId', 'driverId', 'jobType', 'wellName', 'ndicWellName',
    ].includes(k))).toBe(true);
  });

  it('callable loads the stored revision through the transaction reader', () => {
    const callable = readFileSync(join(__dirname, '..', '..', 'acceptDriverDispatchCallable.ts'), 'utf8');
    expect(callable).toMatch(/runAcceptDriverDispatch/);
    expect(callable).toMatch(/REVISION_COLLECTION/);
    expect(callable).toMatch(/tx\.get/);
    expect(callable).toMatch(/requireSecureDriver/);
    expect(callable).toMatch(/enforceAppCheck:\s*false/);
    expect(callable).toMatch(/allowLegacyHash:\s*false/);
    expect(callable).not.toMatch(/evaluateAcceptDriverDispatch/);
  });
});
