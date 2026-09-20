import * as fs from 'fs';
import * as path from 'path';
import { authorizeAdminCall } from '../../../admin/authority';
import {
  CALLER_FORBIDDEN_AUTHORITY_KEYS,
  CLAIM_COLLECTION,
  INDEX_COLLECTION,
  REVISION_COLLECTION,
  SERVER_IMPLEMENTED_EFFECTS,
  claimDocId,
  decidePublishAccess,
  evaluatePlatformAdminRecord,
  persistJobPacketRevision,
  revisionDocId,
  tenantPublishCapsFromRoles,
  validatePublishInput,
  type RevisionStoreTx,
} from '../jobPacketRevisionStore';

const COMPANY = 'liquid-gold';
const OTHER = 'other-hauler';
const PUBLISHER = 'uid-staff-1';
const PLATFORM = 'uid-platform-1';

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

async function publish(
  store: MemoryStore,
  payload: Record<string, unknown>,
  ctx = { companyId: COMPANY, publishedByUid: PUBLISHER },
  publishedAt: unknown = 'ts-1',
) {
  const validated = validatePublishInput(payload, ctx);
  if (!validated.ok) return validated;
  return persistJobPacketRevision(
    store,
    { envelope: validated.envelope, contentHash: validated.contentHash },
    publishedAt,
  );
}

const enabledAdmin = { enabled: true, policyVersion: 1 };
const adminAuth = { uid: PLATFORM, token: { wellbuiltAdmin: true, email: 'admin@wellbuilt' } };

describe('1. first publication creates revision and matching content claim', () => {
  it('creates both documents with matching hash and server fields', async () => {
    const store = new MemoryStore();
    const out = await publish(store, validPayload());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.publication).toBe('created');
    expect(out.revision.companyId).toBe(COMPANY);
    expect(out.revision.status).toBe('published');
    expect(out.revision.hashAlgorithm).toBe('sha256');
    expect(out.revision.schemaVersion).toBe(1);
    expect(out.revision.hashSchemaVersion).toBe(1);
    expect(out.revision.publishedByUid).toBe(PUBLISHER);
    expect(out.revision.implementedEffects).toEqual([]);
    const revId = revisionDocId(COMPANY, 'water-hauling', 1);
    const claimId = claimDocId(COMPANY, 'water-hauling', out.revision.contentHash);
    expect(store.revisions.has(revId)).toBe(true);
    expect(store.claims.has(claimId)).toBe(true);
    expect(store.claims.get(claimId)?.revision).toBe(1);
    expect(store.claims.get(claimId)?.contentHash).toBe(out.revision.contentHash);
  });
});

describe('2. identical retry is idempotent despite publishedAt', () => {
  it('returns existing and keeps the original publishedAt', async () => {
    const store = new MemoryStore();
    const first = await publish(store, validPayload(), undefined, 'ts-1');
    const second = await publish(store, validPayload(), undefined, 'ts-2');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.publication).toBe('existing');
    expect(second.revision.contentHash).toBe(first.revision.contentHash);
    expect(second.revision.publishedAt).toBe('ts-1');
    expect(store.revisions.size).toBe(1);
    expect(store.claims.size).toBe(1);
  });
});

describe('3. same revision with changed material conflicts', () => {
  it('rejects displayVersion mutation of an existing revision', async () => {
    const store = new MemoryStore();
    const first = await publish(store, validPayload());
    expect(first.ok).toBe(true);
    const second = await publish(store, validPayload({ displayVersion: '1.0.1' }));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('immutable_packet_revision');
  });
});

describe('4. same content under another revision conflicts', () => {
  it('rejects a new revision number for identical canonical content', async () => {
    const store = new MemoryStore();
    const first = await publish(store, validPayload());
    expect(first.ok).toBe(true);
    const second = await publish(store, validPayload({ revision: 2 }));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('duplicate_content_revision');
    expect(store.revisions.size).toBe(1);
  });
});

