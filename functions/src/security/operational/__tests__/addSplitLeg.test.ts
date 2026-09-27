import { readFileSync } from 'fs';
import { join } from 'path';
import {
  persistJobPacketRevision,
  revisionDocId,
  validatePublishInput,
  type RevisionStoreTx,
} from '../jobPacketRevisionStore';
import {
  CHILD_DISPATCH_ID_REQUIRED,
  FUTURE_WBT_SPLIT_LEG_WIRING,
  evaluateSplitLegCreateIfAbsent,
  matchOptionalCallerDriverHash,
  runAddSplitLeg,
} from '../addSplitLeg';
import { stampDispatchBinding } from '../dispatchPacketPin';

const COMPANY = 'liquid-gold';
const OTHER = 'other-hauler';
const PUBLISHER = 'uid-staff-1';
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const OTHER_DRIVER = 'ffffffff-0000-0000-0000-ffffffffffff';
const WELLS = ['Python', 'PYTHON 1'];

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

function parentJob(rev: { packageId: string; revision: number; contentHash: string; policyHash: string }, extra: Record<string, unknown> = {}) {
  return {
    companyId: COMPANY,
    driverId: DRIVER,
    driverHash: DRIVER,
    status: 'accepted',
    jobType: 'pw',
    wellName: 'Python',
    ndicWellName: 'PYTHON 1',
    splitGroupId: 'sg-1',
    splitSequence: 1,
    splitTotal: 1,
    packageId: rev.packageId,
    packetRevision: rev.revision,
    contentHash: rev.contentHash,
    policyHash: rev.policyHash,
    ...extra,
  };
}

function io(opts: {
  parent: Record<string, unknown> | null;
  child?: Record<string, unknown> | null;
  store: MemoryStore;
  parentId?: string;
  childId?: string;
}) {
  const creates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const updates: Array<{ id: string; total: number }> = [];
  const invoiceUpdates: Array<{ id: string; total: number }> = [];
  const requested: string[] = [];
  const parentId = opts.parentId || 'parent-1';
  const childId = opts.childId || 'child-1';
  const dispatches = new Map<string, Record<string, unknown>>();
  if (opts.parent) dispatches.set(parentId, opts.parent);
  if (opts.child) dispatches.set(childId, opts.child);
  return {
    creates,
    updates,
    invoiceUpdates,
    requested,
    run: (args: Partial<Parameters<typeof runAddSplitLeg>[0]> = {}) => runAddSplitLeg({
      caller: { driverId: DRIVER, companyId: COMPANY },
      parentDispatchId: parentId,
      dispatchId: childId,
      callerDriverHash: DRIVER,
      legSpec: { disposal: 'SWD-1', jobType: 'pw' },
      authorizedWells: WELLS,
      getDispatch: async (id) => dispatches.get(id) || null,
      getRevision: async (id) => {
        requested.push(id);
        const data = opts.store.revisions.get(id);
        return data ? { exists: true, data: { ...data } } : { exists: false };
      },
      listSiblings: async () => opts.parent
        ? [{ id: parentId, data: opts.parent }]
        : [],
      listInvoices: async () => [],
      applyCreate: (id, data) => {
        creates.push({ id, data });
        dispatches.set(id, data);
      },
      applySiblingTotal: (id, total) => { updates.push({ id, total }); },
      applyInvoiceTotal: (id, total) => { invoiceUpdates.push({ id, total }); },
      ...args,
    }),
  };
}

