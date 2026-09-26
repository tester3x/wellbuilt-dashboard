import { readFileSync } from 'fs';
import { join } from 'path';
import { decideProcessedPullReconcile } from '../packetReconcileCore';

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

describe('ingest / reconcile server contract (source)', () => {
  const ingest = read('src/security/operational/packetIngest.ts');
  const reconcile = read('src/security/operational/reconcileDriverPacket.ts');
  const opIndex = read('src/security/operational/index.ts');
  const secIndex = read('src/security/index.ts');
  const index = read('src/index.ts');

  it('ingestDriverPacket returns the canonical packetId on fresh AND duplicate ingest', () => {
    // Both return branches echo the canonical id so the client retires immediately.
    expect(ingest).toMatch(/packetId: canonicalPacketId, duplicate: true/);
    expect(ingest).toMatch(/packetId: canonicalPacketId, duplicate: false/);
    // Derived from the client-supplied canonical, never re-minted as authority.
    expect(ingest).toMatch(/canonicalPacketId\s*=[\s\S]*packet\.packetId/);
  });

  it('ingestDriverPacket still enforces auth + company + idempotency (no weakening)', () => {
    expect(ingest).toMatch(/requireSecureDriver\(request/);
    expect(ingest).toMatch(/assertSameCompany/);
    expect(ingest).toMatch(/existing\.exists\(\)/);        // idempotent replay guard
    expect(ingest).toMatch(/checkRateLimit/);              // rate limit intact
    expect(ingest).toMatch(/packet\.driverId = driver\.driverId/); // server stamps identity
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
