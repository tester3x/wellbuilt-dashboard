import * as fs from 'fs';
import * as path from 'path';
import {
  CALLER_FORBIDDEN_AUTHORITY_KEYS,
  CLAIM_COLLECTION,
  FIRESTORE_MAX_DOCUMENT_ID_BYTES,
  INDEX_COLLECTION,
  REVISION_COLLECTION,
  SERVER_IMPLEMENTED_EFFECTS,
  claimDocId,
  persistJobPacketRevision,
  revisionDocId,
  validatePublishInput,
  type RevisionStoreTx,
} from '../jobPacketRevisionStore';

const COMPANY = 'liquid-gold';
const OTHER = 'other-hauler';
const PUBLISHER = 'uid-staff-1';

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

  it('stamps only the server-provided ctx.companyId onto the envelope', () => {
    const result = validatePublishInput(validPayload(), {
      companyId: COMPANY,
      publishedByUid: PUBLISHER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.companyId).toBe(COMPANY);
    expect(result.envelope.publishedByUid).toBe(PUBLISHER);
  });
});

describe('7. no live packet-publication endpoint', () => {
  it('does not treat manageDrivers as a publication authority in this checkpoint', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'jobPacketRevisionStore.ts'), 'utf8');
    expect(src).not.toMatch(/manageDrivers/);
    expect(src).not.toMatch(/decidePublishAccess/);
    expect(src).not.toMatch(/httpsV2\.onCall/);
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
    expect(fs.existsSync(path.join(__dirname, '..', '..', 'jobPacketRevisionPublishCallable.ts'))).toBe(false);
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
    expect(src).not.toMatch(/staffWriteDispatch/);
    expect(src).not.toMatch(/upsertDriverDispatch/);
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

describe('document IDs are length-prefixed and injective', () => {
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);

  it('separates prior __ collision pairs', () => {
    expect(revisionDocId('a_', 'b', 1)).not.toBe(revisionDocId('a', '_b', 1));
    expect(revisionDocId('a__', 'b', 1)).not.toBe(revisionDocId('a', '__b', 1));
    expect(revisionDocId('a-b', 'c', 1)).not.toBe(revisionDocId('a', 'b-c', 1));
    expect(claimDocId('a_', 'b', hashA)).not.toBe(claimDocId('a', '_b', hashA));
    expect(claimDocId('a__', 'b', hashA)).not.toBe(claimDocId('a', '__b', hashA));
    expect(claimDocId('a-b', 'c', hashA)).not.toBe(claimDocId('a', 'b-c', hashA));
  });

  it('distinguishes remaining component-boundary permutations of the old __ format', () => {
    const pairs: Array<[string, string]> = [
      ['a_', 'b'], ['a', '_b'], ['a__', 'b'], ['a', '__b'],
      ['a___', 'b'], ['a', '___b'], ['_a', 'b'], ['a', 'b_'],
      ['a-b', 'c'], ['a', 'b-c'], ['a-b', 'c-d'],
    ];
    const revIds = pairs.map(([c, p]) => revisionDocId(c, p, 1));
    expect(new Set(revIds).size).toBe(revIds.length);
    const claimIds = pairs.map(([c, p]) => claimDocId(c, p, hashA));
    expect(new Set(claimIds).size).toBe(claimIds.length);
  });

  it('distinguishes revision digit lengths and content hashes', () => {
    expect(revisionDocId('a', 'b', 1)).not.toBe(revisionDocId('a', 'b', 10));
    expect(revisionDocId('a', 'b', 10)).not.toBe(revisionDocId('a', 'b', 100));
    expect(claimDocId('a', 'b', hashA)).not.toBe(claimDocId('a', 'b', hashB));
  });

  it('encodes maximum-length identifiers under the Firestore ID limit', () => {
    const company = 'C'.repeat(64);
    const pkg = 'P'.repeat(64);
    const revId = revisionDocId(company, pkg, Number.MAX_SAFE_INTEGER);
    const claimId = claimDocId(company, pkg, hashA);
    for (const id of [revId, claimId]) {
      expect(id.includes('/')).toBe(false);
      expect(id).not.toBe('.');
      expect(id).not.toBe('..');
      expect(Buffer.byteLength(id, 'utf8')).toBeLessThanOrEqual(FIRESTORE_MAX_DOCUMENT_ID_BYTES);
    }
  });

  it('is deterministic', () => {
    expect(revisionDocId('liquid-gold', 'water-hauling', 1)).toBe(
      revisionDocId('liquid-gold', 'water-hauling', 1),
    );
    expect(claimDocId('liquid-gold', 'water-hauling', hashA)).toBe(
      claimDocId('liquid-gold', 'water-hauling', hashA),
    );
  });
});

