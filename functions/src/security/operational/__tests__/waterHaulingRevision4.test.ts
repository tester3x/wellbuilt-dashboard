import { readFileSync } from 'fs';
import { join } from 'path';
import { validate, definitionSchema } from '@tester3x/wellbuilt-contracts/transport';
import {
  revisionDocId,
  validateStoredRevisionForBinding,
} from '../jobPacketRevisionStore';
import {
  resolveCanonicalJobType,
  verifyDispatchPinsAgainstEnvelope,
  stampDispatchBinding,
} from '../dispatchPacketPin';
import {
  runPublishJobPacketRevision,
  type PublishStoreTx,
} from '../jobPacketPublish';
import { runResolveExecutionBinding } from '../resolveExecutionBinding';
import type { TrustedCompanyAuthority } from '../../trustedStaffAuthority';

const COMPANY = 'liquid-gold';
const OTHER = 'other-hauler';
const PUBLISHER = 'uid-staff-1';
const DRIVER_ID = 'driver-123';

class MemoryPublishStore implements PublishStoreTx {
  receipts = new Map<string, Record<string, unknown>>();
  heads = new Map<string, Record<string, unknown>>();
  revisions = new Map<string, Record<string, unknown>>();
  claims = new Map<string, Record<string, unknown>>();

  async getReceipt(id: string) { return this.receipts.get(id) || null; }
  createReceipt(id: string, d: Record<string, unknown>) { this.receipts.set(id, d); }
  async getHead(id: string) { return this.heads.get(id) || null; }
  createHead(id: string, d: Record<string, unknown>) { this.heads.set(id, d); }
  updateHead(id: string, d: Record<string, unknown>) { this.heads.set(id, d); }
  async getRevision(id: string) { return this.revisions.get(id) || null; }
  createRevision(id: string, d: Record<string, unknown>) { this.revisions.set(id, d); }
  async getClaim(id: string) { return this.claims.get(id) || null; }
  createClaim(id: string, d: Record<string, unknown>) { this.claims.set(id, d); }
  async recordClaim() {}
}

function trusted(over: Partial<TrustedCompanyAuthority> = {}): TrustedCompanyAuthority {
  return {
    uid: PUBLISHER,
    companyId: COMPANY,
    ...over,
  };
}

const LIQUID_GOLD_CUSTOM_JOB_TYPES = [
  {
    id: 'ground-water',
    label: 'Ground Water',
    packages: ['water-hauling', 'aggregate'],
    baseJobTypeId: 'service-work',
    lifecycleShape: 'pickup_dropoff',
    capabilities: ['lifecycle', 'pickup'],
  },
];

