/**
 * Behavioral join: ingestWbmPull RTDB child key === processIncomingPull
 * context.params.packetId === WB-M reconciliation lookup id.
 *
 * Does not redesign the processor. Does not invoke production Firebase.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { comparePullEquivalence } from '../../../packetGuards';
import {
  decideWbmPullTransaction,
  evaluateWbmPull,
  wbmIncomingPath,
  wbmPullStorageKey,
} from '../wbmPullAuthorize';

const PID = '20260820_124211_Gabriel1_frr2t3';
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const OTHER_DRIVER = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
const COMPANY = 'liquid-gold';

const functionsRoot = join(__dirname, '../../../..');
const processorSrc = readFileSync(join(functionsRoot, 'src/index.ts'), 'utf8');
const ingestSrc = readFileSync(join(functionsRoot, 'src/security/operational/ingestWbmPull.ts'), 'utf8');
const authorizeSrc = readFileSync(join(functionsRoot, 'src/security/operational/wbmPullAuthorize.ts'), 'utf8');
const wbtIngestSrc = readFileSync(join(functionsRoot, 'src/security/operational/packetIngest.ts'), 'utf8');

const pullStart = processorSrc.indexOf('export const processIncomingPull');
const pullEnd = processorSrc.indexOf('export const processEditRequest');
const pullHandler = processorSrc.slice(pullStart, pullEnd);

const GABRIEL_PACKET = {
  requestType: 'pull',
  wellName: 'Gabriel 1',
  dateTimeUTC: '2026-08-20T17:42:02.991Z',
  tankLevelFeet: 9.583333333333334,
  bblsTaken: 140,
  packetId: PID,
  idempotencyKey: PID,
};

const WELL_CONFIG = { 'Gabriel 1': { route: 'Gabriels', companyId: COMPANY } };

type Store = Record<string, Record<string, unknown>>;

/** Firebase onCreate: .ref('packets/incoming/{packetId}') → context.params.packetId */
function processorTriggerPacketId(incomingPath: string): string {
  const m = incomingPath.match(/^packets\/incoming\/([^/]+)$/);
  if (!m) throw new Error(`not an incoming child path: ${incomingPath}`);
  return m[1];
}

function authorizePull(packet: Record<string, unknown>) {
  return evaluateWbmPull({
    packet,
    companyId: COMPANY,
    assignedRoutes: ['Gabriels'],
    assignedWells: [],
    wellConfig: WELL_CONFIG,
  });
}

function ingestToStore(
  store: Store,
  packet: Record<string, unknown>,
  driverId: string,
): { ok: true; key: string; path: string; duplicate: boolean; payloadDigest: string }
  | { ok: false; reason: string } {
  const decided = authorizePull(packet);
  if (!decided.ok) return decided;
  const key = wbmPullStorageKey(decided.idempotencyKey);
  const path = wbmIncomingPath(decided.idempotencyKey);
  const existing = store[path] ?? null;
  const gate = decideWbmPullTransaction({
    existing,
    driverId,
    payloadDigest: decided.payloadDigest,
  });
  if (gate.action === 'abort') return { ok: false, reason: gate.reason };
  if (gate.action === 'write') {
    store[path] = {
      ...decided.payload,
      driverId,
      companyId: COMPANY,
      payloadDigest: decided.payloadDigest,
    };
  }
  return {
    ok: true,
    key,
    path,
    duplicate: gate.action === 'duplicate',
    payloadDigest: decided.payloadDigest,
  };
}

/**
 * Identity projection of processIncomingPull: the child key IS packetId.
 * Downstream writes use that same id. Exact-ID replay uses comparePullEquivalence.
 */
function processIncoming(store: Store, incomingPath: string): {
  packetId: string;
  replay: boolean;
  collision: boolean;
} {
  const packetId = processorTriggerPacketId(incomingPath);
  const data = store[incomingPath];
  if (!data) throw new Error(`missing incoming ${incomingPath}`);
  const processedPath = `packets/processed/${packetId}`;
  const existing = store[processedPath];
  if (existing) {
    const equivalence = comparePullEquivalence(data as any, existing as any);
    if (equivalence.equivalent) {
      delete store[incomingPath];
      return { packetId, replay: true, collision: false };
    }
    store[`packets/rejected/${packetId}`] = { packetId, reason: 'PACKET_ID_COLLISION' };
    delete store[incomingPath];
    return { packetId, replay: false, collision: true };
  }
  const wellName = String(data.wellName);
  store[processedPath] = { ...data, packetId, processedAt: '2026-08-20T17:43:00.000Z' };
  store[`packets/outgoing/response_${packetId}`] = {
    wellName,
    lastPullPacketId: packetId,
  };
  store[`wells/${wellName}/status`] = {
    lastPull: { packetId },
  };
  store[`canonical_jobs/${packetId}`] = {
    packetId,
    canonicalJobId: packetId,
  };
  delete store[incomingPath];
  return { packetId, replay: false, collision: false };
}

