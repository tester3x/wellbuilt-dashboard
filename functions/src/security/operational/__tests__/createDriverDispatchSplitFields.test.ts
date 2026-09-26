import { readFileSync } from 'fs';
import { join } from 'path';
import {
  evaluateDriverDispatchBirth,
  pickDriverCreateFields,
  DRIVER_DISPATCH_CREATE_ALLOWLIST,
} from '../createDriverDispatch';
import {
  runPublishJobPacketRevision,
  type PublishStoreTx,
} from '../jobPacketPublish';
import {
  validateStoredRevisionForBinding,
  revisionDocId,
  type ImmutableRevisionEnvelope,
} from '../jobPacketRevisionStore';
import type { TrustedCompanyAuthority } from '../../trustedStaffAuthority';

const COMPANY = 'liquid-gold';
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
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

describe('createDriverDispatch planned split-ticket fields and security invariants', () => {
  let envelope: ImmutableRevisionEnvelope;

  beforeAll(async () => {
    const rev1DraftPath = join(__dirname, '../../../../../release/pw-fieldtest/20260922/pw-base-packet-draft.json');
    const rev2DraftPath = join(__dirname, '../../../../../release/pw-fieldtest/pw-revision-2-full-publish.json');
    const rev3DraftPath = join(__dirname, '../../../../../release/pw-fieldtest/pw-revision-3-full-publish.json');
    const rev4DraftPath = join(__dirname, '../../../../../release/pw-fieldtest/pw-revision-4-full-publish.json');

    const rev1Draft = JSON.parse(readFileSync(rev1DraftPath, 'utf8'));
    const rev2Draft = JSON.parse(readFileSync(rev2DraftPath, 'utf8'));
    const rev3Draft = JSON.parse(readFileSync(rev3DraftPath, 'utf8'));
    const rev4Draft = JSON.parse(readFileSync(rev4DraftPath, 'utf8'));

    const store = new MemoryPublishStore();

    const pub1 = await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'req-r1', expectedLatestRevision: 0, packetDraft: rev1Draft },
      store,
      publishedAt: '2026-09-22T00:00:00.000Z',
    });
    if (!pub1.ok) throw new Error('Failed to publish rev 1: ' + JSON.stringify(pub1));

    const pub2 = await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'req-r2', expectedLatestRevision: 1, packetDraft: rev2Draft },
      store,
      publishedAt: '2026-09-25T00:00:00.000Z',
    });
    if (!pub2.ok) throw new Error('Failed to publish rev 2: ' + JSON.stringify(pub2));

    const pub3 = await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'req-r3', expectedLatestRevision: 2, packetDraft: rev3Draft },
      store,
      publishedAt: '2026-09-25T12:00:00.000Z',
    });
    if (!pub3.ok) throw new Error('Failed to publish rev 3: ' + JSON.stringify(pub3));

    const pub4 = await runPublishJobPacketRevision({
      caller: trusted(),
      request: { requestId: 'req-r4', expectedLatestRevision: 3, packetDraft: rev4Draft },
      store,
      publishedAt: '2026-09-26T00:00:00.000Z',
    });
    if (!pub4.ok) throw new Error('Failed to publish rev 4: ' + JSON.stringify(pub4));

    const stored = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 4));
    const validated = validateStoredRevisionForBinding(stored, {
      companyId: COMPANY,
      packageId: 'water-hauling',
      revision: 4,
    });
    if (!validated.ok) throw new Error('Failed to validate envelope for binding: ' + JSON.stringify(validated));
    envelope = validated.envelope;
  });

  it('verifies DRIVER_DISPATCH_CREATE_ALLOWLIST contains the 4 split fields', () => {
    expect(DRIVER_DISPATCH_CREATE_ALLOWLIST).toContain('splitGroupId');
    expect(DRIVER_DISPATCH_CREATE_ALLOWLIST).toContain('splitSequence');
    expect(DRIVER_DISPATCH_CREATE_ALLOWLIST).toContain('splitTotal');
    expect(DRIVER_DISPATCH_CREATE_ALLOWLIST).toContain('bbls');
  });

  it('1. normal driver-created dispatch still works', () => {
    const res = evaluateDriverDispatchBirth({
      dispatchId: 'disp_normal_01',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: null,
      record: {
        wellName: 'Thor 1',
        ndicWellName: 'THOR  1-31-30H',
        jobType: 'pw',
      },
      envelope,
    });

    expect(res.ok).toBe(true);
    if (!res.ok || res.result !== 'create') return;
    expect(res.fields?.wellName).toBe('Thor 1');
    expect(res.fields?.jobTypeId).toBe('pw');
    expect(res.fields?.driverId).toBe(DRIVER);
    expect(res.fields?.companyId).toBe(COMPANY);
    expect(res.fields?.status).toBe('pending');
    expect(res.fields?.packageId).toBe('water-hauling');
    expect(res.fields?.packetRevision).toBe(4);
  });

  it('2. splitGroupId accepted', () => {
    const res = evaluateDriverDispatchBirth({
      dispatchId: 'disp_split_group_01',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: null,
      record: {
        wellName: 'Thor 1',
        ndicWellName: 'THOR  1-31-30H',
        jobType: 'service-work',
        splitGroupId: 'spgroup_abc123',
      },
      envelope,
    });

    expect(res.ok).toBe(true);
    if (!res.ok || res.result !== 'create') return;
    expect(res.fields?.splitGroupId).toBe('spgroup_abc123');
  });

  it('3. splitSequence accepted', () => {
    const res = evaluateDriverDispatchBirth({
      dispatchId: 'disp_split_seq_01',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: null,
      record: {
        wellName: 'Thor 1',
        ndicWellName: 'THOR  1-31-30H',
        jobType: 'service-work',
        splitGroupId: 'spgroup_abc123',
        splitSequence: 2,
      },
      envelope,
    });

    expect(res.ok).toBe(true);
    if (!res.ok || res.result !== 'create') return;
    expect(res.fields?.splitSequence).toBe(2);
  });

  it('4. splitTotal accepted', () => {
    const res = evaluateDriverDispatchBirth({
      dispatchId: 'disp_split_total_01',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: null,
      record: {
        wellName: 'Thor 1',
        ndicWellName: 'THOR  1-31-30H',
        jobType: 'service-work',
        splitGroupId: 'spgroup_abc123',
        splitSequence: 1,
        splitTotal: 3,
      },
      envelope,
    });

    expect(res.ok).toBe(true);
    if (!res.ok || res.result !== 'create') return;
    expect(res.fields?.splitTotal).toBe(3);
  });

  it('5. optional bbls accepted', () => {
    const res = evaluateDriverDispatchBirth({
      dispatchId: 'disp_split_bbls_01',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: null,
      record: {
        wellName: 'Thor 1',
        ndicWellName: 'THOR  1-31-30H',
        jobType: 'service-work',
        splitGroupId: 'spgroup_abc123',
        splitSequence: 3,
        splitTotal: 3,
        bbls: 140,
      },
      envelope,
    });

    expect(res.ok).toBe(true);
    if (!res.ok || res.result !== 'create') return;
    expect(res.fields?.bbls).toBe(140);
    expect(res.fields?.splitGroupId).toBe('spgroup_abc123');
    expect(res.fields?.splitSequence).toBe(3);
    expect(res.fields?.splitTotal).toBe(3);
  });

  it('6. arbitrary unknown extra field still fails closed', () => {
    const res1 = evaluateDriverDispatchBirth({
      dispatchId: 'disp_fail_01',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: null,
      record: {
        wellName: 'Thor 1',
        ndicWellName: 'THOR  1-31-30H',
        jobType: 'pw',
        maliciousField: 'exploit',
      },
      envelope,
    });
    expect(res1.ok).toBe(false);
    expect((res1 as any).reason).toBe('unexpected_field');
    expect((res1 as any).field).toBe('maliciousField');

    const res2 = evaluateDriverDispatchBirth({
      dispatchId: 'disp_fail_02',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: null,
      record: {
        wellName: 'Thor 1',
        ndicWellName: 'THOR  1-31-30H',
        jobType: 'service-work',
        splitGroupId: 'sg_1',
        splitSequence: 1,
        unauthorizedCarrier: 'other-carrier',
      },
      envelope,
    });
    expect(res2.ok).toBe(false);
    expect((res2 as any).reason).toBe('unexpected_field');
    expect((res2 as any).field).toBe('unauthorizedCarrier');
  });

  it('7. driver/company/package/revision authority cannot be overridden by these fields', () => {
    // 7a. Reject record caller authority fields
    const authorityProbes = [
      { companyId: 'other-company' },
      { driverId: 'other-driver' },
      { packageId: 'water-hauling' },
      { packetRevision: 99 },
      { contentHash: 'fake_hash' },
      { policyHash: 'fake_hash' },
      { status: 'in_progress' },
      { packetRef: { packageId: 'water-hauling', revision: 4 } },
    ];

    for (const probe of authorityProbes) {
      const res = evaluateDriverDispatchBirth({
        dispatchId: 'disp_auth_override',
        caller: { driverId: DRIVER, companyId: COMPANY },
        existing: null,
        record: {
          wellName: 'Thor 1',
          ndicWellName: 'THOR  1-31-30H',
          jobType: 'service-work',
          splitGroupId: 'sg_1',
          ...probe,
        },
        envelope,
      });
      expect(res.ok).toBe(false);
    }

    // 7b. Server always authoritative for companyId, driverId, driverHash, status
    const valid = evaluateDriverDispatchBirth({
      dispatchId: 'disp_server_auth',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: null,
      record: {
        wellName: 'Thor 1',
        ndicWellName: 'THOR  1-31-30H',
        jobType: 'service-work',
        splitGroupId: 'sg_1',
        splitSequence: 1,
        splitTotal: 2,
        bbls: 130,
      },
      envelope,
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok || valid.result !== 'create') return;
    expect(valid.fields?.companyId).toBe(COMPANY);
    expect(valid.fields?.driverId).toBe(DRIVER);
    expect(valid.fields?.driverHash).toBe(DRIVER);
    expect(valid.fields?.status).toBe('pending');
    expect(valid.fields?.assignedBy).toBe('driver');
    expect(valid.fields?.source).toBe('driver');
  });

  it('8. packet pinning still runs', () => {
    const res = evaluateDriverDispatchBirth({
      dispatchId: 'disp_pinning_check',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: null,
      record: {
        wellName: 'Thor 1',
        ndicWellName: 'THOR  1-31-30H',
        jobType: 'service-work',
        splitGroupId: 'sg_1',
        splitSequence: 1,
        splitTotal: 2,
        bbls: 120,
      },
      envelope,
    });

    expect(res.ok).toBe(true);
    if (!res.ok || res.result !== 'create' || !res.identity) return;
    expect(res.fields?.packageId).toBe('water-hauling');
    expect(res.fields?.packetRevision).toBe(4);
    expect(res.fields?.contentHash).toBe(envelope.contentHash);
    expect(res.fields?.policyHash).toBe(envelope.policyHash);

    // Identity structure carries exact binding
    expect(res.identity.binding.packageId).toBe('water-hauling');
    expect(res.identity.binding.packetRevision).toBe(4);
    expect(res.identity.binding.contentHash).toBe(envelope.contentHash);
    expect(res.identity.binding.policyHash).toBe(envelope.policyHash);
  });

  it('9. duplicate create remains idempotent', () => {
    const first = evaluateDriverDispatchBirth({
      dispatchId: 'disp_idempotent_01',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: null,
      record: {
        wellName: 'Thor 1',
        ndicWellName: 'THOR  1-31-30H',
        jobType: 'pw',
        splitGroupId: 'sg_idemp',
        splitSequence: 1,
        splitTotal: 2,
        bbls: 135,
      },
      envelope,
    });

    expect(first.ok).toBe(true);
    if (!first.ok || first.result !== 'create' || !first.identity) return;

    // Simulate stored document in Firestore matching the created fields
    const storedDoc = { ...first.fields };

    // Duplicate create with identical identity replay returns already_exists
    const second = evaluateDriverDispatchBirth({
      dispatchId: 'disp_idempotent_01',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: storedDoc,
      record: {
        wellName: 'Thor 1',
        ndicWellName: 'THOR  1-31-30H',
        jobType: 'pw',
        splitGroupId: 'sg_idemp',
        splitSequence: 1,
        splitTotal: 2,
        bbls: 135,
      },
      envelope,
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result).toBe('already_exists');
    expect(second.identity).toEqual(first.identity);

    // Conflicting wellName fails closed with conflict
    const conflicting = evaluateDriverDispatchBirth({
      dispatchId: 'disp_idempotent_01',
      caller: { driverId: DRIVER, companyId: COMPANY },
      existing: storedDoc,
      record: {
        wellName: 'Python',
        jobType: 'pw',
      },
      envelope,
    });
    expect(conflicting.ok).toBe(false);
    expect((conflicting as any).reason).toBe('conflict');
  });
});