describe('F3 addSplitLeg governance', () => {
  it('unauthenticated request rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const harness = io({ parent: parentJob(rev), store });
    const r = await harness.run({ caller: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unauthenticated_driver');
    expect(harness.creates).toEqual([]);
  });

  it('omitted callerDriverHash cannot bypass identity', async () => {
    expect(matchOptionalCallerDriverHash(DRIVER, undefined).ok).toBe(true);
    expect(matchOptionalCallerDriverHash(DRIVER, '').ok).toBe(true);
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const harness = io({ parent: parentJob(rev), store });
    const unauth = await harness.run({ caller: null, callerDriverHash: undefined });
    expect(unauth.ok).toBe(false);
    if (unauth.ok) return;
    expect(unauth.reason).toBe('unauthenticated_driver');
    expect(harness.creates).toEqual([]);
    const authed = await harness.run({ callerDriverHash: undefined });
    expect(authed.ok).toBe(true);
    if (!authed.ok) return;
    expect(authed.result).toBe('created');
  });

  it('wrong driver rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const harness = io({ parent: parentJob(rev), store });
    const r = await harness.run({ caller: { driverId: OTHER_DRIVER, companyId: COMPANY } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('other_driver');
    expect(harness.creates).toEqual([]);
  });

  it('wrong company rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const harness = io({ parent: parentJob(rev), store });
    const r = await harness.run({ caller: { driverId: DRIVER, companyId: OTHER } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('wrong_company');
    expect(harness.creates).toEqual([]);
  });

  it('V9 request without child dispatchId fails closed with future WB-T wiring', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const harness = io({ parent: parentJob(rev), store });
    const r = await harness.run({ dispatchId: undefined });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe(CHILD_DISPATCH_ID_REQUIRED);
    expect(FUTURE_WBT_SPLIT_LEG_WIRING).toMatch(/client-minted dispatchId/);
    expect(harness.creates).toEqual([]);
  });

  it('partial parent binding rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const partial: Record<string, unknown> = { ...parentJob(rev) };
    Reflect.deleteProperty(partial, 'contentHash');
    Reflect.deleteProperty(partial, 'policyHash');
    const harness = io({ parent: partial, store });
    const r = await harness.run();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('partial_authority_group');
    expect(harness.creates).toEqual([]);
  });

  it('nonexistent parent revision rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const empty = new MemoryStore();
    const harness = io({ parent: parentJob(rev), store: empty });
    const r = await harness.run();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('revision_not_found');
    expect(harness.creates).toEqual([]);
  });

  it('wrong parent content hash rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const harness = io({ parent: parentJob(rev, { contentHash: 'd'.repeat(64) }), store });
    const r = await harness.run();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('content_hash_mismatch');
    expect(harness.creates).toEqual([]);
  });

  it('wrong parent policy hash rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const harness = io({ parent: parentJob(rev, { policyHash: 'e'.repeat(64) }), store });
    const r = await harness.run();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('policy_hash_mismatch');
    expect(harness.creates).toEqual([]);
  });

  it('altered stored revision rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const revId = revisionDocId(COMPANY, 'water-hauling', 1);
    const raw = JSON.parse(JSON.stringify(store.revisions.get(revId))) as Record<string, unknown>;
    raw.definition = { ...(raw.definition as Record<string, unknown>), label: 'Tampered' };
    const parent = parentJob(rev);
    const creates: unknown[] = [];
    const r = await runAddSplitLeg({
      caller: { driverId: DRIVER, companyId: COMPANY },
      parentDispatchId: 'parent-1',
      dispatchId: 'child-1',
      legSpec: { disposal: 'SWD-1', jobType: 'pw' },
      authorizedWells: WELLS,
      getDispatch: async (id) => id === 'parent-1' ? parent : null,
      getRevision: async () => ({ exists: true, data: raw }),
      listSiblings: async () => [{ id: 'parent-1', data: parent }],
      applyCreate: () => { creates.push(1); },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('content_hash_mismatch');
    expect(creates).toEqual([]);
  });

  it('arbitrary caller package ID cannot control the child', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const harness = io({ parent: parentJob(rev), store });
    const r = await harness.run({
      legSpec: { disposal: 'SWD-1', jobType: 'pw', packageId: 'aggregate' },
    });
    expect(r.ok).toBe(false);
    expect(harness.creates).toEqual([]);
  });

  it('arbitrary caller company/driver/well cannot control the child', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const harness = io({ parent: parentJob(rev), store });
    const company = await harness.run({
      legSpec: { disposal: 'SWD-1', jobType: 'pw', companyId: OTHER },
    });
    expect(company.ok).toBe(false);
    const well = await harness.run({
      legSpec: { disposal: 'SWD-1', jobType: 'pw', wellName: 'Gabriel 1' },
    });
    expect(well.ok).toBe(false);
    const driver = await harness.run({
      legSpec: { disposal: 'SWD-1', jobType: 'pw', driverId: OTHER_DRIVER },
    });
    expect(driver.ok).toBe(false);
    expect(harness.creates).toEqual([]);
  });

  it('label-only or unapproved job type rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const harness = io({ parent: parentJob(rev), store });
    const label = await harness.run({
      legSpec: { disposal: 'SWD-1', jobType: 'Production Water' },
    });
    expect(label.ok).toBe(false);
    if (!label.ok) expect(label.reason).toBe('job_type_label_only');
    const unknown = await harness.run({
      legSpec: { disposal: 'SWD-1', jobType: 'service' },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe('unknown_job_type');
    expect(harness.creates).toEqual([]);
  });

  it('valid canonical job type succeeds and stamps all four pins', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const parent = parentJob(rev);
    const harness = io({ parent, store });
    const r = await harness.run();
    expect(harness.requested).toEqual([revisionDocId(COMPANY, 'water-hauling', 1)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe('created');
    expect(harness.creates).toHaveLength(1);
    const child = harness.creates[0].data;
    const binding = stampDispatchBinding(rev);
    expect(child.packageId).toBe(binding.packageId);
    expect(child.packetRevision).toBe(binding.packetRevision);
    expect(child.contentHash).toBe(binding.contentHash);
    expect(child.policyHash).toBe(binding.policyHash);
    expect(child.companyId).toBe(COMPANY);
    expect(child.driverId).toBe(DRIVER);
    expect(child.wellName).toBe('Python');
    expect(child.ndicWellName).toBe('PYTHON 1');
    expect(child.jobType).toBe('pw');
    expect(child.status).toBe('pending');
    expect(child.parentDispatchId).toBe('parent-1');
    expect(child.splitGroupId).toBe('sg-1');
    expect(child.disposal).toBe('SWD-1');
    expect(child.splitSequence).toBe(2);
  });

  it('child preserves canonical tenant/driver/well identity', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const harness = io({ parent: parentJob(rev), store });
    const r = await harness.run({
      legSpec: { disposal: 'SWD-9', jobType: 'pw' },
    });
    expect(r.ok).toBe(true);
    const child = harness.creates[0].data;
    expect(child.companyId).toBe(COMPANY);
    expect(child.driverId).toBe(DRIVER);
    expect(child.wellName).toBe('Python');
    expect(child.ndicWellName).toBe('PYTHON 1');
    expect(child.disposal).toBe('SWD-9');
  });

  it('existing conflicting child ID rejects', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const parent = parentJob(rev);
    const harness = io({
      parent,
      child: {
        ...parent,
        wellName: 'Gabriel 1',
        ndicWellName: 'GABRIEL 1',
      },
      store,
    });
    const r = await harness.run();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('conflict');
    expect(harness.creates).toEqual([]);
  });

  it('exact replay is idempotent when child identity matches', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const parent = parentJob(rev);
    const binding = stampDispatchBinding(rev);
    const child = {
      companyId: COMPANY,
      driverId: DRIVER,
      jobType: 'pw',
      wellName: 'Python',
      ndicWellName: 'PYTHON 1',
      status: 'pending',
      splitGroupId: 'sg-1',
      splitSequence: 2,
      splitTotal: 2,
      parentDispatchId: 'parent-1',
      disposal: 'SWD-1',
      ...binding,
    };
    const harness = io({ parent, child, store });
    const r = await harness.run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe('already_exists');
    expect(harness.creates).toEqual([]);
    expect(harness.updates).toEqual([]);
    expect(child.status).toBe('pending');
    expect(child.splitSequence).toBe(2);
  });

  it('callable uses secure-driver auth, tx.create, and no auto-id birth', () => {
    const callable = readFileSync(join(__dirname, '..', '..', 'addSplitLegCallable.ts'), 'utf8');
    expect(callable).toMatch(/requireSecureDriver/);
    expect(callable).toMatch(/allowLegacyHash:\s*false/);
    expect(callable).toMatch(/enforceAppCheck:\s*false/);
    expect(callable).toMatch(/runAddSplitLeg/);
    expect(callable).toMatch(/REVISION_COLLECTION/);
    expect(callable).toMatch(/tx\.create/);
    expect(callable).not.toMatch(/\.add\(/);
    expect(callable).not.toMatch(/merge:\s*true/);
    expect(callable).not.toMatch(/collection\('dispatches'\)\.doc\(\)/);
    expect(callable).toMatch(/CHILD_DISPATCH_ID_REQUIRED/);
    expect(callable).toMatch(/FUTURE_WBT_SPLIT_LEG_WIRING/);
    const root = readFileSync(join(__dirname, '..', '..', '..', 'index.ts'), 'utf8');
    expect(root).toMatch(/export \{ addSplitLeg \} from '\.\/security\/addSplitLegCallable'/);
    expect(root).not.toMatch(/collection\('dispatches'\)\.doc\(\)/);
  });

  it('App Check follows the established production callable policy', () => {
    const split = readFileSync(join(__dirname, '..', '..', 'addSplitLegCallable.ts'), 'utf8');
    const accept = readFileSync(join(__dirname, '..', '..', 'acceptDriverDispatchCallable.ts'), 'utf8');
    const create = readFileSync(join(__dirname, '..', '..', 'createDriverDispatchCallable.ts'), 'utf8');
    expect(split).toMatch(/enforceAppCheck:\s*false/);
    expect(accept).toMatch(/enforceAppCheck:\s*false/);
    expect(create).toMatch(/enforceAppCheck:\s*false/);
  });
});