describe('water-hauling revision 4 governed publication and custom job type binding', () => {
  const rev1DraftPath = join(__dirname, '../../../../../release/pw-fieldtest/20260922/pw-base-packet-draft.json');
  const rev2DraftPath = join(__dirname, '../../../../../release/pw-fieldtest/pw-revision-2-full-publish.json');
  const rev3DraftPath = join(__dirname, '../../../../../release/pw-fieldtest/pw-revision-3-full-publish.json');
  const rev4DraftPath = join(__dirname, '../../../../../release/pw-fieldtest/pw-revision-4-full-publish.json');

  const rev1Draft = JSON.parse(readFileSync(rev1DraftPath, 'utf8'));
  const rev2Draft = JSON.parse(readFileSync(rev2DraftPath, 'utf8'));
  const rev3Draft = JSON.parse(readFileSync(rev3DraftPath, 'utf8'));
  const rev4Draft = JSON.parse(readFileSync(rev4DraftPath, 'utf8'));

  it('1. rev4 draft validates through Contracts 0.7.0 definitionSchema and contains exactly 4 built-ins', () => {
    const v = validate(definitionSchema, rev4Draft);
    expect(v.ok).toBe(true);
    const value = (v as any).value;
    expect(value.jobTypes.length).toBe(4);
    const ids = value.jobTypes.map((jt: any) => jt.jobTypeId);
    expect(ids).toEqual(['pw', 'service-work', 'fresh-water', 'flowback-water']);
    expect(ids).not.toContain('frac-water');
    expect(ids).not.toContain('ground-water');
  });

  it('2. publishes rev1 -> rev2 -> rev3 -> rev4 preserving immutability of prior revisions', async () => {
    const store = new MemoryPublishStore();

    // Rev 1
    const pub1 = await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'req-r1', expectedLatestRevision: 0, packetDraft: rev1Draft },
      store,
      publishedAt: '2026-09-22T00:00:00.000Z',
    });
    expect(pub1.ok).toBe(true);
    const rev1Doc = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 1));

    // Rev 2
    const pub2 = await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'req-r2', expectedLatestRevision: 1, packetDraft: rev2Draft },
      store,
      publishedAt: '2026-09-25T00:00:00.000Z',
    });
    expect(pub2.ok).toBe(true);
    const rev2Doc = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 2));

    // Rev 3
    const pub3 = await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'req-r3', expectedLatestRevision: 2, packetDraft: rev3Draft },
      store,
      publishedAt: '2026-09-25T12:00:00.000Z',
    });
    expect(pub3.ok).toBe(true);
    const rev3Doc = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 3));

    // Rev 4
    const pub4 = await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'req-r4', expectedLatestRevision: 3, packetDraft: rev4Draft },
      store,
      publishedAt: '2026-09-26T00:00:00.000Z',
    });
    expect(pub4.ok).toBe(true);
    if (!pub4.ok) return;
    expect(pub4.revision).toBe(4);

    // Verify rev1, rev2, rev3 are untouched
    expect(await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 1))).toEqual(rev1Doc);
    expect(await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 2))).toEqual(rev2Doc);
    expect(await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 3))).toEqual(rev3Doc);

    // Verify rev4 supersedes rev3
    const rev4Doc = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 4));
    expect(rev4Doc).not.toBeNull();
    expect((rev4Doc as any).supersedes).toEqual({
      packageId: 'water-hauling',
      revision: 3,
      contentHash: (pub3 as any).contentHash,
    });
  });

  it('3. verifies 4 global built-in job types against rev4 envelope', async () => {
    const store = new MemoryPublishStore();
    await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'r1', expectedLatestRevision: 0, packetDraft: rev1Draft },
      store,
      publishedAt: '2026-09-22T00:00:00.000Z',
    });
    await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'r2', expectedLatestRevision: 1, packetDraft: rev2Draft },
      store,
      publishedAt: '2026-09-25T00:00:00.000Z',
    });
    await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'r3', expectedLatestRevision: 2, packetDraft: rev3Draft },
      store,
      publishedAt: '2026-09-25T12:00:00.000Z',
    });
    const pub4 = await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'r4', expectedLatestRevision: 3, packetDraft: rev4Draft },
      store,
      publishedAt: '2026-09-26T00:00:00.000Z',
    });
    if (!pub4.ok) throw new Error('Publish 4 failed');

    const rev4Doc = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 4));
    const bound = validateStoredRevisionForBinding(rev4Doc, {
      companyId: COMPANY,
      packageId: 'water-hauling',
      revision: 4,
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    const envelope = bound.envelope;

    const testTypes = [
      { id: 'pw', expectedCaps: ['lifecycle', 'pickup', 'multiHaul'] },
      { id: 'service-work', expectedCaps: ['lifecycle', 'pickup', 'multiHaul', 'splitTicket'] },
      { id: 'fresh-water', expectedCaps: ['lifecycle', 'pickup'] },
      { id: 'flowback-water', expectedCaps: ['lifecycle', 'pickup'] },
    ];

    for (const tt of testTypes) {
      const resolved = resolveCanonicalJobType(tt.id, envelope.jobTypes, LIQUID_GOLD_CUSTOM_JOB_TYPES);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.jobTypeId).toBe(tt.id);
      expect(resolved.isCustom).toBe(false);
      expect(resolved.capabilities).toEqual(tt.expectedCaps);

      const dispatchDoc = {
        companyId: COMPANY,
        driverId: DRIVER_ID,
        jobTypeId: tt.id,
        wellName: 'Thor 1',
        ndicWellName: 'THOR  1-31-30H',
        status: 'accepted',
        ...stampDispatchBinding(envelope),
      };

      const pinRes = verifyDispatchPinsAgainstEnvelope(dispatchDoc, envelope, COMPANY, LIQUID_GOLD_CUSTOM_JOB_TYPES);
      expect(pinRes.ok).toBe(true);

      const execRes = await runResolveExecutionBinding({
        jobId: 'disp-test',
        caller: { driverId: DRIVER_ID, companyId: COMPANY },
        getDispatch: async () => dispatchDoc,
        getRevision: async () => ({ exists: true, data: rev4Doc! }),
      });
      expect(execRes.ok).toBe(true);
      if (!execRes.ok) continue;
      const capIds = (execRes.definition.capabilities as any[]).map((c) => c.capabilityId);
      expect(capIds).toEqual(tt.expectedCaps);
    }
  });

  it('4. removed global types (frac-water, ground-water without company config) fail closed', async () => {
    const store = new MemoryPublishStore();
    const pub4 = await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'r4', expectedLatestRevision: 0, packetDraft: rev4Draft },
      store,
      publishedAt: '2026-09-26T00:00:00.000Z',
    });
    if (!pub4.ok) throw new Error('Publish 4 failed');

    const rev4Doc = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 4));
    const bound = validateStoredRevisionForBinding(rev4Doc, {
      companyId: COMPANY,
      packageId: 'water-hauling',
      revision: 4,
    });
    if (!bound.ok) return;

    // frac-water is neither built-in nor custom -> fails closed
    const fracRes = resolveCanonicalJobType('frac-water', bound.envelope.jobTypes, LIQUID_GOLD_CUSTOM_JOB_TYPES);
    expect(fracRes.ok).toBe(false);
    expect((fracRes as any).reason).toBe('unknown_job_type');

    // ground-water without customJobTypes (or for another company without custom config) -> fails closed
    const gwNoConfig = resolveCanonicalJobType('ground-water', bound.envelope.jobTypes, []);
    expect(gwNoConfig.ok).toBe(false);
    expect((gwNoConfig as any).reason).toBe('unknown_job_type');
  });

  it('5. custom job type (ground-water) binds to liquid-gold with explicit capabilities and without multiHaul/splitTicket', async () => {
    const store = new MemoryPublishStore();
    const pub4 = await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'r4', expectedLatestRevision: 0, packetDraft: rev4Draft },
      store,
      publishedAt: '2026-09-26T00:00:00.000Z',
    });
    if (!pub4.ok) throw new Error('Publish 4 failed');

    const rev4Doc = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 4));
    const bound = validateStoredRevisionForBinding(rev4Doc, {
      companyId: COMPANY,
      packageId: 'water-hauling',
      revision: 4,
    });
    if (!bound.ok) return;

    // 1. resolveCanonicalJobType resolves ground-water via LIQUID_GOLD_CUSTOM_JOB_TYPES
    const resolved = resolveCanonicalJobType('ground-water', bound.envelope.jobTypes, LIQUID_GOLD_CUSTOM_JOB_TYPES);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.jobTypeId).toBe('ground-water');
    expect(resolved.baseJobTypeId).toBe('service-work');
    expect(resolved.isCustom).toBe(true);
    expect(resolved.capabilities).toEqual(['lifecycle', 'pickup']);

    // 2. Reject label-only attempt
    const labelOnly = resolveCanonicalJobType('Ground Water', bound.envelope.jobTypes, LIQUID_GOLD_CUSTOM_JOB_TYPES);
    expect(labelOnly.ok).toBe(false);
    expect((labelOnly as any).reason).toBe('job_type_label_only');

    // 3. Dispatch document with ground-water passes verifyDispatchPinsAgainstEnvelope
    const dispatchDoc: Record<string, unknown> = {
      companyId: COMPANY,
      driverId: DRIVER_ID,
      jobTypeId: 'ground-water',
      serviceType: 'Ground Water',
      wellName: 'Thor 1',
      ndicWellName: 'THOR  1-31-30H',
      status: 'accepted',
      ...stampDispatchBinding(bound.envelope),
    };

    const pinRes = verifyDispatchPinsAgainstEnvelope(dispatchDoc, bound.envelope, COMPANY, LIQUID_GOLD_CUSTOM_JOB_TYPES);
    expect(pinRes.ok).toBe(true);
    if (!pinRes.ok) return;
    expect(pinRes.resolvedJobType.jobTypeId).toBe('ground-water');
    expect(pinRes.resolvedJobType.isCustom).toBe(true);

    // 4. resolveExecutionBinding resolves execution context and gates capabilities strictly
    const execRes = await runResolveExecutionBinding({
      jobId: 'disp-gw-1',
      caller: { driverId: DRIVER_ID, companyId: COMPANY },
      getDispatch: async () => dispatchDoc,
      getRevision: async () => ({ exists: true, data: rev4Doc! }),
      getCompany: async (id) => (id === COMPANY ? { customJobTypes: LIQUID_GOLD_CUSTOM_JOB_TYPES } : null),
    });
    expect(execRes.ok).toBe(true);
    if (!execRes.ok) return;

    expect(execRes.execution.jobTypeId).toBe('ground-water');
    const capIds = (execRes.definition.capabilities as any[]).map((c) => c.capabilityId);
    expect(capIds).toEqual(['lifecycle', 'pickup']);
    expect(capIds).not.toContain('multiHaul');
    expect(capIds).not.toContain('splitTicket');

    // Ground water is also present in definition.jobTypes
    const defJobTypes = execRes.definition.jobTypes as any[];
    const gwInDef = defJobTypes.find((jt) => jt.jobTypeId === 'ground-water');
    expect(gwInDef).toBeDefined();
    expect(gwInDef.capabilities).toEqual(['lifecycle', 'pickup']);

    // 5. Cross-company tenant isolation: other-hauler cannot resolve ground-water
    const otherRes = await runResolveExecutionBinding({
      jobId: 'disp-gw-other',
      caller: { driverId: DRIVER_ID, companyId: OTHER },
      getDispatch: async () => ({ ...dispatchDoc, companyId: OTHER }),
      getRevision: async () => ({ exists: true, data: rev4Doc! }),
      getCompany: async () => ({ customJobTypes: [] }), // other company has no customJobTypes
    });
    expect(otherRes.ok).toBe(false);
    expect((otherRes as any).reason).toBe('unknown_job_type');
  });
});
