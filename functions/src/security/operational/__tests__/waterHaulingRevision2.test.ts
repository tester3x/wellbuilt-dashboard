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
import { readDispatchExecutionContext, runResolveExecutionBinding } from '../resolveExecutionBinding';
import type { TrustedCompanyAuthority } from '../../trustedStaffAuthority';

const COMPANY = 'liquid-gold';
const OTHER = 'other-hauler';
const PUBLISHER = 'uid-staff-1';

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

describe('water-hauling revision 2 publication and canonical job-type validation', () => {
  const rev1DraftPath = join(__dirname, '../../../../../release/pw-fieldtest/20260922/pw-base-packet-draft.json');
  const rev2DraftPath = join(__dirname, '../../../../../release/pw-fieldtest/pw-revision-2-full-publish.json');
  const rev3DraftPath = join(__dirname, '../../../../../release/pw-fieldtest/pw-revision-3-full-publish.json');

  const rev1Draft = JSON.parse(readFileSync(rev1DraftPath, 'utf8'));
  const rev2Draft = JSON.parse(readFileSync(rev2DraftPath, 'utf8'));
  const rev3Draft = JSON.parse(readFileSync(rev3DraftPath, 'utf8'));

  it('1. rev2 draft validates through Contracts 0.7.0 definitionSchema', () => {
    const v = validate(definitionSchema, rev2Draft);
    expect(v.ok).toBe(true);
    expect((v as any).value.jobTypes.length).toBe(6);
  });

  it('2. publishes rev1 then rev2 through governed publication without mutating rev1', async () => {
    const store = new MemoryPublishStore();

    // Publish Revision 1
    const pub1 = await runPublishJobPacketRevision({
      caller: trusted(),
      request: {
        requestId: 'req-rev1',
        expectedLatestRevision: 0,
        packetDraft: rev1Draft,
      },
      store,
      publishedAt: '2026-09-22T00:00:00.000Z',
    });
    expect(pub1.ok).toBe(true);
    if (!pub1.ok) return;
    expect(pub1.revision).toBe(1);

    const rev1Doc = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 1));
    expect(rev1Doc).not.toBeNull();
    const rev1ContentHash = pub1.contentHash;

    // Publish Revision 2
    const pub2 = await runPublishJobPacketRevision({
      caller: trusted(),
      request: {
        requestId: 'req-rev2',
        expectedLatestRevision: 1,
        packetDraft: rev2Draft,
      },
      store,
      publishedAt: '2026-09-25T00:00:00.000Z',
    });
    expect(pub2.ok).toBe(true);
    if (!pub2.ok) return;
    expect(pub2.revision).toBe(2);
    expect(pub2.contentHash).not.toBe(pub1.contentHash);

    // Verify rev1 is untouched
    const rev1After = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 1));
    expect(rev1After).toEqual(rev1Doc);
    expect((rev1After as any).contentHash).toBe(rev1ContentHash);

    // Verify rev2 doc supersedes rev1
    const rev2Doc = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 2));
    expect(rev2Doc).not.toBeNull();
    expect((rev2Doc as any).supersedes).toEqual({
      packageId: 'water-hauling',
      revision: 1,
      contentHash: rev1ContentHash,
    });
  });

  it('3. proves all 6 canonical job types succeed Start Job pin verification against rev2 envelope', async () => {
    const store = new MemoryPublishStore();
    await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'r1', expectedLatestRevision: 0, packetDraft: rev1Draft },
      store,
      publishedAt: '2026-09-22T00:00:00.000Z',
    });
    const pub2 = await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'r2', expectedLatestRevision: 1, packetDraft: rev2Draft },
      store,
      publishedAt: '2026-09-25T00:00:00.000Z',
    });
    if (!pub2.ok) throw new Error('Publish 2 failed');

    const rev2Doc = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 2));
    const bound = validateStoredRevisionForBinding(rev2Doc, {
      companyId: COMPANY,
      packageId: 'water-hauling',
      revision: 2,
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    const envelope = bound.envelope;
    const expectedBinding = stampDispatchBinding(envelope);

    const sixTypes = [
      { jobTypeId: 'pw', legacyJobType: 'pw', serviceType: undefined },
      { jobTypeId: 'service-work', legacyJobType: 'service', serviceType: 'Service Work' },
      { jobTypeId: 'fresh-water', legacyJobType: 'service', serviceType: 'Fresh Water' },
      { jobTypeId: 'flowback-water', legacyJobType: 'service', serviceType: 'Flowback Water' },
      { jobTypeId: 'frac-water', legacyJobType: 'service', serviceType: 'Frac Water' },
      { jobTypeId: 'ground-water', legacyJobType: 'service', serviceType: 'Ground Water' },
    ];

    for (const t of sixTypes) {
      const dispatchDoc = {
        companyId: COMPANY,
        driverId: 'driver-uuid-1',
        wellName: 'Thor 1',
        ndicWellName: 'THOR 1-31-30H',
        jobTypeId: t.jobTypeId,
        jobType: t.legacyJobType,
        ...(t.serviceType ? { serviceType: t.serviceType } : {}),
        packageId: 'water-hauling',
        packetRevision: 2,
        contentHash: expectedBinding.contentHash,
        policyHash: expectedBinding.policyHash,
      };

      // 1. verifyDispatchPinsAgainstEnvelope succeeds
      const pinResult = verifyDispatchPinsAgainstEnvelope(dispatchDoc, envelope, COMPANY);
      expect(pinResult.ok).toBe(true);

      // 2. readDispatchExecutionContext reads canonical jobTypeId
      const execResult = readDispatchExecutionContext(dispatchDoc);
      expect(execResult.ok).toBe(true);
      if (execResult.ok) {
        expect(execResult.execution.jobTypeId).toBe(t.jobTypeId);
        expect(execResult.execution.wellName).toBe('Thor 1');
      }
    }
  });

  it('4. proves legacy dispatch without jobTypeId falls back safely to legacy jobType (PW)', async () => {
    const store = new MemoryPublishStore();
    await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'r1', expectedLatestRevision: 0, packetDraft: rev1Draft },
      store,
      publishedAt: '2026-09-22T00:00:00.000Z',
    });
    const rev1Doc = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 1));
    const bound = validateStoredRevisionForBinding(rev1Doc, {
      companyId: COMPANY,
      packageId: 'water-hauling',
      revision: 1,
    });
    if (!bound.ok) throw new Error('Rev 1 binding failed');

    const legacyPwDoc = {
      companyId: COMPANY,
      driverId: 'driver-uuid-1',
      wellName: 'Thor 1',
      ndicWellName: 'THOR 1-31-30H',
      jobType: 'pw', // no jobTypeId field
      packageId: 'water-hauling',
      packetRevision: 1,
      contentHash: stampDispatchBinding(bound.envelope).contentHash,
      policyHash: stampDispatchBinding(bound.envelope).policyHash,
    };

    const pinResult = verifyDispatchPinsAgainstEnvelope(legacyPwDoc, bound.envelope, COMPANY);
    expect(pinResult.ok).toBe(true);

    const execResult = readDispatchExecutionContext(legacyPwDoc);
    expect(execResult.ok).toBe(true);
    if (execResult.ok) {
      expect(execResult.execution.jobTypeId).toBe('pw');
    }
  });

  describe('5. negative security tests', () => {
    let envelope: any;
    let expectedBinding: any;

    beforeAll(async () => {
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
      const rev2Doc = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 2));
      const bound = validateStoredRevisionForBinding(rev2Doc, {
        companyId: COMPANY,
        packageId: 'water-hauling',
        revision: 2,
      });
      envelope = (bound as any).envelope;
      expectedBinding = stampDispatchBinding(envelope);
    });

    it('5a. unknown jobTypeId fails closed', () => {
      const dispatchDoc = {
        companyId: COMPANY,
        jobTypeId: 'invalid-submarine-fluid',
        jobType: 'service',
        packageId: 'water-hauling',
        packetRevision: 2,
        ...expectedBinding,
      };
      const res = verifyDispatchPinsAgainstEnvelope(dispatchDoc, envelope, COMPANY);
      expect(res.ok).toBe(false);
      expect((res as any).reason).toBe('unknown_job_type');
    });

    it('5b. label-only string fails closed with job_type_label_only', () => {
      const dispatchDoc = {
        companyId: COMPANY,
        jobTypeId: 'Fresh Water', // label, not slug
        jobType: 'service',
        packageId: 'water-hauling',
        packetRevision: 2,
        ...expectedBinding,
      };
      const res = verifyDispatchPinsAgainstEnvelope(dispatchDoc, envelope, COMPANY);
      expect(res.ok).toBe(false);
      expect((res as any).reason).toBe('job_type_label_only');
    });

    it('5c. tampered packetRevision fails closed with revision_mismatch', () => {
      const dispatchDoc = {
        companyId: COMPANY,
        jobTypeId: 'fresh-water',
        jobType: 'service',
        ...expectedBinding,
        packetRevision: 999, // tampered
      };
      const res = verifyDispatchPinsAgainstEnvelope(dispatchDoc, envelope, COMPANY);
      expect(res.ok).toBe(false);
      expect((res as any).reason).toBe('revision_mismatch');
    });

    it('5d. tampered contentHash fails closed with content_hash_mismatch', () => {
      const dispatchDoc = {
        companyId: COMPANY,
        jobTypeId: 'fresh-water',
        jobType: 'service',
        packageId: 'water-hauling',
        packetRevision: 2,
        contentHash: 'f'.repeat(64), // tampered
        policyHash: expectedBinding.policyHash,
      };
      const res = verifyDispatchPinsAgainstEnvelope(dispatchDoc, envelope, COMPANY);
      expect(res.ok).toBe(false);
      expect((res as any).reason).toBe('content_hash_mismatch');
    });

    it('5e. cross-company dispatch fails closed with revision_tenant_mismatch', () => {
      const dispatchDoc = {
        companyId: OTHER,
        jobTypeId: 'fresh-water',
        jobType: 'service',
        packageId: 'water-hauling',
        packetRevision: 2,
        ...expectedBinding,
      };
      const res = verifyDispatchPinsAgainstEnvelope(dispatchDoc, envelope, COMPANY);
      expect(res.ok).toBe(false);
      expect((res as any).reason).toBe('revision_tenant_mismatch');
    });
  });

  describe('6. water-hauling revision 3 per-job-type capability scoping', () => {
    it('6a. rev3 draft validates through Contracts 0.7.0 definitionSchema', () => {
      const v = validate(definitionSchema, rev3Draft);
      expect(v.ok).toBe(true);
      expect((v as any).value.jobTypes.length).toBe(6);
    });

    it('6b. publishes rev1 -> rev2 -> rev3 immutably', async () => {
      const store = new MemoryPublishStore();
      await runPublishJobPacketRevision({
        caller: trusted(),
        request: { requestId: 'req-r1', expectedLatestRevision: 0, packetDraft: rev1Draft },
        store,
        publishedAt: '2026-09-22T00:00:00.000Z',
      });
      await runPublishJobPacketRevision({
        caller: trusted(),
        request: { requestId: 'req-r2', expectedLatestRevision: 1, packetDraft: rev2Draft },
        store,
        publishedAt: '2026-09-25T00:00:00.000Z',
      });
      const rev2Doc = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 2));
      const rev2Hash = rev2Doc?.contentHash;

      const pub3 = await runPublishJobPacketRevision({
        caller: trusted(),
        request: { requestId: 'req-r3', expectedLatestRevision: 2, packetDraft: rev3Draft },
        store,
        publishedAt: '2026-09-25T21:00:00.000Z',
      });
      expect(pub3.ok).toBe(true);
      if (!pub3.ok) return;
      expect(pub3.revision).toBe(3);

      // Verify rev2 unchanged
      const rev2DocAfter = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 2));
      expect(rev2DocAfter?.contentHash).toBe(rev2Hash);
      expect(pub3.contentHash).not.toBe(rev2Hash);
    });

    it('6c. proves exact capability matrix gating per job type via resolveExecutionBinding', async () => {
      const store = new MemoryPublishStore();
      await runPublishJobPacketRevision({
        caller: trusted(),
        request: { requestId: 'req-r1', expectedLatestRevision: 0, packetDraft: rev1Draft },
        store,
        publishedAt: '2026-09-22T00:00:00.000Z',
      });
      await runPublishJobPacketRevision({
        caller: trusted(),
        request: { requestId: 'req-r2', expectedLatestRevision: 1, packetDraft: rev2Draft },
        store,
        publishedAt: '2026-09-25T00:00:00.000Z',
      });
      const pub3 = await runPublishJobPacketRevision({
        caller: trusted(),
        request: { requestId: 'req-r3', expectedLatestRevision: 2, packetDraft: rev3Draft },
        store,
        publishedAt: '2026-09-25T21:00:00.000Z',
      });
      if (!pub3.ok) throw new Error('pub3 failed');

      const rev3Doc = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 3));
      const bound = validateStoredRevisionForBinding(rev3Doc, {
        companyId: COMPANY,
        packageId: 'water-hauling',
        revision: 3,
      });
      if (!bound.ok) throw new Error('bind failed');
      const binding = stampDispatchBinding(bound.envelope);

      const driverId = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';

      // WB-T simulator for lookupGovernedCapability
      function simulateWbtCapability(def: Record<string, unknown>, capId: string): boolean {
        const caps = (def as any).capabilities;
        if (!Array.isArray(caps)) return false;
        const set = new Set(caps.map((c: any) => c?.capabilityId));
        return set.has(capId);
      }

      const matrix = [
        { type: 'pw', multiHaul: true, splitTicket: false },
        { type: 'service-work', multiHaul: true, splitTicket: true },
        { type: 'fresh-water', multiHaul: false, splitTicket: false },
        { type: 'flowback-water', multiHaul: false, splitTicket: false },
        { type: 'frac-water', multiHaul: false, splitTicket: false },
        { type: 'ground-water', multiHaul: false, splitTicket: false },
      ];

      for (const item of matrix) {
        const jobId = `job_${item.type}`;
        const dispatchDoc: Record<string, unknown> = {
          companyId: COMPANY,
          driverId,
          status: 'accepted',
          jobTypeId: item.type,
          jobType: item.type,
          wellName: 'Python',
          ndicWellName: 'PYTHON 1',
          ...binding,
        };

        const res = await runResolveExecutionBinding({
          jobId,
          caller: { driverId, companyId: COMPANY },
          getDispatch: async (id) => (id === jobId ? dispatchDoc : null),
          getRevision: async (id) => ({
            exists: id === revisionDocId(COMPANY, 'water-hauling', 3),
            data: rev3Doc || undefined,
          }),
        });

        expect(res.ok).toBe(true);
        if (!res.ok) continue;

        const defCaps = (res.definition as any).capabilities as Array<{ capabilityId: string }>;
        const capIds = defCaps.map((c) => c.capabilityId);

        expect(capIds).toContain('lifecycle');
        expect(capIds).toContain('pickup');

        if (item.multiHaul) {
          expect(capIds).toContain('multiHaul');
          expect(simulateWbtCapability(res.definition, 'multiHaul')).toBe(true);
        } else {
          expect(capIds).not.toContain('multiHaul');
          expect(simulateWbtCapability(res.definition, 'multiHaul')).toBe(false);
        }

        if (item.splitTicket) {
          expect(capIds).toContain('splitTicket');
          expect(simulateWbtCapability(res.definition, 'splitTicket')).toBe(true);
        } else {
          expect(capIds).not.toContain('splitTicket');
          expect(simulateWbtCapability(res.definition, 'splitTicket')).toBe(false);
        }
      }
    });
  });
});
