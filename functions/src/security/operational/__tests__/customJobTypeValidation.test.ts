import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolveCanonicalJobType,
  verifyDispatchPinsAgainstEnvelope,
  stampDispatchBinding,
  ALLOWED_CUSTOM_FAMILIES,
} from '../dispatchPacketPin';
import {
  validateStoredRevisionForBinding,
  revisionDocId,
  type ImmutableRevisionEnvelope,
} from '../jobPacketRevisionStore';
import {
  runPublishJobPacketRevision,
  type PublishStoreTx,
} from '../jobPacketPublish';
import { runResolveExecutionBinding } from '../resolveExecutionBinding';
import type { TrustedCompanyAuthority } from '../../trustedStaffAuthority';

const COMPANY = 'liquid-gold';
const OTHER_COMPANY = 'other-carrier';
const PUBLISHER = 'uid-staff-1';
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';

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

function trusted(): TrustedCompanyAuthority {
  return { uid: PUBLISHER, companyId: COMPANY };
}

describe('Governed Custom Job Type v2 Validation and Binding', () => {
  let envelope: ImmutableRevisionEnvelope;
  let rev4Doc: Record<string, unknown>;

  beforeAll(async () => {
    const rev1Draft = JSON.parse(readFileSync(join(__dirname, '../../../../../release/pw-fieldtest/20260922/pw-base-packet-draft.json'), 'utf8'));
    const rev2Draft = JSON.parse(readFileSync(join(__dirname, '../../../../../release/pw-fieldtest/pw-revision-2-full-publish.json'), 'utf8'));
    const rev3Draft = JSON.parse(readFileSync(join(__dirname, '../../../../../release/pw-fieldtest/pw-revision-3-full-publish.json'), 'utf8'));
    const rev4Draft = JSON.parse(readFileSync(join(__dirname, '../../../../../release/pw-fieldtest/pw-revision-4-full-publish.json'), 'utf8'));

    const store = new MemoryPublishStore();
    await runPublishJobPacketRevision({ caller: trusted(), request: { requestId: 'r1', expectedLatestRevision: 0, packetDraft: rev1Draft }, store, publishedAt: '2026-09-22T00:00:00.000Z' });
    await runPublishJobPacketRevision({ caller: trusted(), request: { requestId: 'r2', expectedLatestRevision: 1, packetDraft: rev2Draft }, store, publishedAt: '2026-09-25T00:00:00.000Z' });
    await runPublishJobPacketRevision({ caller: trusted(), request: { requestId: 'r3', expectedLatestRevision: 2, packetDraft: rev3Draft }, store, publishedAt: '2026-09-25T12:00:00.000Z' });
    const pub4 = await runPublishJobPacketRevision({ caller: trusted(), request: { requestId: 'r4', expectedLatestRevision: 3, packetDraft: rev4Draft }, store, publishedAt: '2026-09-26T00:00:00.000Z' });
    if (!pub4.ok) throw new Error('Publish rev 4 failed');

    const stored = await store.getRevision(revisionDocId(COMPANY, 'water-hauling', 4));
    rev4Doc = stored!;
    const validated = validateStoredRevisionForBinding(stored, { companyId: COMPANY, packageId: 'water-hauling', revision: 4 });
    if (!validated.ok) throw new Error('Validation failed');
    envelope = validated.envelope;
  });

  it('1. ALLOWED_CUSTOM_FAMILIES is limited strictly to pw and service-work', () => {
    expect(ALLOWED_CUSTOM_FAMILIES).toEqual(['pw', 'service-work']);
  });

  it('2. custom type resolves with allowed base family (pw)', () => {
    const customTypes = [
      {
        id: 'dedicated-water',
        label: 'Dedicated Water',
        baseJobTypeId: 'pw',
        payBasis: 'per_bbl',
        lifecycleShape: 'pickup_dropoff',
      },
    ];

    const res = resolveCanonicalJobType('dedicated-water', envelope.jobTypes, customTypes);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.jobTypeId).toBe('dedicated-water');
    expect(res.baseJobTypeId).toBe('pw');
    expect(res.isCustom).toBe(true);
    expect(res.payBasis).toBe('per_bbl');
    expect(res.lifecycleShape).toBe('pickup_dropoff');
    expect(res.capabilities).toEqual(['lifecycle', 'pickup']);
  });

  it('3. custom type resolves with allowed base family (service-work)', () => {
    const customTypes = [
      {
        id: 'ground-water',
        label: 'Ground Water',
        baseJobTypeId: 'service-work',
        payBasis: 'hourly',
        lifecycleShape: 'pickup_dropoff',
      },
    ];

    const res = resolveCanonicalJobType('ground-water', envelope.jobTypes, customTypes);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.jobTypeId).toBe('ground-water');
    expect(res.baseJobTypeId).toBe('service-work');
    expect(res.isCustom).toBe(true);
    expect(res.payBasis).toBe('hourly');
    expect(res.lifecycleShape).toBe('pickup_dropoff');
  });

  it('4. custom type fails closed when baseJobTypeId is not an allowed governed family', () => {
    const forbiddenFamilies = ['fresh-water', 'flowback-water', 'frac-water', 'arbitrary-family'];

    for (const fam of forbiddenFamilies) {
      const customTypes = [
        {
          id: 'custom-type',
          label: 'Custom Type',
          baseJobTypeId: fam,
          payBasis: 'hourly',
          lifecycleShape: 'pickup_dropoff',
        },
      ];
      const res = resolveCanonicalJobType('custom-type', envelope.jobTypes, customTypes);
      expect(res.ok).toBe(false);
      expect((res as any).reason).toBe('unknown_job_type');
      expect((res as any).field).toBe('baseJobTypeId');
    }
  });

  it('5. custom type cannot impersonate a built-in canonical ID', () => {
    const customImpersonator = [
      {
        id: 'pw', // attempting to override built-in 'pw'
        label: 'Fake PW',
        baseJobTypeId: 'service-work',
        payBasis: 'hourly',
      },
    ];

    // Built-ins always resolve to the canonical package definition with isCustom: false
    const res = resolveCanonicalJobType('pw', envelope.jobTypes, customImpersonator);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.isCustom).toBe(false);
    expect(res.baseJobTypeId).toBe('pw');
  });

  it('6. lifecycleShape sets conservative default capabilities', () => {
    // 6a. pickup_dropoff -> ['lifecycle', 'pickup'] (no multiHaul, no splitTicket)
    const customPickup = [
      {
        id: 'custom-haul',
        label: 'Custom Haul',
        baseJobTypeId: 'service-work',
        payBasis: 'per_bbl',
        lifecycleShape: 'pickup_dropoff',
      },
    ];
    const res1 = resolveCanonicalJobType('custom-haul', envelope.jobTypes, customPickup);
    expect(res1.ok).toBe(true);
    if (!res1.ok) return;
    expect(res1.capabilities).toEqual(['lifecycle', 'pickup']);
    expect(res1.capabilities).not.toContain('multiHaul');
    expect(res1.capabilities).not.toContain('splitTicket');

    // 6b. onsite_only -> ['lifecycle']
    const customOnsite = [
      {
        id: 'tank-transfer',
        label: 'Tank Transfer',
        baseJobTypeId: 'service-work',
        payBasis: 'hourly',
        lifecycleShape: 'onsite_only',
      },
    ];
    const res2 = resolveCanonicalJobType('tank-transfer', envelope.jobTypes, customOnsite);
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.capabilities).toEqual(['lifecycle']);
    expect(res2.capabilities).not.toContain('pickup');
  });

  it('7. label-only attempt fails closed with job_type_label_only', () => {
    const customTypes = [
      {
        id: 'ground-water',
        label: 'Ground Water',
        baseJobTypeId: 'service-work',
        payBasis: 'per_bbl',
        lifecycleShape: 'pickup_dropoff',
      },
    ];

    const res = resolveCanonicalJobType('Ground Water', envelope.jobTypes, customTypes);
    expect(res.ok).toBe(false);
    expect((res as any).reason).toBe('job_type_label_only');
  });

  it('8. company scoping: another company cannot use Liquid Gold custom types', () => {
    const liquidGoldCustomTypes = [
      {
        id: 'ground-water',
        label: 'Ground Water',
        baseJobTypeId: 'service-work',
        payBasis: 'per_bbl',
        lifecycleShape: 'pickup_dropoff',
      },
    ];

    // For Liquid Gold: succeeds
    const lgRes = resolveCanonicalJobType('ground-water', envelope.jobTypes, liquidGoldCustomTypes);
    expect(lgRes.ok).toBe(true);

    // For Other Carrier (which has no custom types configured): fails closed
    const otherRes = resolveCanonicalJobType('ground-water', envelope.jobTypes, []);
    expect(otherRes.ok).toBe(false);
    expect((otherRes as any).reason).toBe('unknown_job_type');
  });

  it('9. verifyDispatchPinsAgainstEnvelope passes for valid custom job type', () => {
    const customTypes = [
      {
        id: 'ground-water',
        label: 'Ground Water',
        baseJobTypeId: 'service-work',
        payBasis: 'per_bbl',
        lifecycleShape: 'pickup_dropoff',
        capabilities: ['lifecycle', 'pickup'],
      },
    ];

    const dispatchDoc = {
      companyId: COMPANY,
      driverId: DRIVER,
      jobTypeId: 'ground-water',
      serviceType: 'Ground Water',
      wellName: 'Thor 1',
      ndicWellName: 'THOR  1-31-30H',
      status: 'pending',
      ...stampDispatchBinding(envelope),
    };

    const pins = verifyDispatchPinsAgainstEnvelope(dispatchDoc, envelope, COMPANY, customTypes);
    expect(pins.ok).toBe(true);
    if (!pins.ok) return;
    expect(pins.resolvedJobType.jobTypeId).toBe('ground-water');
    expect(pins.resolvedJobType.baseJobTypeId).toBe('service-work');
    expect(pins.resolvedJobType.payBasis).toBe('per_bbl');
    expect(pins.resolvedJobType.isCustom).toBe(true);
  });

  it('10. resolveExecutionBinding forwards payBasis and lifecycleShape on execution definition', async () => {
    const customTypes = [
      {
        id: 'ground-water',
        label: 'Ground Water',
        baseJobTypeId: 'service-work',
        payBasis: 'per_bbl',
        lifecycleShape: 'pickup_dropoff',
        capabilities: ['lifecycle', 'pickup'],
      },
    ];

    const binding = stampDispatchBinding(envelope);
    const existingJob = {
      companyId: COMPANY,
      driverId: DRIVER,
      jobTypeId: 'ground-water',
      serviceType: 'Ground Water',
      wellName: 'Thor 1',
      ndicWellName: 'THOR  1-31-30H',
      status: 'accepted',
      ...binding,
    };

    const execRes = await runResolveExecutionBinding({
      jobId: 'job_gw_01',
      caller: { companyId: COMPANY, driverId: DRIVER },
      getDispatch: async () => existingJob,
      getRevision: async () => ({ exists: true, data: rev4Doc }),
      getCompany: async (id: string) => (id === COMPANY ? { customJobTypes: customTypes } : null),
    });

    expect(execRes.ok).toBe(true);
    if (!execRes.ok) return;

    const gwEntry = (execRes.definition.jobTypes as any[]).find((jt) => jt.jobTypeId === 'ground-water');
    expect(gwEntry).toBeDefined();
    expect(gwEntry.label).toBe('Ground Water');
    expect(gwEntry.payBasis).toBe('per_bbl');
    expect(gwEntry.lifecycleShape).toBe('pickup_dropoff');
    expect(gwEntry.capabilities).toEqual(['lifecycle', 'pickup']);
  });
});
