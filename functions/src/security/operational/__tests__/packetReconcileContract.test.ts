import { readFileSync } from 'fs';
import { join } from 'path';
import { canonicalIngestStorageKey, decideProcessedPullReconcile, sameIngestOwner, selectProcessedPullParent } from '../packetReconcileCore';

const functionsRoot = join(__dirname, '../../../..');
const read = (rel: string) => readFileSync(join(functionsRoot, rel), 'utf8');

// Identity used by both the local (client) payload and the processed record.
const ident = {
  wellName: 'AddedTest',
  dateTimeUTC: '2026-09-25T19:51:49.000Z',
  bblsTaken: 100,
  tankLevelFeet: 13,
};
const rec = (over: Record<string, unknown> = {}) => ({
  ...ident,
  companyId: 'liquid-gold',
  driverId: '99ff4b35-51ab-4d45-8d54-18b3b8515c9b',
  ...over,
});
const base = {
  canonicalPacketId: '20260925_195149_AddedTest_fq3sxo',
  driverId: '99ff4b35-51ab-4d45-8d54-18b3b8515c9b',
  companyId: 'liquid-gold',
  localIdentity: ident as Record<string, unknown>,
};

describe('decideProcessedPullReconcile — server reconcile backstop', () => {
  it('matches a successfully-ingested canonical packet at the exact path', () => {
    const d = decideProcessedPullReconcile({ ...base, exact: rec(), legacyIdem: null });
    expect(d).toEqual({ match: true, location: 'exact', canonicalPacketId: base.canonicalPacketId });
  });

  it('matches at the legacy idem_ path when only that exists', () => {
    const d = decideProcessedPullReconcile({ ...base, exact: null, legacyIdem: rec() });
    expect(d).toEqual({ match: true, location: 'legacy_idem', canonicalPacketId: base.canonicalPacketId });
  });

  it('fails CLOSED (not_found) when the packet is not yet processed anywhere', () => {
    const d = decideProcessedPullReconcile({ ...base, exact: null, legacyIdem: null });
    expect(d).toEqual({ match: false, reason: 'not_found' });
  });

  it('rejects a cross-company record (tenancy enforced)', () => {
    const d = decideProcessedPullReconcile({ ...base, exact: rec({ companyId: 'other-co' }), legacyIdem: null });
    expect(d).toEqual({ match: false, reason: 'cross_tenant' });
  });

  it('rejects a cross-driver record (identity enforced)', () => {
    const d = decideProcessedPullReconcile({ ...base, exact: rec({ driverId: 'someone-else' }), legacyIdem: null });
    expect(d).toEqual({ match: false, reason: 'cross_tenant' });
  });

  it('rejects a payload mismatch (replay/tamper guard)', () => {
    const d = decideProcessedPullReconcile({ ...base, exact: rec({ bblsTaken: 999 }), legacyIdem: null });
    expect(d).toEqual({ match: false, reason: 'payload_mismatch' });
  });

  it('rejects an idem_-prefixed or empty canonical id (never confirms a prefixed key)', () => {
    expect(decideProcessedPullReconcile({ ...base, canonicalPacketId: 'idem_x', exact: rec(), legacyIdem: null }))
      .toEqual({ match: false, reason: 'invalid_id' });
    expect(decideProcessedPullReconcile({ ...base, canonicalPacketId: '', exact: rec(), legacyIdem: null }))
      .toEqual({ match: false, reason: 'invalid_id' });
  });
});

describe('selectProcessedPullParent — WB-T correction authorization', () => {
  const canonical = '20261007_090425_Gabriel7_qz0oq3';
  const parent = { ...rec(), idempotencyKey: canonical, requestType: 'pull' };
  const input = {
    canonicalPacketId: canonical,
    driverId: base.driverId,
    companyId: base.companyId,
    exact: null,
    legacyIdem: parent,
  };

  it('accepts the deterministic idem_ parent for the same driver and company', () => {
    expect(selectProcessedPullParent(input)).toEqual({ record: parent, location: 'legacy_idem' });
  });

  it('rejects a different idempotency identity, non-pull, or other tenant', () => {
    expect(selectProcessedPullParent({ ...input, legacyIdem: { ...parent, idempotencyKey: 'other' } }))
      .toEqual({ record: null, reason: 'missing_original' });
    expect(selectProcessedPullParent({ ...input, legacyIdem: { ...parent, requestType: 'edit' } }))
      .toEqual({ record: null, reason: 'missing_original' });
    expect(selectProcessedPullParent({ ...input, legacyIdem: { ...parent, companyId: 'other-company' } }))
      .toEqual({ record: null, reason: 'cross_tenant' });
  });
});