function completeChild(
  rev: { packageId: string; revision: number; contentHash: string; policyHash: string },
  extra: Record<string, unknown> = {},
) {
  return {
    companyId: COMPANY,
    driverId: DRIVER,
    jobType: 'pw',
    wellName: 'Python',
    ndicWellName: 'PYTHON 1',
    status: 'pending',
    assignedAt: 't-assigned',
    createdAt: 't-created',
    splitGroupId: 'sg-1',
    splitSequence: 2,
    splitTotal: 2,
    parentDispatchId: 'parent-1',
    disposal: 'SWD-1',
    packageId: rev.packageId,
    packetRevision: rev.revision,
    contentHash: rev.contentHash,
    policyHash: rev.policyHash,
    ...extra,
  };
}

function expectedFrom(
  rev: { packageId: string; revision: number; contentHash: string; policyHash: string },
  extra: Partial<{
    parentDispatchId: string;
    splitGroupId: string;
    disposal: string;
    destinationType: string;
    serviceType: string;
    disposalLat: number | null;
    disposalLng: number | null;
    jobTypeId: string;
    wellName: string;
    ndicWellName: string;
  }> = {},
) {
  return {
    parentDispatchId: extra.parentDispatchId || 'parent-1',
    splitGroupId: extra.splitGroupId || 'sg-1',
    companyId: COMPANY,
    driverId: DRIVER,
    jobTypeId: extra.jobTypeId || 'pw',
    binding: {
      packageId: rev.packageId,
      packetRevision: rev.revision,
      contentHash: rev.contentHash,
      policyHash: rev.policyHash,
    },
    well: {
      wellName: extra.wellName || 'Python',
      ndicWellName: extra.ndicWellName || 'PYTHON 1',
    },
    disposal: extra.disposal || 'SWD-1',
    destinationType: extra.destinationType || '',
    serviceType: extra.serviceType || '',
    disposalLat: extra.disposalLat === undefined ? null : extra.disposalLat,
    disposalLng: extra.disposalLng === undefined ? null : extra.disposalLng,
  };
}