function wbmReconcile(store: Store, originalPacketId: string): 'delivered' | 'rejected' | 'submitted' | 'unknown' {
  if (store[`packets/processed/${originalPacketId}`]) return 'delivered';
  if (store[`packets/rejected/${originalPacketId}`]) return 'rejected';
  if (store[`packets/incoming/${originalPacketId}`]) return 'submitted';
  return 'unknown';
}

describe('canonical packet ID joins ingest storage key to processor trigger', () => {
  it('WB-M submit of 20260820_124211_Gabriel1_frr2t3 writes packets/incoming/{that id}', () => {
    const store: Store = {};
    const ingested = ingestToStore(store, GABRIEL_PACKET, DRIVER);
    expect(ingested.ok).toBe(true);
    if (!ingested.ok) return;
    expect(ingested.key).toBe(PID);
    expect(ingested.path).toBe(`packets/incoming/${PID}`);
    expect(store[`packets/incoming/${PID}`]).toBeDefined();
    expect(store[`packets/incoming/${PID}`].packetId).toBe(PID);
    expect(store[`packets/incoming/${PID}`].idempotencyKey).toBe(PID);
    expect(Object.keys(store).filter((k) => k.startsWith('packets/incoming/'))).toEqual([
      `packets/incoming/${PID}`,
    ]);
    expect(ingestSrc).toMatch(/wbmIncomingPath\(decided\.idempotencyKey\)/);
    expect(ingestSrc).toMatch(/wbmPullStorageKey\(decided\.idempotencyKey\)/);
    expect(authorizeSrc).not.toMatch(/wbm_\$\{/);
    expect(ingestSrc).not.toMatch(/wbm_\$\{/);
  });

  it('processIncomingPull receives that identical context.params.packetId', () => {
    expect(pullHandler).toMatch(/ref\('packets\/incoming\/\{packetId\}'\)/);
    expect(pullHandler).toMatch(/const packetId = context\.params\.packetId/);
    const store: Store = {};
    const ingested = ingestToStore(store, GABRIEL_PACKET, DRIVER);
    expect(ingested.ok).toBe(true);
    if (!ingested.ok) return;
    const triggerId = processorTriggerPacketId(ingested.path);
    expect(triggerId).toBe(PID);
    expect(triggerId).toBe(wbmPullStorageKey(PID));
  });

  it('the same ID reaches processed record, outgoing, well status, and canonical-job linkage', () => {
    expect(pullHandler).toMatch(/packets\/processed\/\$\{packetId\}/);
    expect(pullHandler).toMatch(/lastPullPacketId: packetId/);
    expect(pullHandler).toMatch(/canonicalJobId: result\.canonicalJobId/);
    const lastPullBlock = pullHandler.slice(pullHandler.indexOf('lastPull: {'));
    expect(lastPullBlock).toMatch(/packetId,/);

    const store: Store = {};
    const ingested = ingestToStore(store, GABRIEL_PACKET, DRIVER);
    expect(ingested.ok).toBe(true);
    if (!ingested.ok) return;
    const processed = processIncoming(store, ingested.path);
    expect(processed.packetId).toBe(PID);
    expect(processed.replay).toBe(false);
    expect(store[`packets/processed/${PID}`]).toMatchObject({ packetId: PID });
    expect(store[`packets/outgoing/response_${PID}`]).toMatchObject({ lastPullPacketId: PID });
    expect(store['wells/Gabriel 1/status']).toMatchObject({ lastPull: { packetId: PID } });
    expect(store[`canonical_jobs/${PID}`]).toMatchObject({ packetId: PID, canonicalJobId: PID });
    expect(store[`packets/incoming/${PID}`]).toBeUndefined();
  });

  it('WB-M reconciliation against packets/processed/{originalPacketId} marks delivered', () => {
    const store: Store = {};
    const ingested = ingestToStore(store, GABRIEL_PACKET, DRIVER);
    expect(ingested.ok).toBe(true);
    if (!ingested.ok) return;
    expect(wbmReconcile(store, PID)).toBe('submitted');
    processIncoming(store, ingested.path);
    expect(wbmReconcile(store, PID)).toBe('delivered');
    expect(store[`packets/processed/${PID}`]).toBeDefined();
  });

  it('offline replay keeps the same ID and creates no second canonical pull', () => {
    const store: Store = {};
    const first = ingestToStore(store, GABRIEL_PACKET, DRIVER);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replayWhileIncoming = ingestToStore(store, GABRIEL_PACKET, DRIVER);
    expect(replayWhileIncoming.ok).toBe(true);
    if (!replayWhileIncoming.ok) return;
    expect(replayWhileIncoming.duplicate).toBe(true);
    expect(replayWhileIncoming.key).toBe(PID);
    expect(Object.keys(store).filter((k) => k.startsWith('packets/incoming/'))).toHaveLength(1);

    const processed = processIncoming(store, first.path);
    expect(processed.packetId).toBe(PID);

    const replayAfterProcessed = ingestToStore(store, GABRIEL_PACKET, DRIVER);
    expect(replayAfterProcessed.ok).toBe(true);
    if (!replayAfterProcessed.ok) return;
    expect(replayAfterProcessed.duplicate).toBe(false);
    expect(replayAfterProcessed.key).toBe(PID);
    const replayed = processIncoming(store, replayAfterProcessed.path);
    expect(replayed.packetId).toBe(PID);
    expect(replayed.replay).toBe(true);
    expect(replayed.collision).toBe(false);
    expect(Object.keys(store).filter((k) => k.startsWith('packets/processed/'))).toEqual([
      `packets/processed/${PID}`,
    ]);
    expect(wbmReconcile(store, PID)).toBe('delivered');
  });

  it('same packet ID, different payload or driver, conflicts', () => {
    const store: Store = {};
    const first = ingestToStore(store, GABRIEL_PACKET, DRIVER);
    expect(first.ok).toBe(true);
    const payloadConflict = ingestToStore(store, { ...GABRIEL_PACKET, bblsTaken: 200 }, DRIVER);
    expect(payloadConflict).toEqual({ ok: false, reason: 'idempotency_payload_conflict' });
    const crossDriver = ingestToStore(store, GABRIEL_PACKET, OTHER_DRIVER);
    expect(crossDriver).toEqual({ ok: false, reason: 'idempotency_cross_driver' });
  });

  it('hashed wbm_ storage keys are no longer produced and would miss WB-M lookup', () => {
    const hashed = `wbm_${DRIVER}_deadbeef`;
    expect(wbmPullStorageKey(PID)).not.toBe(hashed);
    expect(wbmIncomingPath(PID)).not.toContain('wbm_');
    const store: Store = {};
    store[`packets/processed/${hashed}`] = { packetId: hashed };
    expect(wbmReconcile(store, PID)).toBe('unknown');
  });

  it('processor exact-ID already-processed path is unchanged', () => {
    expect(pullHandler).toMatch(/IDEMPOTENT_REPLAY_ALREADY_PROCESSED/);
    expect(pullHandler).toMatch(/packets\/processed\/\$\{packetId\}/);
    expect(pullHandler).not.toMatch(/wbm_\$\{/);
  });

  it('WB-T ingestDriverPacket remains unchanged and does not use canonical mint keys', () => {
    expect(wbtIngestSrc).toMatch(/export const ingestDriverPacket/);
    expect(wbtIngestSrc).toMatch(/idem_\$\{packet\.idempotencyKey/);
    expect(wbtIngestSrc).not.toMatch(/wbmPullStorageKey/);
    expect(wbtIngestSrc).not.toMatch(/matchesMintPacketId/);
    expect(wbtIngestSrc).not.toMatch(/wbmIncomingPath/);
  });

  it('pull envelope has no route assignment and ingest does not mutate profiles', () => {
    const decided = authorizePull(GABRIEL_PACKET);
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.payload).not.toHaveProperty('assignedRoutes');
    expect(decided.payload).not.toHaveProperty('assignedWells');
    expect(ingestSrc).toMatch(/drivers\/profiles\/\$\{driver\.driverId\}/);
    expect(ingestSrc).toMatch(/\.once\('value'\)/);
    expect(ingestSrc).toMatch(/assignedRoutes: profile\.assignedRoutes/);
    expect(ingestSrc).not.toMatch(/drivers\/profiles\/\$\{driver\.driverId\}`\)\.(set|update|remove)/);
    expect(ingestSrc).not.toMatch(/profile\.(assignedRoutes|assignedWells)\s*=/);
  });
});