function compiledExportNames(filePath: string): string[] {
  const src = fs.readFileSync(filePath, 'utf8');
  const names = new Set<string>();
  for (const match of src.matchAll(/exports\.([A-Za-z0-9_]+)\s*=/g)) {
    names.add(match[1]);
  }
  for (const match of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name.replace(/[^\w]/g, ''));
    }
  }
  return [...names];
}

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('root export surface has no packet-revision publisher', () => {
  const functionsRoot = path.join(__dirname, '..', '..', '..', '..');
  const srcIndex = path.join(functionsRoot, 'src', 'index.ts');
  const securityIndex = path.join(functionsRoot, 'src', 'security', 'index.ts');
  const libIndex = path.join(functionsRoot, 'lib', 'index.js');
  const libSecurity = path.join(functionsRoot, 'lib', 'security', 'index.js');

  it('does not export publishJobPacketRevision from TypeScript entrypoints', () => {
    const rootNames = compiledExportNames(srcIndex);
    const securityNames = compiledExportNames(securityIndex);
    expect(rootNames).not.toContain('publishJobPacketRevision');
    expect(securityNames).not.toContain('publishJobPacketRevision');
    expect(fs.existsSync(path.join(functionsRoot, 'src', 'security', 'jobPacketRevisionPublishCallable.ts'))).toBe(false);
    expect(fs.readFileSync(srcIndex, 'utf8')).not.toMatch(/\bpublishJobPacketRevision\b/);
    expect(fs.readFileSync(securityIndex, 'utf8')).not.toMatch(/\bpublishJobPacketRevision\b/);
  });

  it('does not register publishJobPacketRevision in compiled output', () => {
    expect(fs.existsSync(libIndex)).toBe(true);
    expect(fs.existsSync(libSecurity)).toBe(true);
    const rootJs = fs.readFileSync(libIndex, 'utf8');
    const securityJs = fs.readFileSync(libSecurity, 'utf8');
    expect(rootJs).not.toMatch(/\bpublishJobPacketRevision\b/);
    expect(securityJs).not.toMatch(/\bpublishJobPacketRevision\b/);
    expect(compiledExportNames(libIndex)).not.toContain('publishJobPacketRevision');
    expect(compiledExportNames(libSecurity)).not.toContain('publishJobPacketRevision');
    expect(rootJs).not.toMatch(/onCall\([^)]*publishJobPacketRevision/);
  });

  it('has no live callable importing the store and no app consumer of the new collections', () => {
    const storeFile = path.normalize(path.join(__dirname, '..', 'jobPacketRevisionStore.ts'));
    const testFile = path.normalize(__filename);
    const functionsSrc = path.join(functionsRoot, 'src');
    const dashboardSrc = path.join(functionsRoot, '..', 'src');
    const hits: string[] = [];
    for (const file of [...walkFiles(functionsSrc), ...walkFiles(dashboardSrc)]) {
      const norm = path.normalize(file);
      if (norm === storeFile || norm === testFile) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (
        text.includes('job_packet_revisions')
        || text.includes('job_packet_content_claims')
        || text.includes('persistJobPacketRevision')
        || text.includes('publishJobPacketRevision')
      ) {
        hits.push(path.relative(functionsRoot, file));
      }
    }
    expect(hits).toEqual([]);
  });
});