describe('F4 split-leg replay identity', () => {
  it('exact retry returns already_exists and performs no writes or total updates', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const child = completeChild(rev);
    const harness = io({ parent: parentJob(rev), child, store });
    const r = await harness.run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe('already_exists');
    expect(r.splitSequence).toBe(2);
    expect(harness.creates).toEqual([]);
    expect(harness.updates).toEqual([]);
    expect(harness.invoiceUpdates).toEqual([]);
    expect(child.status).toBe('pending');
    expect(child.assignedAt).toBe('t-assigned');
    expect(child.createdAt).toBe('t-created');
    expect(child.splitTotal).toBe(2);
  });

  it('Claude probe: same child ID + different valid parent + same company/driver/binding/well/job type → conflict', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const parentA = parentJob(rev, { splitGroupId: 'sg-A' });
    const parentB = parentJob(rev, { splitGroupId: 'sg-B' });
    const child = completeChild(rev, { parentDispatchId: 'parent-A', splitGroupId: 'sg-A' });
    const creates: unknown[] = [];
    const siblingUpdates: unknown[] = [];
    const invoiceUpdates: unknown[] = [];
    const r = await runAddSplitLeg({
      caller: { driverId: DRIVER, companyId: COMPANY },
      parentDispatchId: 'parent-B',
      dispatchId: 'child-1',
      legSpec: { disposal: 'SWD-1', jobType: 'pw' },
      authorizedWells: WELLS,
      getDispatch: async (id) => {
        if (id === 'parent-B') return parentB;
        if (id === 'parent-A') return parentA;
        if (id === 'child-1') return child;
        return null;
      },
      getRevision: async (id) => {
        const data = store.revisions.get(id);
        return data ? { exists: true, data: { ...data } } : { exists: false };
      },
      listSiblings: async () => [{ id: 'parent-B', data: parentB }],
      listInvoices: async () => [{ id: 'inv-1' }],
      applyCreate: () => { creates.push(1); },
      applySiblingTotal: () => { siblingUpdates.push(1); },
      applyInvoiceTotal: () => { invoiceUpdates.push(1); },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('conflict');
    expect(r.field).toBe('parentDispatchId');
    expect(creates).toEqual([]);
    expect(siblingUpdates).toEqual([]);
    expect(invoiceUpdates).toEqual([]);
  });

  it('different split group with same generic identity conflicts', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const child = completeChild(rev, { splitGroupId: 'sg-other', parentDispatchId: 'parent-1' });
    const harness = io({ parent: parentJob(rev), child, store });
    const r = await harness.run();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('conflict');
    expect(r.field).toBe('splitGroupId');
    expect(harness.creates).toEqual([]);
    expect(harness.updates).toEqual([]);
  });

  it('different disposal/destination conflicts', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const child = completeChild(rev, { disposal: 'SWD-OTHER' });
    const harness = io({ parent: parentJob(rev), child, store });
    const r = await harness.run();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('conflict');
    expect(r.field).toBe('disposal');
    expect(harness.creates).toEqual([]);
  });

  it('different immutable sequence/ordinal conflicts', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const existing = completeChild(rev, { splitSequence: 3 });
    const r = evaluateSplitLegCreateIfAbsent({
      existing,
      expected: expectedFrom(rev),
      expectedSequence: 2,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('conflict');
    expect(r.field).toBe('splitSequence');
  });

  it('missing persisted parentDispatchId conflicts', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const child = completeChild(rev);
    Reflect.deleteProperty(child, 'parentDispatchId');
    const harness = io({ parent: parentJob(rev), child, store });
    const r = await harness.run();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('conflict');
    expect(r.field).toBe('parentDispatchId');
    expect(harness.creates).toEqual([]);
  });

  it('missing persisted splitGroupId conflicts', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const child = completeChild(rev);
    Reflect.deleteProperty(child, 'splitGroupId');
    const harness = io({ parent: parentJob(rev), child, store });
    const r = await harness.run();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('conflict');
    expect(r.field).toBe('splitGroupId');
    expect(harness.creates).toEqual([]);
  });

  it('partial split-leg identity conflicts', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const child = completeChild(rev);
    Reflect.deleteProperty(child, 'disposal');
    const harness = io({ parent: parentJob(rev), child, store });
    const r = await harness.run();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('conflict');
    expect(harness.creates).toEqual([]);
  });

  it('different generic binding/well/job type remains conflict', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const well = await runAddSplitLeg({
      caller: { driverId: DRIVER, companyId: COMPANY },
      parentDispatchId: 'parent-1',
      dispatchId: 'child-1',
      legSpec: { disposal: 'SWD-1', jobType: 'pw' },
      authorizedWells: WELLS,
      getDispatch: async (id) => {
        if (id === 'parent-1') return parentJob(rev);
        if (id === 'child-1') return completeChild(rev, { wellName: 'Gabriel 1', ndicWellName: 'GABRIEL 1' });
        return null;
      },
      getRevision: async (id) => {
        const data = store.revisions.get(id);
        return data ? { exists: true, data: { ...data } } : { exists: false };
      },
      listSiblings: async () => [],
      applyCreate: () => { throw new Error('must not create'); },
    });
    expect(well.ok).toBe(false);
    if (!well.ok) expect(well.reason).toBe('conflict');
    const jobType = evaluateSplitLegCreateIfAbsent({
      existing: completeChild(rev, { jobType: 'service' }),
      expected: expectedFrom(rev),
    });
    expect(jobType.ok).toBe(false);
    const binding = evaluateSplitLegCreateIfAbsent({
      existing: completeChild(rev, { contentHash: 'd'.repeat(64) }),
      expected: expectedFrom(rev),
    });
    expect(binding.ok).toBe(false);
  });

  it('legitimate retry after another sibling was added keeps original sequence and does not update totals', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const parent = parentJob(rev);
    const laterSibling = parentJob(rev, { splitSequence: 3, splitTotal: 3, parentDispatchId: 'parent-1' });
    const child = completeChild(rev, { splitSequence: 2, splitTotal: 2 });
    const harness = io({ parent, child, store });
    const r = await harness.run({
      listSiblings: async () => [
        { id: 'parent-1', data: parent },
        { id: 'later-3', data: laterSibling },
      ],
      listInvoices: async () => [{ id: 'inv-1' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe('already_exists');
    expect(r.splitSequence).toBe(2);
    expect(child.splitSequence).toBe(2);
    expect(child.splitTotal).toBe(2);
    expect(child.status).toBe('pending');
    expect(harness.creates).toEqual([]);
    expect(harness.updates).toEqual([]);
    expect(harness.invoiceUpdates).toEqual([]);
  });

  it('new child creation stamps authoritative parent, split family, disposal, and four-field pin', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const harness = io({ parent: parentJob(rev), store });
    const r = await harness.run({
      legSpec: { disposal: 'SWD-9', jobType: 'pw', destinationType: 'SWD', serviceType: 'water' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe('created');
    expect(harness.creates).toHaveLength(1);
    const child = harness.creates[0].data;
    expect(child.parentDispatchId).toBe('parent-1');
    expect(child.splitGroupId).toBe('sg-1');
    expect(child.disposal).toBe('SWD-9');
    expect(child.destinationType).toBe('SWD');
    expect(child.serviceType).toBe('water');
    expect(typeof child.splitSequence).toBe('number');
    expect(child.splitSequence).toBeGreaterThanOrEqual(1);
    expect(child.packageId).toBe(rev.packageId);
    expect(child.packetRevision).toBe(rev.revision);
    expect(child.contentHash).toBe(rev.contentHash);
    expect(child.policyHash).toBe(rev.policyHash);
    expect(child.companyId).toBe(COMPANY);
    expect(child.driverId).toBe(DRIVER);
    expect(child.wellName).toBe('Python');
    expect(child.ndicWellName).toBe('PYTHON 1');
    expect(child.jobType).toBe('pw');
  });
});