describe('5. missing or inconsistent content claim fails closed', () => {
  it('fails when the revision exists without a claim', async () => {
    const store = new MemoryStore();
    const first = await publish(store, validPayload());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    store.claims.clear();
    const retry = await publish(store, validPayload());
    expect(retry.ok).toBe(false);
    if (retry.ok) return;
    expect(retry.reason).toBe('store_integrity');
  });

  it('fails when a claim exists without its revision', async () => {
    const store = new MemoryStore();
    const first = await publish(store, validPayload());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    store.revisions.clear();
    const retry = await publish(store, validPayload({ revision: 2 }));
    expect(retry.ok).toBe(false);
    if (retry.ok) return;
    expect(retry.reason).toBe('store_integrity');
  });
});

describe('6. tenant cannot be selected or changed by ordinary caller input', () => {
  it('rejects caller companyId as an authority field', () => {
    const result = validatePublishInput(
      validPayload({ companyId: OTHER }),
      { companyId: COMPANY, publishedByUid: PUBLISHER },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('caller_authority_field');
    expect(result.field).toBe('companyId');
  });

  it('stamps the server-resolved company, not a payload target, for tenant publishers', () => {
    const access = decidePublishAccess({
      authUid: PUBLISHER,
      tenantCaller: { companyId: COMPANY, caps: ['manageDrivers'] },
      platformAdminDecision: { ok: false, reason: 'missing_admin_claim' },
      requestedTargetCompanyId: OTHER,
    });
    expect(access.ok).toBe(false);
    if (access.ok) return;
    expect(access.reason).toBe('platform_admin_required');
  });

  it('uses the server tenant company when no target is supplied', () => {
    const access = decidePublishAccess({
      authUid: PUBLISHER,
      tenantCaller: { companyId: COMPANY, caps: ['manageDrivers'] },
      platformAdminDecision: { ok: false, reason: 'missing_admin_claim' },
    });
    expect(access.ok).toBe(true);
    if (!access.ok) return;
    expect(access.companyId).toBe(COMPANY);
    expect(access.via).toBe('tenant');
  });
});

describe('7. cross-company publication requires verified platform authority', () => {
  it('denies unscoped admin/it without dual-source platform_admins + claim', () => {
    const access = decidePublishAccess({
      authUid: PLATFORM,
      tenantCaller: { companyId: null, caps: ['manageDrivers', 'viewAllCompanies'] },
      platformAdminDecision: { ok: false, reason: 'no_admin_record' },
      requestedTargetCompanyId: COMPANY,
    });
    expect(access.ok).toBe(false);
    if (access.ok) return;
    expect(access.reason).toBe('platform_admin_required');
  });

  it('reuses authorizeAdminCall dual-source verification', () => {
    expect(authorizeAdminCall(adminAuth, enabledAdmin).ok).toBe(true);
    expect(evaluatePlatformAdminRecord(adminAuth, null).ok).toBe(false);
    expect(evaluatePlatformAdminRecord({ uid: PLATFORM, token: { wellbuiltAdmin: true } }, {
      enabled: true,
      policyVersion: 1,
    }).ok).toBe(true);
    expect(evaluatePlatformAdminRecord({ uid: PLATFORM, token: { role: 'it' } }, enabledAdmin).ok).toBe(false);
  });

  it('allows cross-company only after verified platform admin + targetCompanyId', () => {
    const access = decidePublishAccess({
      authUid: PLATFORM,
      tenantCaller: { companyId: null, caps: [] },
      platformAdminDecision: authorizeAdminCall(adminAuth, enabledAdmin),
      requestedTargetCompanyId: COMPANY,
    });
    expect(access.ok).toBe(true);
    if (!access.ok) return;
    expect(access.via).toBe('platform_admin');
    expect(access.companyId).toBe(COMPANY);
  });
});

describe('8. caller authority fields are rejected', () => {
  it.each([...CALLER_FORBIDDEN_AUTHORITY_KEYS])('rejects %s', (key) => {
    const result = validatePublishInput(
      validPayload({ [key]: key === 'implementedEffects' ? ['lifecycle'] : 'injected' }),
      { companyId: COMPANY, publishedByUid: PUBLISHER },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('caller_authority_field');
    expect(result.field).toBe(key);
  });
});

describe('9. unknown and reserved capabilities fail closed', () => {
  it('rejects unknown capability ids', () => {
    const result = validatePublishInput(
      validPayload({
        capabilities: [{ capabilityId: 'teleport', moduleVersion: 1, configuration: {} }],
      }),
      { companyId: COMPANY, publishedByUid: PUBLISHER },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_capability');
  });

  it('rejects reserved capability ids', () => {
    const result = validatePublishInput(
      validPayload({
        capabilities: [{ capabilityId: 'jsa', moduleVersion: 1, configuration: {} }],
      }),
      { companyId: COMPANY, publishedByUid: PUBLISHER },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('reserved_capability');
  });
});

describe('10. jobType grants cannot exceed packet grants', () => {
  it('rejects a job type capability that is not in the packet grant set', () => {
    const result = validatePublishInput(
      validPayload({
        capabilities: [{ capabilityId: 'lifecycle', moduleVersion: 1, configuration: {} }],
        jobTypes: [
          { jobTypeId: 'pw', label: 'Production Water', capabilities: ['lifecycle', 'pickup'] },
        ],
      }),
      { companyId: COMPANY, publishedByUid: PUBLISHER },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ungranted_job_type_capability');
  });
});

describe('11. implementedEffects are server-derived', () => {
  it('stores the server inventory, not packet grants', async () => {
    const store = new MemoryStore();
    const out = await publish(store, validPayload());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.revision.implementedEffects).toEqual([...SERVER_IMPLEMENTED_EFFECTS]);
    expect(out.revision.implementedEffects).not.toContain('pickup');
    expect(out.revision.capabilities.map((g) => g.capabilityId)).toContain('pickup');
  });
});

describe('12. malformed, accessor-bearing, inherited, oversized, or deep inputs fail closed', () => {
  it('rejects getters without invoking them', () => {
    let invoked = false;
    const payload = validPayload();
    Object.defineProperty(payload, 'displayVersion', {
      enumerable: true,
      get() {
        invoked = true;
        return 'gotcha';
      },
    });
    const result = validatePublishInput(payload, { companyId: COMPANY, publishedByUid: PUBLISHER });
    expect(invoked).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('accessor_forbidden');
  });

  it('rejects inherited properties', () => {
    const proto = { packageId: 'inherited-pkg' };
    const payload = Object.assign(Object.create(proto), validPayload());
    delete (payload as { packageId?: string }).packageId;
    const result = validatePublishInput(payload, { companyId: COMPANY, publishedByUid: PUBLISHER });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('inherited_property');
  });

  it('rejects oversized strings before persistence', () => {
    const result = validatePublishInput(
      validPayload({
        definition: {
          schemaVersion: 1,
          packetId: 'water-hauling',
          industryId: 'oil-gas',
          segmentId: 'produced-water',
          label: 'x'.repeat(4097),
        },
      }),
      { companyId: COMPANY, publishedByUid: PUBLISHER },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('string_too_long');
  });

  it('rejects excessive depth', () => {
    let deep: Record<string, unknown> = { n: 0 };
    for (let i = 0; i < 20; i++) deep = { n: deep };
    const result = validatePublishInput(
      validPayload({ extra: deep }),
      { companyId: COMPANY, publishedByUid: PUBLISHER },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('excessive_depth');
  });

  it('rejects unknown top-level fields', () => {
    const result = validatePublishInput(
      validPayload({ latest: true }),
      { companyId: COMPANY, publishedByUid: PUBLISHER },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_field');
  });
});

describe('13. supersedes must resolve exactly', () => {
  it('accepts an advancing pointer to the exact prior revision', async () => {
    const store = new MemoryStore();
    const first = await publish(store, validPayload());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await publish(store, validPayload({
      revision: 2,
      displayVersion: '1.1.0',
      definition: {
        schemaVersion: 1,
        packetId: 'water-hauling',
        industryId: 'oil-gas',
        segmentId: 'produced-water',
        label: 'Water Hauling v2',
      },
      supersedes: {
        packageId: 'water-hauling',
        revision: 1,
        contentHash: first.revision.contentHash,
      },
    }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.publication).toBe('created');
    expect(second.revision.supersedes?.revision).toBe(1);
  });

  it('rejects a missing prior revision', async () => {
    const store = new MemoryStore();
    const out = await publish(store, validPayload({
      revision: 2,
      supersedes: {
        packageId: 'water-hauling',
        revision: 1,
        contentHash: 'a'.repeat(64),
      },
    }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('supersedes_not_found');
  });

  it('rejects a hash mismatch on the prior revision', async () => {
    const store = new MemoryStore();
    const first = await publish(store, validPayload());
    expect(first.ok).toBe(true);
    const out = await publish(store, validPayload({
      revision: 2,
      displayVersion: '1.1.0',
      supersedes: {
        packageId: 'water-hauling',
        revision: 1,
        contentHash: 'b'.repeat(64),
      },
    }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('supersedes_mismatch');
  });

  it('rejects a non-advancing supersedes pointer at validation', () => {
    const result = validatePublishInput(
      validPayload({
        revision: 1,
        supersedes: {
          packageId: 'water-hauling',
          revision: 1,
          contentHash: 'a'.repeat(64),
        },
      }),
      { companyId: COMPANY, publishedByUid: PUBLISHER },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('supersedes_not_advancing');
  });
});

describe('14. no getLatest, fallback, overwrite, update, delete, or repair path', () => {
  it('keeps the store create-only in source', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'jobPacketRevisionStore.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/\bgetLatest\s*\(/);
    expect(src).not.toMatch(/\btx\.update\b/);
    expect(src).not.toMatch(/\btx\.set\b/);
    expect(src).not.toMatch(/\btx\.delete\b/);
    expect(src).not.toMatch(/merge\s*:/);
    expect(src).toMatch(/createRevision/);
    expect(src).toMatch(/createClaim/);
    const callable = fs.readFileSync(
      path.join(__dirname, '..', '..', 'jobPacketRevisionPublishCallable.ts'),
      'utf8',
    );
    expect(callable).not.toMatch(/\bgetLatest\s*\(/);
    expect(callable).toMatch(/\.create\s*\(/);
    expect(callable).not.toMatch(/\.(set|update|delete)\s*\(/);
  });

  it('does not repair a missing claim', async () => {
    const store = new MemoryStore();
    const first = await publish(store, validPayload());
    expect(first.ok).toBe(true);
    store.claims.clear();
    const retry = await publish(store, validPayload());
    expect(retry.ok).toBe(false);
    expect(store.claims.size).toBe(0);
  });
});

describe('15. staffWriteDispatch surface remains the dispatch writer', () => {
  it('does not import or wrap staffWriteDispatch', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'jobPacketRevisionStore.ts'),
      'utf8',
    );
    const callable = fs.readFileSync(
      path.join(__dirname, '..', '..', 'jobPacketRevisionPublishCallable.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/staffWriteDispatch/);
    expect(callable).not.toMatch(/staffWriteDispatch/);
    expect(callable).not.toMatch(/upsertDriverDispatch/);
  });
});

describe('16. firestore rules deny all client access to the dormant collections', () => {
  it('pins explicit deny matches for the three collections and keeps the catch-all', () => {
    const rules = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', '..', 'firestore.rules'),
      'utf8',
    );
    expect(rules).toMatch(
      /match \/job_packet_revisions\/\{revisionId\} \{\s*allow read, write: if false;/,
    );
    expect(rules).toMatch(
      /match \/job_packet_content_claims\/\{claimId\} \{\s*allow read, write: if false;/,
    );
    expect(rules).toMatch(
      /match \/job_packet_package_index\/\{packageId\} \{\s*allow read, write: if false;/,
    );
    expect(rules).toMatch(/match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
    expect(rules).toContain(REVISION_COLLECTION);
    expect(rules).toContain(CLAIM_COLLECTION);
    expect(rules).toContain(INDEX_COLLECTION);
  });
});

describe('caps are not minted from token booleans', () => {
  it('uses role tables only', () => {
    expect(tenantPublishCapsFromRoles(['viewer'], {})).toEqual([]);
    expect(tenantPublishCapsFromRoles(['admin'], {})).toEqual(
      expect.arrayContaining(['manageDrivers']),
    );
  });
});
