import { readFileSync } from 'fs';
import { join } from 'path';
import {
  persistJobPacketRevision,
  validatePublishInput,
  validateStoredRevisionForBinding,
  type RevisionStoreTx,
} from '../jobPacketRevisionStore';
import {
  evaluateCreateIfAbsent,
  evaluateExistingDispatchDriverUpdate,
  collectAuthorizedWellNames,
  evaluateWellAuthorized,
  parsePacketRef,
  readDispatchBinding,
  rejectBindingMutation,
  rejectCallerAuthorityFields,
  requireCompleteBinding,
  resolveCanonicalJobType,
  stampDispatchBinding,
} from '../dispatchPacketPin';
import { evaluateAcceptDriverDispatch } from '../acceptDriverDispatch';
import { evaluateDriverDispatchBirth } from '../createDriverDispatch';
import { evaluateStaffWriteDispatch, resolveServerAssignmentIdentity } from '../staffWriteDispatch';

const COMPANY = 'liquid-gold';
const OTHER = 'other-hauler';
const PUBLISHER = 'uid-staff-1';
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';

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

async function publishRevision(store: MemoryStore, overrides: Record<string, unknown> = {}) {
  const built = validatePublishInput(validPayload(overrides), {
    companyId: COMPANY,
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

describe('packetRef selector', () => {
  it('16. missing packetRef fails', () => {
    expect(parsePacketRef(undefined).ok).toBe(false);
    expect((parsePacketRef(null) as { reason: string }).reason).toBe('packet_ref_required');
  });
  it('15. latest is rejected', () => {
    const r = parsePacketRef({ packageId: 'water-hauling', revision: 'latest' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('latest_rejected');
  });
  it('accepts exact packageId+revision only', () => {
    const r = parsePacketRef({ packageId: 'water-hauling', revision: 1 });
    expect(r.ok).toBe(true);
  });
  it('36. rejects unknown keys, accessors, inherited, symbols, non-finite', () => {
    expect(parsePacketRef({ packageId: 'water-hauling', revision: 1, extra: true }).ok).toBe(false);
    expect(parsePacketRef({ packageId: 'water-hauling', revision: Number.NaN }).ok).toBe(false);
    const inherited = Object.assign(Object.create({ packageId: 'water-hauling' }), { revision: 1 });
    expect(parsePacketRef(inherited).ok).toBe(false);
    let got = false;
    const accessor = { revision: 1 };
    Object.defineProperty(accessor, 'packageId', { enumerable: true, get() { got = true; return 'water-hauling'; } });
    expect(parsePacketRef(accessor).ok).toBe(false);
    expect(got).toBe(false);
  });
});

describe('stored revision binding validation', () => {
  it('1. exact revision lookup succeeds', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const raw = [...store.revisions.values()][0];
    const v = validateStoredRevisionForBinding(raw, { companyId: COMPANY, packageId: 'water-hauling', revision: 1 });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.envelope.contentHash).toBe(rev.contentHash);
    expect(v.envelope.policyHash).toBe(rev.policyHash);
  });
  it('2. missing revision fails via empty store', () => {
    expect(validateStoredRevisionForBinding(null, { companyId: COMPANY, packageId: 'water-hauling', revision: 1 }).ok).toBe(false);
  });
  it('3. wrong tenant fails', async () => {
    const store = new MemoryStore();
    await publishRevision(store);
    const raw = [...store.revisions.values()][0];
    const v = validateStoredRevisionForBinding(raw, { companyId: OTHER, packageId: 'water-hauling', revision: 1 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('revision_tenant_mismatch');
  });
  it('4. wrong package fails', async () => {
    const store = new MemoryStore();
    await publishRevision(store);
    const raw = [...store.revisions.values()][0];
    const v = validateStoredRevisionForBinding(raw, { companyId: COMPANY, packageId: 'aggregate', revision: 1 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('revision_package_mismatch');
  });
  it('5. wrong revision fails', async () => {
    const store = new MemoryStore();
    await publishRevision(store);
    const raw = [...store.revisions.values()][0];
    const v = validateStoredRevisionForBinding(raw, { companyId: COMPANY, packageId: 'water-hauling', revision: 2 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('revision_mismatch');
  });
  it('6. unpublished status fails', async () => {
    const store = new MemoryStore();
    await publishRevision(store);
    const raw = { ...[...store.revisions.values()][0], status: 'draft' };
    const v = validateStoredRevisionForBinding(raw, { companyId: COMPANY, packageId: 'water-hauling', revision: 1 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('unpublished_revision');
  });
  it('7. malformed stored revision fails', async () => {
    const v = validateStoredRevisionForBinding({ schemaVersion: 1 }, { companyId: COMPANY, packageId: 'water-hauling', revision: 1 });
    expect(v.ok).toBe(false);
  });
  it('8. unknown stored key fails', async () => {
    const store = new MemoryStore();
    await publishRevision(store);
    const raw = { ...[...store.revisions.values()][0], extra: true };
    const v = validateStoredRevisionForBinding(raw, { companyId: COMPANY, packageId: 'water-hauling', revision: 1 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('unknown_field');
  });
  it('9. content-hash mismatch fails', async () => {
    const store = new MemoryStore();
    await publishRevision(store);
    const raw = { ...[...store.revisions.values()][0], contentHash: 'b'.repeat(64) };
    const v = validateStoredRevisionForBinding(raw, { companyId: COMPANY, packageId: 'water-hauling', revision: 1 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('content_hash_mismatch');
  });
  it('10. policy-hash mismatch fails', async () => {
    const store = new MemoryStore();
    await publishRevision(store);
    const raw = { ...[...store.revisions.values()][0], policyHash: 'c'.repeat(64) };
    const v = validateStoredRevisionForBinding(raw, { companyId: COMPANY, packageId: 'water-hauling', revision: 1 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe('policy_hash_mismatch');
  });
});

describe('caller authority rejection', () => {
  it('11-14. caller hashes, companyId, and record packageId are rejected', () => {
    expect((rejectCallerAuthorityFields({ contentHash: 'a'.repeat(64), wellName: 'Python' }) as { reason: string }).reason).toBe('caller_authority_field');
    expect((rejectCallerAuthorityFields({ policyHash: 'a'.repeat(64), wellName: 'Python' }) as { reason: string }).reason).toBe('caller_authority_field');
    expect((rejectCallerAuthorityFields({ companyId: OTHER, wellName: 'Python' }) as { reason: string }).reason).toBe('caller_authority_field');
    expect((rejectCallerAuthorityFields({ packageId: 'water-hauling', wellName: 'Python' }) as { reason: string }).reason).toBe('caller_package_id_not_authority');
  });
  it('13. caller companyId cannot select tenant on staff create', () => {
    const r = evaluateStaffWriteDispatch({
      op: 'create',
      job: null,
      record: { wellName: 'Python', jobType: 'pw', companyId: OTHER },
      callerCompanyId: COMPANY,
      isPlatformAdmin: false,
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('cross_company');
    const admin = evaluateStaffWriteDispatch({
      op: 'create',
      job: null,
      record: { wellName: 'Python', jobType: 'pw', companyId: OTHER },
      isPlatformAdmin: true,
    });
    expect(admin.ok).toBe(false);
    expect((admin as { reason: string }).reason).toBe('caller_company_not_authority');
  });
});

describe('job type and well', () => {
  it('18. canonical job type succeeds', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const r = resolveCanonicalJobType('pw', rev.jobTypes);
    expect(r.ok).toBe(true);
  });
  it('19. unknown/label-only job type fails', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    expect((resolveCanonicalJobType('Production Water', rev.jobTypes) as { reason: string }).reason).toBe('job_type_label_only');
    expect((resolveCanonicalJobType('service', rev.jobTypes) as { reason: string }).reason).toBe('unknown_job_type');
    expect((resolveCanonicalJobType('pw', rev.jobTypes) as { ok: true }).ok).toBe(true);
  });
  it('22. unauthorized well fails', () => {
    expect(evaluateWellAuthorized('Python', '', ['Other']).ok).toBe(false);
    expect(evaluateWellAuthorized('Python', '', ['Python']).ok).toBe(true);
    expect(evaluateWellAuthorized('', '', ['Python']).ok).toBe(false);
  });
  it('well_config catalog authorizes key and ndicName; forged wellConfig shape without keys fails', () => {
    const catalog = collectAuthorizedWellNames({
      Python: { ndicName: 'PYTHON 1', tanks: 1 },
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    expect(evaluateWellAuthorized('Python', '', catalog.names, catalog.ambiguous).ok).toBe(true);
    expect(evaluateWellAuthorized('', 'PYTHON 1', catalog.names, catalog.ambiguous).ok).toBe(true);
    expect(evaluateWellAuthorized('Unknown', '', catalog.names, catalog.ambiguous).ok).toBe(false);
  });
  it('missing canonical catalog fails closed', () => {
    const empty = collectAuthorizedWellNames({});
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(evaluateWellAuthorized('Python', '', empty.names, empty.ambiguous)).toMatchObject({
      ok: false,
      reason: 'well_scope_unavailable',
    });
  });
  it('malformed catalog record fails closed', () => {
    expect(collectAuthorizedWellNames({ Python: 'nope' }).ok).toBe(false);
    expect(collectAuthorizedWellNames(['Python']).ok).toBe(false);
  });
  it('ambiguous aliases fail closed', () => {
    const catalog = collectAuthorizedWellNames({
      Python: { ndicName: 'SHARED' },
      Other: { ndicName: 'SHARED' },
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    expect(evaluateWellAuthorized('SHARED', '', catalog.names, catalog.ambiguous)).toMatchObject({
      ok: false,
      reason: 'well_alias_ambiguous',
    });
    expect(evaluateWellAuthorized('Python', '', catalog.names, catalog.ambiguous).ok).toBe(true);
  });
  it('other-company record is excluded when companyId is present', () => {
    const catalog = collectAuthorizedWellNames({
      Python: { ndicName: 'PYTHON 1', companyId: 'liquid-gold' },
      Foreign: { ndicName: 'FOREIGN 1', companyId: 'other-hauler' },
      Pool: { ndicName: 'POOL 1' },
    }, 'liquid-gold');
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    expect(evaluateWellAuthorized('Python', '', catalog.names, catalog.ambiguous).ok).toBe(true);
    expect(evaluateWellAuthorized('POOL 1', '', catalog.names, catalog.ambiguous).ok).toBe(true);
    expect(evaluateWellAuthorized('Foreign', '', catalog.names, catalog.ambiguous).ok).toBe(false);
  });
  it('caller cannot inject a well absent from the canonical catalog', () => {
    const catalog = collectAuthorizedWellNames({
      Python: { ndicName: 'PYTHON 1' },
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    expect(evaluateWellAuthorized('Forged', 'FORGED 1', catalog.names, catalog.ambiguous)).toMatchObject({
      ok: false,
      reason: 'well_unauthorized',
    });
    const forgedTree = collectAuthorizedWellNames({
      Python: { ndicName: 'PYTHON 1' },
      Forged: { ndicName: 'FORGED 1' },
    });
    expect(forgedTree.ok).toBe(true);
    if (!forgedTree.ok) return;
    expect(evaluateWellAuthorized('Forged', '', catalog.names, catalog.ambiguous).ok).toBe(false);
  });
});

describe('identity', () => {
  it('20. inactive/revoked driver fails', () => {
    const r = resolveServerAssignmentIdentity({
      clientDriverId: DRIVER,
      profile: { exists: true, active: false, companyId: COMPANY, legalName: 'A', displayName: 'a' },
      dispatchCompanyId: COMPANY,
      legacyWellPoolCompanyId: 'legacy-well-pool',
    });
    expect((r as { reason: string }).reason).toBe('driver_inactive');
  });
  it('21. cross-company driver fails', () => {
    const r = resolveServerAssignmentIdentity({
      clientDriverId: DRIVER,
      profile: { exists: true, active: true, companyId: OTHER, legalName: 'A', displayName: 'a' },
      dispatchCompanyId: COMPANY,
      legacyWellPoolCompanyId: 'legacy-well-pool',
    });
    expect((r as { reason: string }).reason).toBe('driver_company_mismatch');
  });
});

describe('idempotent birth and binding immutability', () => {
  it('17. partial authority group fails', () => {
    expect(readDispatchBinding({ packageId: 'water-hauling' }).partial).toBe(true);
    expect(requireCompleteBinding({ packageId: 'water-hauling' }).ok).toBe(false);
  });
  it('23-26. create, identical retry, conflict, lost-ack does not reset status', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const binding = stampDispatchBinding(rev);
    const well = { wellName: 'Python', ndicWellName: 'PYTHON 1' };
    const identity = { companyId: COMPANY, driverId: DRIVER, jobTypeId: 'pw', binding, well };
    const first = evaluateCreateIfAbsent({ existing: null, expected: identity });
    expect(first.ok && first.result === 'create').toBe(true);
    const existing = {
      companyId: COMPANY,
      driverId: DRIVER,
      jobType: 'pw',
      status: 'accepted',
      assignedAt: 't0',
      acceptedAt: 't1',
      wellName: 'Python',
      ndicWellName: 'PYTHON 1',
      ...binding,
    };
    const replay = evaluateCreateIfAbsent({ existing, expected: identity });
    expect(replay.ok && replay.result === 'already_exists').toBe(true);
    expect(existing.status).toBe('accepted');
    expect(existing.assignedAt).toBe('t0');
    expect(existing.acceptedAt).toBe('t1');
    const conflict = evaluateCreateIfAbsent({
      existing: { ...existing, contentHash: 'd'.repeat(64) },
      expected: identity,
    });
    expect(conflict.ok).toBe(false);
  });
  it('F2. identical canonical well returns already_exists', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const binding = stampDispatchBinding(rev);
    const well = { wellName: 'Python', ndicWellName: 'PYTHON 1' };
    const identity = { companyId: COMPANY, driverId: DRIVER, jobTypeId: 'pw', binding, well };
    const existing = {
      companyId: COMPANY,
      driverId: DRIVER,
      jobType: 'pw',
      status: 'in_progress',
      wellName: 'Python',
      ndicWellName: 'PYTHON 1',
      ...binding,
    };
    const replay = evaluateCreateIfAbsent({ existing, expected: identity });
    expect(replay.ok && replay.result === 'already_exists').toBe(true);
    expect(existing.status).toBe('in_progress');
  });
  it('F2. different wellName conflicts', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const binding = stampDispatchBinding(rev);
    const identity = {
      companyId: COMPANY, driverId: DRIVER, jobTypeId: 'pw', binding,
      well: { wellName: 'Python', ndicWellName: 'PYTHON 1' },
    };
    const r = evaluateCreateIfAbsent({
      existing: {
        companyId: COMPANY, driverId: DRIVER, jobType: 'pw',
        wellName: 'Gabriel 1', ndicWellName: 'PYTHON 1', ...binding,
      },
      expected: identity,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('conflict');
    expect(r.field).toBe('wellName');
  });
  it('F2. different ndicWellName conflicts', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const binding = stampDispatchBinding(rev);
    const identity = {
      companyId: COMPANY, driverId: DRIVER, jobTypeId: 'pw', binding,
      well: { wellName: 'Python', ndicWellName: 'PYTHON 1' },
    };
    const r = evaluateCreateIfAbsent({
      existing: {
        companyId: COMPANY, driverId: DRIVER, jobType: 'pw',
        wellName: 'Python', ndicWellName: 'GABRIEL 1', ...binding,
      },
      expected: identity,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('conflict');
    expect(r.field).toBe('ndicWellName');
  });
  it('F2. missing existing well identity conflicts', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const binding = stampDispatchBinding(rev);
    const identity = {
      companyId: COMPANY, driverId: DRIVER, jobTypeId: 'pw', binding,
      well: { wellName: 'Python', ndicWellName: 'PYTHON 1' },
    };
    const missingBoth = evaluateCreateIfAbsent({
      existing: { companyId: COMPANY, driverId: DRIVER, jobType: 'pw', ...binding },
      expected: identity,
    });
    expect(missingBoth.ok).toBe(false);
    const missingNdic = evaluateCreateIfAbsent({
      existing: { companyId: COMPANY, driverId: DRIVER, jobType: 'pw', wellName: 'Python', ...binding },
      expected: identity,
    });
    expect(missingNdic.ok).toBe(false);
  });
  it('F2. changed packet binding conflicts', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const binding = stampDispatchBinding(rev);
    const identity = {
      companyId: COMPANY, driverId: DRIVER, jobTypeId: 'pw', binding,
      well: { wellName: 'Python', ndicWellName: 'PYTHON 1' },
    };
    const r = evaluateCreateIfAbsent({
      existing: {
        companyId: COMPANY, driverId: DRIVER, jobType: 'pw',
        wellName: 'Python', ndicWellName: 'PYTHON 1',
        ...binding, packetRevision: 2,
      },
      expected: identity,
    });
    expect(r.ok).toBe(false);
  });
  it('F2. legitimate replay does not reset status, assignment, or timestamps', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const binding = stampDispatchBinding(rev);
    const identity = {
      companyId: COMPANY, driverId: DRIVER, jobTypeId: 'pw', binding,
      well: { wellName: 'Python', ndicWellName: 'PYTHON 1' },
    };
    const existing = {
      companyId: COMPANY,
      driverId: DRIVER,
      jobType: 'pw',
      status: 'accepted',
      assignedAt: 'keep-assigned',
      acceptedAt: 'keep-accepted',
      wellName: 'Python',
      ndicWellName: 'PYTHON 1',
      ...binding,
    };
    const replay = evaluateCreateIfAbsent({ existing, expected: identity });
    expect(replay.ok && replay.result === 'already_exists').toBe(true);
    expect(existing.status).toBe('accepted');
    expect(existing.driverId).toBe(DRIVER);
    expect(existing.assignedAt).toBe('keep-assigned');
    expect(existing.acceptedAt).toBe('keep-accepted');
  });
  it('27-29. staff update/cancel cannot mutate binding', () => {
    const existing = {
      companyId: COMPANY,
      status: 'pending',
      packageId: 'water-hauling',
      packetRevision: 1,
      contentHash: 'a'.repeat(64),
      policyHash: 'b'.repeat(64),
    };
    expect(rejectBindingMutation(existing, { packageId: 'x' }).ok).toBe(false);
    expect(rejectBindingMutation(existing, { notes: 'hi' }).ok).toBe(true);
    const cancel = evaluateStaffWriteDispatch({
      op: 'cancel',
      job: existing,
      callerCompanyId: COMPANY,
      isPlatformAdmin: false,
    });
    expect(cancel.ok).toBe(true);
    expect(readDispatchBinding(existing).complete).toBe(true);
  });
});

describe('accept preserves binding', () => {
  const bound = {
    companyId: COMPANY,
    driverId: DRIVER,
    status: 'pending',
    packageId: 'water-hauling',
    packetRevision: 1,
    contentHash: 'a'.repeat(64),
    policyHash: 'b'.repeat(64),
  };
  it('30-31. accept preserves binding and replay is idempotent', () => {
    const first = evaluateAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: bound,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result).toBe('accepted');
    const replay = evaluateAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: { ...bound, status: 'accepted', acceptedAt: 't' },
    });
    expect(replay.ok && replay.result === 'already_accepted').toBe(true);
    expect(readDispatchBinding(bound).binding.packageId).toBe('water-hauling');
  });
  it('32. another driver cannot accept', () => {
    const r = evaluateAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: 'ffffffff-0000-0000-0000-ffffffffffff', companyId: COMPANY },
      existing: bound,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('other_driver');
  });
  it('partial binding cannot be accepted; completely unbound dispatch can be accepted', () => {
    const partial = evaluateAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: { companyId: COMPANY, driverId: DRIVER, status: 'pending', packageId: 'water-hauling' },
    });
    expect(partial.ok).toBe(false);
    if (!partial.ok) {
      expect(partial.reason).toBe('partial_authority_group');
    }
    const unbound = evaluateAcceptDriverDispatch({
      dispatchId: 'd1',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: { companyId: COMPANY, driverId: DRIVER, status: 'pending' },
    });
    expect(unbound.ok).toBe(true);
  });
});

describe('driver create-if-absent', () => {
  it('creates with stamped binding and rejects record packageId', async () => {
    const store = new MemoryStore();
    const rev = await publishRevision(store);
    const denied = evaluateDriverDispatchBirth({
      dispatchId: 'dplan_1_01',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: null,
      record: { wellName: 'Python', jobType: 'pw', packageId: 'water-hauling' },
      envelope: rev,
    });
    expect(denied.ok).toBe(false);
    const ok = evaluateDriverDispatchBirth({
      dispatchId: 'dplan_1_01',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: null,
      record: { wellName: 'Python', jobType: 'pw' },
      envelope: rev,
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok || ok.result !== 'create') return;
    expect(ok.fields?.packageId).toBe('water-hauling');
    expect(ok.fields?.packetRevision).toBe(1);
    expect(ok.fields?.contentHash).toBe(rev.contentHash);
    expect(ok.fields?.policyHash).toBe(rev.policyHash);
    expect(ok.fields?.jobType).toBe('pw');
  });
});

describe('merge-upsert is update-only', () => {
  const bound = {
    companyId: COMPANY,
    driverId: DRIVER,
    status: 'accepted',
    packageId: 'water-hauling',
    packetRevision: 1,
    contentHash: 'a'.repeat(64),
    policyHash: 'b'.repeat(64),
  };
  it('33. merge-upsert cannot create', () => {
    const r = evaluateExistingDispatchDriverUpdate({
      existing: null,
      caller: { driverId: DRIVER, companyId: COMPANY },
      patch: { notes: 'x' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('cannot_create');
  });
  it('34. merge-upsert cannot alter authority', () => {
    const r = evaluateExistingDispatchDriverUpdate({
      existing: bound,
      caller: { driverId: DRIVER, companyId: COMPANY },
      patch: { packageId: 'other', contentHash: 'c'.repeat(64) },
    });
    expect(r.ok).toBe(false);
  });
});

describe('35. firestore rules deny client dispatch writes', () => {
  it('pins read-true create/update/delete-false', () => {
    const rules = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'firestore.rules'), 'utf8');
    expect(rules).toMatch(
      /match \/dispatches\/\{jobId\} \{\s*allow read: if true;\s*allow create, update, delete: if false;/,
    );
  });
});

describe('exports include governed driver callables', () => {
  it('root and security export createDriverDispatchIfAbsent and acceptDriverDispatch', () => {
    const root = readFileSync(join(__dirname, '..', '..', '..', '..', 'src', 'index.ts'), 'utf8');
    const security = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf8');
    expect(root).toMatch(/createDriverDispatchIfAbsent/);
    expect(root).toMatch(/acceptDriverDispatch/);
    expect(security).toMatch(/createDriverDispatchIfAbsent/);
    expect(security).toMatch(/acceptDriverDispatch/);
    const upsert = readFileSync(join(__dirname, '..', 'invoiceOps.ts'), 'utf8');
    expect(upsert).toMatch(/mode: 'update_only'/);
    expect(upsert).not.toMatch(/set\(d, \{ merge: true \}\)/);
  });
});
