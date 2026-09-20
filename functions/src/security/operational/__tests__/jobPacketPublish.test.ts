import { readFileSync } from 'fs';
import { join } from 'path';
import { validate, definitionSchema } from '@tester3x/wellbuilt-contracts/transport';
import {
  SERVER_IMPLEMENTED_EFFECTS,
  revisionDocId,
  validateStoredRevisionForBinding,
} from '../jobPacketRevisionStore';
import { resolveCanonicalJobType, stampDispatchBinding } from '../dispatchPacketPin';
import {
  decidePublishStaffAccess,
  parsePublishRequest,
  runPublishJobPacketRevision,
  type PublishStoreTx,
} from '../jobPacketPublish';
import type { TrustedCompanyAuthority } from '../../trustedStaffAuthority';

const COMPANY = 'liquid-gold';
const OTHER = 'other-hauler';
const PUBLISHER = 'uid-staff-1';

function trusted(over: Partial<TrustedCompanyAuthority> = {}): TrustedCompanyAuthority {
  return {
    uid: PUBLISHER,
    companyId: COMPANY,
    ...over,
  };
}

export function productionWaterDefinition(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    packetId: 'water-hauling',
    industryId: 'oil-gas',
    segmentId: 'produced-water',
    label: 'Water Hauling',
    jobTypes: [
      { jobTypeId: 'pw', label: 'Production Water', capabilities: ['lifecycle', 'pickup'] },
    ],
    capabilities: [
      { capabilityId: 'lifecycle', moduleVersion: 1, configuration: {} },
      { capabilityId: 'pickup', moduleVersion: 1, configuration: { unit: 'bbl' } },
    ],
    fields: [
      {
        key: 'pickupLocationId',
        label: 'Pickup',
        capabilityId: 'pickup',
        kind: 'location',
        required: true,
      },
    ],
    commandRules: [
      {
        command: 'lifecycle.advance',
        states: ['planned', 'accepted', 'atPickup', 'loaded', 'inTransit', 'atDropoff', 'unloaded'],
      },
      { command: 'lifecycle.close', states: ['unloaded'] },
      { command: 'lifecycle.cancel', states: ['planned', 'accepted'] },
      { command: 'pickup.record', states: ['atPickup'] },
    ],
    workflow: [
      { from: 'planned', to: 'accepted', command: 'lifecycle.advance' },
      { from: 'accepted', to: 'atPickup', command: 'lifecycle.advance' },
      { from: 'atPickup', to: 'loaded', command: 'lifecycle.advance' },
      { from: 'loaded', to: 'inTransit', command: 'lifecycle.advance' },
      { from: 'inTransit', to: 'atDropoff', command: 'lifecycle.advance' },
      { from: 'atDropoff', to: 'unloaded', command: 'lifecycle.advance' },
      { from: 'unloaded', to: 'closed', command: 'lifecycle.close' },
      { from: 'planned', to: 'cancelled', command: 'lifecycle.cancel' },
    ],
    compatibility: {
      minimumContractVersion: 1,
      legacyAdapterId: null,
      migrationFrom: null,
    },
  };
}