describe('new pull ingest identity', () => {
  const canonical = '20261007_090425_Gabriel7_qz0oq3';
  const packet = { packetId: canonical, idempotencyKey: canonical, driverId: base.driverId, companyId: base.companyId };

  it('uses the client packet id as the stored key without an idem_ prefix', () => {
    expect(canonicalIngestStorageKey(packet)).toBe(canonical);
    expect(canonicalIngestStorageKey({ idempotencyKey: canonical })).toBe(canonical);
    expect(canonicalIngestStorageKey({})).toBeNull();
  });

  it('acknowledges only the same driver, company, and packet identity on replay', () => {
    expect(sameIngestOwner(packet, packet, canonical)).toBe(true);
    expect(sameIngestOwner({ ...packet, driverId: 'another-driver' }, packet, canonical)).toBe(false);
    expect(sameIngestOwner({ ...packet, packetId: 'another-pull' }, packet, canonical)).toBe(false);
    expect(sameIngestOwner({ ...packet, idempotencyKey: 'another-key' }, packet, canonical)).toBe(false);
  });
});

describe('ingest / reconcile server contract (source)', () => {
  const ingest = read('src/security/operational/packetIngest.ts');
  const ingestEdit = read('src/security/operational/ingestWbmEdit.ts');
  const reconcile = read('src/security/operational/reconcileDriverPacket.ts');
  const opIndex = read('src/security/operational/index.ts');
  const secIndex = read('src/security/index.ts');
  const index = read('src/index.ts');

  it('authorizes a WB-T correction using the exact or deterministic legacy parent', () => {
    expect(ingestEdit).toContain('selectProcessedPullParent({');
    expect(ingestEdit).toContain('legacyIdemStorageKey(origIdGuess)');
    expect(ingestEdit).toContain('exact: origSnap.exists()');
    expect(ingestEdit).toContain('legacyIdem: legacyOrigSnap.exists()');
  });

  it('ingestDriverPacket returns the canonical packetId on fresh AND duplicate ingest', () => {
    // Both return branches echo the canonical id so the client retires immediately.
    expect(ingest).toMatch(/packetId: canonicalPacketId, duplicate: true/);
    expect(ingest).toMatch(/packetId: canonicalPacketId, duplicate: false/);
    // Derived from the client-supplied canonical, never re-minted as authority.
    expect(ingest).toContain('const canonicalPacketId = key;');
  });

  it('ingestDriverPacket still enforces auth + company + idempotency (no weakening)', () => {
    expect(ingest).toMatch(/requireSecureDriver\(request/);
    expect(ingest).toMatch(/assertSameCompany/);
    expect(ingest).toMatch(/existing\.exists\(\)/);        // idempotent replay guard
    expect(ingest).toMatch(/checkRateLimit/);              // rate limit intact
    expect(ingest).toMatch(/packet\.driverId = driver\.driverId/); // server stamps identity
    expect(ingest).toContain('canonicalIngestStorageKey(packet)');
    expect(ingest).toContain('sameIngestOwner(');
    expect(ingest).toContain('packets/processed/${key}');
    expect(ingest).toContain('packets/processed/${legacyKey}');
  });

  it('reconcileDriverPacket is a read-only, auth+tenant-gated callable', () => {
    expect(reconcile).toMatch(/requireSecureDriver\(request/);
    expect(reconcile).toMatch(/company_required/);
    expect(reconcile).toMatch(/decideProcessedPullReconcile/);
    expect(reconcile).not.toMatch(/\.set\(|\.update\(|\.remove\(|\.push\(/); // never writes
  });

  it('reconcileDriverPacket is exported at all three levels', () => {
    expect(opIndex).toMatch(/export \{ reconcileDriverPacket \} from '\.\/reconcileDriverPacket'/);
    expect(secIndex).toMatch(/reconcileDriverPacket,/);
    expect(index).toMatch(/reconcileDriverPacket,/);
  });
});
