import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { runPublishJobPacketRevision } from '../operational/jobPacketPublish';
import { validateStoredRevisionForBinding, revisionDocId } from '../operational/jobPacketRevisionStore';
import { stampDispatchBinding, verifyDispatchPinsAgainstEnvelope } from '../operational/dispatchPacketPin';

describe('G-018 deterministic contracts bundle & release artifact integrity', () => {
  const rootDir = path.resolve(__dirname, '../../../../');
  const functionsDir = path.resolve(__dirname, '../../../');
  const releaseDir = path.resolve(rootDir, 'release/pw-fieldtest/20260922');

  test('contracts tarball exists in functions/vendor with exact pinned SHA-256', () => {
    const tarballPath = path.join(functionsDir, 'vendor/tester3x-wellbuilt-contracts-0.7.0.tgz');
    expect(fs.existsSync(tarballPath)).toBe(true);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(tarballPath)).digest('hex').toUpperCase();
    expect(hash).toBe('84AC379FFB121CB1BA151CA0B950BA07C30BBCF5881FB92775B5C43EA0348DE3');
  });

  test('functions/package.json pins file:vendor/tester3x-wellbuilt-contracts-0.7.0.tgz', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(functionsDir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@tester3x/wellbuilt-contracts']).toBe('file:vendor/tester3x-wellbuilt-contracts-0.7.0.tgz');
  });

  test('functions/package-lock.json contains zero npm.pkg.github.com references', () => {
    const lock = fs.readFileSync(path.join(functionsDir, 'package-lock.json'), 'utf8');
    expect(lock).not.toContain('npm.pkg.github.com');
    expect(lock).toContain('file:vendor/tester3x-wellbuilt-contracts-0.7.0.tgz');
  });

  test('stale contracts-mirror directory and mirror-contracts tool are absent', () => {
    expect(fs.existsSync(path.join(functionsDir, 'contracts-mirror'))).toBe(false);
    expect(fs.existsSync(path.join(functionsDir, 'tools/mirror-contracts.mjs'))).toBe(false);
  });

  test('all committed release artifacts in release/pw-fieldtest/20260922 match SHA256SUMS.txt', () => {
    const sumsPath = path.join(releaseDir, 'SHA256SUMS.txt');
    expect(fs.existsSync(sumsPath)).toBe(true);
    const lines = fs.readFileSync(sumsPath, 'utf8').trim().split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines.length).toBe(7);
    for (const line of lines) {
      const [expectedHash, filename] = line.split(/\s+/);
      const filePath = path.join(releaseDir, filename);
      expect(fs.existsSync(filePath)).toBe(true);
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
      expect(actualHash).toBe(expectedHash.toUpperCase());
    }
  });

  test('multi-tenant publication proof: contentHash differs by tenant while policyHash is identical', async () => {
    const baseDraft = JSON.parse(fs.readFileSync(path.join(releaseDir, 'pw-base-packet-draft.json'), 'utf8'));

    function createInMemoryStore() {
      const revisions = new Map<string, Record<string, unknown>>();
      const claims = new Map<string, Record<string, unknown>>();
      const heads = new Map<string, Record<string, unknown>>();
      const receipts = new Map<string, Record<string, unknown>>();
      return {
        async getRevision(id: string) { return revisions.get(id) || null; },
        async getClaim(id: string) { return claims.get(id) || null; },
        createRevision(id: string, data: Record<string, unknown>) { revisions.set(id, data); },
        createClaim(id: string, data: Record<string, unknown>) { claims.set(id, data); },
        async getHead(id: string) { return heads.get(id) || null; },
        createHead(id: string, data: Record<string, unknown>) { heads.set(id, data); },
        updateHead(id: string, data: Record<string, unknown>) { heads.set(id, data); },
        async getReceipt(id: string) { return receipts.get(id) || null; },
        createReceipt(id: string, data: Record<string, unknown>) { receipts.set(id, data); },
      };
    }

    async function publishForCompany(companyId: string) {
      const store = createInMemoryStore();
      const caller = { uid: 'staff_' + companyId, companyId, active: true, capabilities: ['manageDrivers'] };
      const pubRes = await runPublishJobPacketRevision({
        caller,
        request: { requestId: 'req_' + companyId, expectedLatestRevision: 0, packetDraft: baseDraft },
        store,
        publishedAt: Date.now(),
      });
      expect(pubRes.ok).toBe(true);
      if (!pubRes.ok) throw new Error('publish failed');

      const docId = revisionDocId(companyId, pubRes.packageId, pubRes.revision);
      const rev = await store.getRevision(docId);
      const validated = validateStoredRevisionForBinding(rev, { companyId, packageId: pubRes.packageId, revision: pubRes.revision });
      expect(validated.ok).toBe(true);
      if (!validated.ok) throw new Error('validation failed');

      const binding = stampDispatchBinding(validated.envelope);
      const dispatchRecord = { ...binding, companyId, jobType: 'pw' };
      const pinVerify = verifyDispatchPinsAgainstEnvelope(dispatchRecord, validated.envelope, companyId);
      expect(pinVerify.ok).toBe(true);

      return { companyId, contentHash: pubRes.contentHash, policyHash: pubRes.policyHash };
    }

    const [alpha, bravo, liquidGold] = await Promise.all([
      publishForCompany('company-alpha'),
      publishForCompany('company-bravo'),
      publishForCompany('liquid-gold'),
    ]);

    expect(alpha.contentHash).not.toBe(bravo.contentHash);
    expect(alpha.contentHash).not.toBe(liquidGold.contentHash);
    expect(bravo.contentHash).not.toBe(liquidGold.contentHash);

    // Liquid gold matches exact independent audit finding
    expect(liquidGold.contentHash).toBe('57cc9790ddf517d43d7343e2952788e25c7916a6eee955e73ec6916175df5287');

    // Canonical empty policy hash
    const CANONICAL_EMPTY_POLICY_HASH = '74d37a6a02553c623cd3a90dbd12eefbc2dccdc8c2f7e5fb9f14e56112b39d5e';
    expect(alpha.policyHash).toBe(CANONICAL_EMPTY_POLICY_HASH);
    expect(bravo.policyHash).toBe(CANONICAL_EMPTY_POLICY_HASH);
    expect(liquidGold.policyHash).toBe(CANONICAL_EMPTY_POLICY_HASH);
  });
});