class MemoryPublishStore implements PublishStoreTx {
  revisions = new Map<string, Record<string, unknown>>();
  claims = new Map<string, Record<string, unknown>>();
  heads = new Map<string, Record<string, unknown>>();
  receipts = new Map<string, Record<string, unknown>>();
  writes: string[] = [];
  failNext: string | null = null;
  async getRevision(docId: string) {
    const v = this.revisions.get(docId);
    return v ? { ...v } : null;
  }
  async getClaim(docId: string) {
    const v = this.claims.get(docId);
    return v ? { ...v } : null;
  }
  createRevision(docId: string, data: Record<string, unknown>) {
    if (this.failNext === 'createRevision') throw new Error('tx-fail');
    if (this.revisions.has(docId)) throw new Error('already-exists');
    this.revisions.set(docId, { ...data });
    this.writes.push(`revision:${docId}`);
  }
  createClaim(docId: string, data: Record<string, unknown>) {
    if (this.claims.has(docId)) throw new Error('already-exists');
    this.claims.set(docId, { ...data });
    this.writes.push(`claim:${docId}`);
  }
  async getHead(docId: string) {
    const v = this.heads.get(docId);
    return v ? { ...v } : null;
  }
  createHead(docId: string, data: Record<string, unknown>) {
    if (this.heads.has(docId)) throw new Error('already-exists');
    this.heads.set(docId, { ...data });
    this.writes.push(`head-create:${docId}`);
  }
  updateHead(docId: string, data: Record<string, unknown>) {
    if (!this.heads.has(docId)) throw new Error('not-found');
    this.heads.set(docId, { ...this.heads.get(docId), ...data });
    this.writes.push(`head-update:${docId}`);
  }
  async getReceipt(docId: string) {
    const v = this.receipts.get(docId);
    return v ? { ...v } : null;
  }
  createReceipt(docId: string, data: Record<string, unknown>) {
    if (this.receipts.has(docId)) throw new Error('already-exists');
    this.receipts.set(docId, { ...data });
    this.writes.push(`receipt:${docId}`);
  }
}

function req(over: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    expectedLatestRevision: 0,
    packetDraft: productionWaterDefinition(),
    ...over,
  };
}

async function publish(store: MemoryPublishStore, over: Record<string, unknown> = {}, caller: TrustedCompanyAuthority | null = trusted()) {
  return runPublishJobPacketRevision({
    caller,
    request: req(over),
    store,
    publishedAt: 'ts-1',
  });
}

