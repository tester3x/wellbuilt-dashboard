import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildGovernedPackageProfile,
  revisionDocIdFromIndex,
} from '../governedProfileCore';

const functionsRoot = join(__dirname, '../../../..');
const read = (rel: string) => readFileSync(join(functionsRoot, rel), 'utf8');

// Mirrors the live Rev 3 shape (job_packet_revisions/…water-hauling.1.3).
const INDEX = {
  companyId: 'liquid-gold',
  packageId: 'water-hauling',
  schemaVersion: 1,
  latestRevision: 3,
  contentHash: '3e6cb8d8_content',
  policyHash: 'e8517a85_policy',
};
// Live published revisions carry capabilities as plain capability-id STRINGS
// (confirmed on Rev 3 and Rev 4). The extractor must read this shape.
const REV3 = {
  status: 'published',
  companyId: 'liquid-gold',
  revision: 3,
  jobTypes: [
    { jobTypeId: 'pw', label: 'Production Water', capabilities: ['lifecycle', 'pickup', 'multiHaul'] },
    { jobTypeId: 'service-work', label: 'Service Work', capabilities: ['lifecycle', 'pickup', 'multiHaul', 'splitTicket'] },
    { jobTypeId: 'fresh-water', label: 'Fresh Water', capabilities: ['lifecycle', 'pickup'] },
  ],
};
const base = { companyId: 'liquid-gold', indexDocId: '11.liquid-gold.13.water-hauling', indexData: INDEX };

describe('revisionDocIdFromIndex', () => {
  it('reconstructs <indexId>.<schemaVersion>.<latestRevision>', () => {
    expect(revisionDocIdFromIndex('11.liquid-gold.13.water-hauling', INDEX)).toBe('11.liquid-gold.13.water-hauling.1.3');
  });
  it('fails closed on missing revision fields', () => {
    expect(revisionDocIdFromIndex('x', { schemaVersion: 1 })).toBeNull();
    expect(revisionDocIdFromIndex('', INDEX)).toBeNull();
  });
});

describe('buildGovernedPackageProfile — current published revision', () => {
  const p = buildGovernedPackageProfile({ ...base, revisionData: REV3 })!;
  it('returns the current published revision profile with identity', () => {
    expect(p).toBeTruthy();
    expect(p.packageId).toBe('water-hauling');
    expect(p.packetRevision).toBe(3);
    expect(p.contentHash).toBe('3e6cb8d8_content');
    expect(p.policyHash).toBe('e8517a85_policy');
  });
  it('returns canonical job types', () => {
    expect(p.jobTypes.map((j) => j.jobTypeId)).toEqual(['pw', 'service-work', 'fresh-water']);
    expect(p.jobTypes.find((j) => j.jobTypeId === 'service-work')!.label).toBe('Service Work');
  });
  it('per-job-type capability filtering: service-work grants splitTicket, pw does not', () => {
    const sw = p.jobTypes.find((j) => j.jobTypeId === 'service-work')!;
    const pw = p.jobTypes.find((j) => j.jobTypeId === 'pw')!;
    expect(sw.capabilities).toEqual(['lifecycle', 'pickup', 'multiHaul', 'splitTicket']);
    expect(sw.capabilities).toContain('splitTicket');
    expect(pw.capabilities).not.toContain('splitTicket');
  });
  it('no lifecycleProfile surfaced (schema does not publish it yet)', () => {
    expect(p.jobTypes.every((j) => j.lifecycleProfile === undefined)).toBe(true);
  });
  it('also accepts the { capabilityId } object form defensively (either revision shape)', () => {
    const mapForm = {
      ...REV3,
      jobTypes: [{ jobTypeId: 'service-work', label: 'Service Work', capabilities: [{ capabilityId: 'lifecycle' }, { capabilityId: 'splitTicket' }] }],
    };
    const mp = buildGovernedPackageProfile({ ...base, revisionData: mapForm })!;
    expect(mp.jobTypes[0].capabilities).toEqual(['lifecycle', 'splitTicket']);
  });
});

describe('buildGovernedPackageProfile — fail closed', () => {
  it('unpublished revision not exposed', () => {
    expect(buildGovernedPackageProfile({ ...base, revisionData: { ...REV3, status: 'draft' } })).toBeNull();
  });
  it('cross-tenant revision rejected', () => {
    expect(buildGovernedPackageProfile({ ...base, revisionData: { ...REV3, companyId: 'other-co' } })).toBeNull();
    expect(buildGovernedPackageProfile({ companyId: 'other-co', indexDocId: base.indexDocId, indexData: INDEX, revisionData: REV3 })).toBeNull();
  });
  it('index/revision current-revision mismatch rejected', () => {
    expect(buildGovernedPackageProfile({ ...base, revisionData: { ...REV3, revision: 2 } })).toBeNull();
  });
  it('missing hashes rejected', () => {
    expect(buildGovernedPackageProfile({ ...base, indexData: { ...INDEX, contentHash: '' }, revisionData: REV3 })).toBeNull();
  });
  it('empty/malformed jobTypes rejected', () => {
    expect(buildGovernedPackageProfile({ ...base, revisionData: { ...REV3, jobTypes: [] } })).toBeNull();
    expect(buildGovernedPackageProfile({ ...base, revisionData: { ...REV3, jobTypes: 'nope' } })).toBeNull();
  });
  it('null inputs fail closed', () => {
    expect(buildGovernedPackageProfile({ companyId: '', indexDocId: 'x', indexData: INDEX, revisionData: REV3 })).toBeNull();
    expect(buildGovernedPackageProfile({ ...base, revisionData: null })).toBeNull();
  });
});

describe('getDriverReferenceBundle wiring (source contract)', () => {
  const src = read('src/security/operational/referenceData.ts');
  it('resolves company from trusted identity (not client), queries index scoped by companyId', () => {
    expect(src).toMatch(/requireSecureDriver\(request/);
    expect(src).toMatch(/job_packet_package_index'\)\s*\.where\('companyId', '==', driver\.companyId\)/);
  });
  it('reads published revision via reconstructed id + pure builder, returns governedPackageProfiles', () => {
    expect(src).toMatch(/revisionDocIdFromIndex\(idx\.id, indexData\)/);
    expect(src).toMatch(/job_packet_revisions'\)\.doc\(revId\)/);
    expect(src).toMatch(/buildGovernedPackageProfile\(/);
    expect(src).toMatch(/governedPackageProfiles,/);
  });
  it('does not read job_packet_revisions without company scope / does not mutate', () => {
    expect(src).not.toMatch(/\.set\(|\.update\(|\.add\(|\.delete\(/);
  });
});