describe('authority', () => {
  it('unauthenticated rejects', () => {
    const r = decidePublishStaffAccess(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unauthenticated');
  });
  it('missing uid rejects', () => {
    const r = decidePublishStaffAccess(trusted({ uid: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unauthenticated');
  });
  it('authorized trusted company staff is accepted', () => {
    const r = decidePublishStaffAccess(trusted());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.companyId).toBe(COMPANY);
      expect(r.publisherUid).toBe(PUBLISHER);
    }
  });
  it('missing company rejects', () => {
    const r = decidePublishStaffAccess(trusted({ companyId: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_company');
  });
  it('leftover RTDB role/cap fields do not grant or substitute company', () => {
    const r = decidePublishStaffAccess({
      uid: PUBLISHER,
      companyId: '',
      ...({ roles: ['it'], caps: ['manageDrivers'], isPlatformAdmin: true } as object),
    } as TrustedCompanyAuthority);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_company');
  });
  it('cross-tenant platform-admin leftover does not bypass missing company', () => {
    const r = decidePublishStaffAccess({
      uid: PUBLISHER,
      companyId: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_company');
  });
});

describe('request parsing', () => {
  it('extra request key rejects', () => {
    const r = parsePublishRequest(req({ extra: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_field');
  });
  it('malformed requestId rejects', () => {
    expect(parsePublishRequest(req({ requestId: 'a/b' })).ok).toBe(false);
    expect(parsePublishRequest(req({ requestId: '' })).ok).toBe(false);
  });
  it('malformed expectedLatestRevision rejects', () => {
    expect(parsePublishRequest(req({ expectedLatestRevision: -1 })).ok).toBe(false);
    expect(parsePublishRequest(req({ expectedLatestRevision: 1.5 })).ok).toBe(false);
    expect(parsePublishRequest(req({ expectedLatestRevision: 'latest' })).ok).toBe(false);
  });
  it('caller hashes/revision/effects/timestamps/targetCompanyId reject', () => {
    expect((parsePublishRequest(req({ companyId: OTHER })) as { reason: string }).reason).toBe('caller_authority_field');
    expect((parsePublishRequest(req({ revision: 1 })) as { reason: string }).reason).toBe('caller_authority_field');
    expect((parsePublishRequest(req({ contentHash: 'a'.repeat(64) })) as { reason: string }).reason).toBe('caller_authority_field');
    expect((parsePublishRequest(req({ implementedEffects: ['pickup'] })) as { reason: string }).reason).toBe('caller_authority_field');
    expect((parsePublishRequest(req({ publishedAt: 't' })) as { reason: string }).reason).toBe('caller_authority_field');
    expect((parsePublishRequest(req({ targetCompanyId: OTHER })) as { reason: string }).reason).toBe('caller_authority_field');
    expect((parsePublishRequest(req({ publisherUid: 'x' })) as { reason: string }).reason).toBe('caller_authority_field');
  });
});

describe('Contracts 0.7.0 draft validation', () => {
  it('Production Water fixture validates through the published package', () => {
    const checked = validate(definitionSchema, productionWaterDefinition());
    expect(checked.ok).toBe(true);
  });
  it('malformed Contracts draft rejects', async () => {
    const r = await publish(new MemoryPublishStore(), { packetDraft: { schemaVersion: 1, packetId: 'water-hauling' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.startsWith('contracts_')).toBe(true);
  });
  it('duplicate capability/job-type IDs reject', async () => {
    const draft = productionWaterDefinition();
    draft.jobTypes = [
      { jobTypeId: 'pw', label: 'Production Water', capabilities: ['lifecycle', 'pickup'] },
      { jobTypeId: 'pw', label: 'Other', capabilities: ['lifecycle'] },
    ];
    const r = await publish(new MemoryPublishStore(), { packetDraft: draft });
    expect(r.ok).toBe(false);
  });
  it('unknown capability rejects', async () => {
    const draft = productionWaterDefinition();
    (draft.capabilities as unknown[]).push({ capabilityId: 'teleport', moduleVersion: 1, configuration: {} });
    const r = await publish(new MemoryPublishStore(), { packetDraft: draft });
    expect(r.ok).toBe(false);
  });
  it('nonempty policyRefs reject while inventory is empty', async () => {
    const draft = productionWaterDefinition();
    (draft.capabilities as unknown[]).push({
      capabilityId: 'multiHaul',
      moduleVersion: 1,
      configuration: {
        allocationPolicy: { policyId: 'invented', revision: 1, contentHash: 'a'.repeat(64) },
      },
    });
    const r = await publish(new MemoryPublishStore(), { packetDraft: draft });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('policy_refs_not_empty');
  });
  it('oversized draft rejects safely', async () => {
    const draft = productionWaterDefinition();
    draft.label = 'x'.repeat(250000);
    const r = await publish(new MemoryPublishStore(), { packetDraft: draft });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('oversized_draft');
  });
});

describe('publication', () => {
  it('first publish creates revision 1 and C3 accepts the binding group', async () => {
    const store = new MemoryPublishStore();
    const r = await publish(store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe('created');
    expect(r.revision).toBe(1);
    expect(r.packetRevision).toBe(1);
    expect(r.packageId).toBe('water-hauling');
    expect(r.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.policyHash).toMatch(/^[a-f0-9]{64}$/);
    const raw = [...store.revisions.values()][0];
    expect(raw.implementedEffects).toEqual([]);
    expect([...SERVER_IMPLEMENTED_EFFECTS]).toEqual([]);
    expect(raw.companyId).toBe(COMPANY);
    expect(raw.publishedByUid).toBe(PUBLISHER);
    expect(revisionDocId(COMPANY, 'water-hauling', 1)).toBe([...store.revisions.keys()][0]);
    const bound = validateStoredRevisionForBinding(raw, {
      companyId: COMPANY, packageId: 'water-hauling', revision: 1,
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const pin = stampDispatchBinding(bound.envelope);
    expect(pin).toEqual({
      packageId: 'water-hauling',
      packetRevision: 1,
      contentHash: r.contentHash,
      policyHash: r.policyHash,
    });
    expect(resolveCanonicalJobType('pw', bound.envelope.jobTypes).ok).toBe(true);
    const head = [...store.heads.values()][0];
    expect(head.latestRevision).toBe(1);
    expect(head.companyId).toBe(COMPANY);
    expect(head.updatedByUid).toBe(PUBLISHER);
    const receipt = [...store.receipts.values()][0];
    expect(receipt.companyId).toBe(COMPANY);
    expect(receipt.publishedByUid).toBe(PUBLISHER);
    expect(store.receipts.size).toBe(1);
  });

  it('changed content with expected revision 1 creates revision 2', async () => {
    const store = new MemoryPublishStore();
    expect((await publish(store)).ok).toBe(true);
    const draft = productionWaterDefinition();
    (draft.fields as unknown[]).push({
      key: 'loadedQuantity', label: 'Quantity', capabilityId: 'pickup', kind: 'quantity', required: true,
    });
    const second = await publish(store, { requestId: 'req-2', expectedLatestRevision: 1, packetDraft: draft });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result).toBe('created');
    expect(second.revision).toBe(2);
    expect(second.contentHash).not.toBe([...store.heads.values()][0] && '');
    expect([...store.heads.values()][0].latestRevision).toBe(2);
  });

  it('exact same requestId replays original result with no writes', async () => {
    const store = new MemoryPublishStore();
    const first = await publish(store);
    const n = store.writes.length;
    const replay = await publish(store);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.result).toBe('created');
    expect(replay.revision).toBe(1);
    expect(replay.contentHash).toBe(first.contentHash);
    expect(store.writes.length).toBe(n);
    expect(store.revisions.size).toBe(1);
  });

  it('reused requestId with different content conflicts', async () => {
    const store = new MemoryPublishStore();
    expect((await publish(store)).ok).toBe(true);
    const draft = productionWaterDefinition();
    (draft.fields as unknown[]).push({
      key: 'loadedQuantity', label: 'Quantity', capabilityId: 'pickup', kind: 'quantity', required: true,
    });
    const r = await publish(store, { packetDraft: draft });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('conflict');
  });

  it('new requestId with unchanged content returns unchanged and does not create another revision', async () => {
    const store = new MemoryPublishStore();
    const first = await publish(store);
    const second = await publish(store, { requestId: 'req-2', expectedLatestRevision: 1 });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.result).toBe('unchanged');
    expect(second.revision).toBe(1);
    expect(second.contentHash).toBe(first.contentHash);
    expect(store.revisions.size).toBe(1);
    expect(store.receipts.size).toBe(2);
  });

  it('stale expected revision conflicts', async () => {
    const store = new MemoryPublishStore();
    expect((await publish(store)).ok).toBe(true);
    const r = await publish(store, { requestId: 'req-2', expectedLatestRevision: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('stale_expected_revision');
  });

  it('two concurrent publishers cannot both claim the same next revision', async () => {
    const first = new MemoryPublishStore();
    expect((await publish(first)).ok).toBe(true);
    const second = new MemoryPublishStore();
    second.revisions = first.revisions;
    second.claims = first.claims;
    second.heads = first.heads;
    second.receipts = new Map(first.receipts);
    const r = await publish(second, { requestId: 'req-other', expectedLatestRevision: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('stale_expected_revision');
    expect(first.revisions.size).toBe(1);
  });

  it('target revision collision fails closed', async () => {
    const store = new MemoryPublishStore();
    const id = revisionDocId(COMPANY, 'water-hauling', 1);
    store.revisions.set(id, { companyId: COMPANY });
    const r = await publish(store);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('revision_collision');
    expect(store.heads.size).toBe(0);
    expect(store.receipts.size).toBe(0);
  });

  it('missing/invalid head revision fails closed', async () => {
    const store = new MemoryPublishStore();
    expect((await publish(store)).ok).toBe(true);
    store.revisions.clear();
    const r = await publish(store, { requestId: 'req-2', expectedLatestRevision: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('head_revision_missing');
  });

  it('malformed head fails closed', async () => {
    const store = new MemoryPublishStore();
    expect((await publish(store)).ok).toBe(true);
    const key = [...store.heads.keys()][0];
    store.heads.set(key, { companyId: COMPANY, packageId: 'water-hauling', latestRevision: '1' });
    const r = await publish(store, { requestId: 'req-2', expectedLatestRevision: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed_head');
  });

  it('malformed receipt fails closed', async () => {
    const store = new MemoryPublishStore();
    expect((await publish(store)).ok).toBe(true);
    const key = [...store.receipts.keys()][0];
    store.receipts.set(key, { companyId: COMPANY, packageId: 'water-hauling', requestId: 'req-1' });
    const r = await publish(store);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed_receipt');
  });

  it('receipt referencing missing revision fails closed', async () => {
    const store = new MemoryPublishStore();
    expect((await publish(store)).ok).toBe(true);
    const key = [...store.receipts.keys()][0];
    const rec = { ...store.receipts.get(key)! };
    rec.revision = 9;
    store.receipts.set(key, rec);
    const r = await publish(store);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('receipt_revision_missing');
  });

  it('transaction failure leaves no partial writes', async () => {
    const store = new MemoryPublishStore();
    store.failNext = 'createRevision';
    await expect(publish(store)).rejects.toThrow('tx-fail');
    expect(store.heads.size).toBe(0);
    expect(store.receipts.size).toBe(0);
    expect(store.revisions.size).toBe(0);
  });

  it('immutable revision cannot be overwritten', async () => {
    const store = new MemoryPublishStore();
    expect((await publish(store)).ok).toBe(true);
    const id = [...store.revisions.keys()][0];
    const before = { ...store.revisions.get(id)! };
    store.failNext = null;
    const r = await publish(store, { requestId: 'req-2', expectedLatestRevision: 0 });
    expect(r.ok).toBe(false);
    expect(store.revisions.get(id)).toEqual(before);
  });

  it('content or policy tampering causes C3 validation to reject', async () => {
    const store = new MemoryPublishStore();
    expect((await publish(store)).ok).toBe(true);
    const raw = { ...[...store.revisions.values()][0] };
    raw.definition = { ...(raw.definition as Record<string, unknown>), label: 'Tampered' };
    const bound = validateStoredRevisionForBinding(raw, {
      companyId: COMPANY, packageId: 'water-hauling', revision: 1,
    });
    expect(bound.ok).toBe(false);
  });

  it('another company cannot resolve the revision', async () => {
    const store = new MemoryPublishStore();
    expect((await publish(store)).ok).toBe(true);
    const raw = [...store.revisions.values()][0];
    const bound = validateStoredRevisionForBinding(raw, {
      companyId: OTHER, packageId: 'water-hauling', revision: 1,
    });
    expect(bound.ok).toBe(false);
    if (!bound.ok) expect(bound.reason).toBe('revision_tenant_mismatch');
  });
});

describe('truth and reachability', () => {
  it('stamps empty implementedEffects and empty policy inventory', async () => {
    const store = new MemoryPublishStore();
    const r = await publish(store);
    expect(r.ok).toBe(true);
    const raw = [...store.revisions.values()][0];
    expect(raw.implementedEffects).toEqual([]);
    expect([...SERVER_IMPLEMENTED_EFFECTS]).toEqual([]);
  });
  it('callable uses trusted company-scoped staff auth and App Check stays unenforced', () => {
    const callable = readFileSync(join(__dirname, '..', '..', 'jobPacketPublishCallable.ts'), 'utf8');
    expect(callable).toMatch(/requireTrustedCompanyCapability/);
    expect(callable).toMatch(/TRUSTED_CAPABILITY_MANAGE_DRIVERS/);
    expect(callable).not.toMatch(/requireManageDrivers/);
    expect(callable).not.toMatch(/adminAuth/);
    expect(callable).not.toMatch(/users\/\$\{/);
    expect(callable).not.toMatch(/roleCapabilities/);
    expect(callable).toMatch(/enforceAppCheck:\s*false/);
    expect(callable).not.toMatch(/authorizeAdminCall/);
    expect(callable).not.toMatch(/targetCompanyId/);
    const root = readFileSync(join(__dirname, '..', '..', '..', 'index.ts'), 'utf8');
    expect(root).toMatch(/publishJobPacketRevision/);
    const rules = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'firestore.rules'), 'utf8');
    expect(rules).toMatch(/job_packet_publication_receipts/);
    expect(rules).toMatch(/job_packet_package_index/);
    expect(rules).toMatch(/allow read, write: if false;/);
  });
});
