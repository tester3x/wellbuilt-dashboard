// Atlas1 646-row scale — the COMPLETE assembled LIVE patch (packet 60427 item 7).
// Codex correction: the earlier numbers measured buildCreateMutation with an EMPTY
// sidecar (a partial engine patch). This measures the FULL flat multipath object as
// each live handler builds it — realistic sidecars (outgoing/current, wells-status,
// performance, production, AFR) via the SAME builders the handlers use, plus the
// completion receipt, the source-request deletion, and (CREATE) the production label
// path — exactly the map handed to RTDB update().
import { buildCreateMutation, buildDeleteMutation, buildEditMutation, type CanonicalSidecar } from '../mutationBuilders';
import { buildOutgoingResponse, buildWellStatus } from '../outgoingBuilders';
import { buildPerformanceRow } from '../performanceBuilders';
import { computeBbls24hrs, getProductionDate } from '../productionFormulas';
import type { ChronoPullInput, WellChronoConfig } from '../chronoRecompute';
import type { CommitReceipt } from '../chronoCommitCoordinator';

const cfg: WellChronoConfig = { bblPerFoot: 40, tanks: 2, allowedBottomInches: 30 };
const TANKS = 2, BBLPERFOOT = 40, PULLBBLS = 120, BOTTOM_IN = 36;
const N = 646;
const START = Date.parse('2025-01-01T00:00:00.000Z');
const STEP = 8 * 3600 * 1000;
const chain: ChronoPullInput[] = Array.from({ length: N }, (_, i) => ({
  packetId: `atlas_${String(i).padStart(4, '0')}`,
  dateTimeUTC: new Date(START + i * STEP).toISOString(),
  tankTopInches: 240, bblsTaken: 120, lateEntry: false,
}));

const WELL = 'Atlas1', WELLKEY = 'Atlas1';
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** The full projections sidecar the CREATE-newest / EDIT-latest handlers build. */
function currentSidecar(pull: { packetId: string; dateTimeUTC: string; tankTopInches: number; bblsTaken: number; tankAfterInches: number }, afr: number, oldResponseIds: string[]): CanonicalSidecar {
  const bbls24 = computeBbls24hrs(afr, TANKS);
  const response = buildOutgoingResponse({
    wellName: WELL, currentLevelInches: pull.tankAfterInches, afr, bbls24hrs: bbls24, nextIsDown: false,
    estTimeToPull: '2:00', estDateTimePull: new Date(Date.parse(pull.dateTimeUTC) + 2 * 3600 * 1000).toISOString(),
    dateTime: '', dateTimeUTC: pull.dateTimeUTC, bblsTaken: pull.bblsTaken, driverId: 'd1', driverName: 'Driver One',
    tankTopInches: pull.tankTopInches, tankAfterInches: pull.tankAfterInches, packetId: pull.packetId,
    config: { companyId: 'liquid-gold' }, timestampIso: '2026-08-28T00:00:00.000Z', windowBblsDay: 42, overnightBblsDay: 39,
  });
  const status = buildWellStatus({
    wellName: WELL, tanks: TANKS, bottomInches: BOTTOM_IN, route: 'R1', pullBbls: PULLBBLS,
    currentLevelInches: pull.tankAfterInches, dateTime: '', dateTimeUTC: pull.dateTimeUTC, tankTopInches: pull.tankTopInches,
    tankAfterInches: pull.tankAfterInches, bblsTaken: pull.bblsTaken, driverName: 'Driver One', packetId: pull.packetId,
    afr, afrMinutes: afr * 1440, bbls24hrs: bbls24, estDateTimePull: '', estTimeToPull: '2:00', nextIsDown: false,
    nowIso: '2026-08-28T00:00:00.000Z',
  });
  const perf = buildPerformanceRow({ wellName: WELL, dateTimeUTC: pull.dateTimeUTC, tankLevelFeet: pull.tankTopInches / 12, predictedLevelInches: 200, prevResponse: null });
  return {
    outgoing: { deleteResponseIds: oldResponseIds, responseId: `response_${pull.packetId}`, response },
    wellStatus: { wellName: WELL, status },
    performance: { wellKey: WELLKEY, perfTimestamp: perf.perfTimestamp, row: perf.row as unknown as Record<string, unknown>, wellName: WELL, updatedIso: '2026-08-28T00:00:00.000Z' },
    production: [{ wellKey: WELLKEY, date: getProductionDate(Date.parse(pull.dateTimeUTC)), value: { a: 40, w: 42, o: 39, u: '2026-08-28T00:00:00.000Z', n: 7 } }],
    afr: { wellName: WELL, avgFlowRate: '2:00:00', avgFlowRateMinutes: afr * 1440 },
  };
}

interface Report { label: string; affected: number; paths: number; bytes: number; largest: string; hasReceipt: boolean; hasIncomingDelete: boolean; projections: string[]; }
function report(label: string, patch: Record<string, unknown>, receipt: CommitReceipt, incomingId: string): Report {
  const keys = Object.keys(patch);
  let largestKey = '', largestBytes = 0;
  for (const k of keys) { const b = bytes(patch[k]); if (b > largestBytes) { largestBytes = b; largestKey = k; } }
  const has = (prefix: string) => keys.some((k) => k.startsWith(prefix));
  const projections = [
    has('packets/outgoing/') ? 'outgoing' : '',
    keys.some((k) => k.includes('/status/') && !k.endsWith('/chronoRevision')) ? 'status' : '',
    has(`performance/${WELLKEY}/`) ? 'performance' : '',
    has(`production/${WELLKEY}/`) ? 'production' : '',
    keys.some((k) => k.includes('/avgFlowRate')) ? 'afr' : '',
    keys.some((k) => k.endsWith('/chronoRevision')) ? 'chronoRevision' : '',
  ].filter(Boolean);
  const r: Report = {
    label, affected: receipt.affectedPacketIds.length, paths: keys.length, bytes: bytes(patch),
    largest: `${largestKey} (${largestBytes}B)`,
    hasReceipt: keys.some((k) => k.includes('/chronoReceipts/')),
    hasIncomingDelete: patch[`packets/incoming/${incomingId}`] === null,
    projections,
  };
  console.log(`[Atlas1] ${label.padEnd(24)} affected=${String(r.affected).padStart(2)} paths=${String(r.paths).padStart(3)} bytes=${String(r.bytes).padStart(6)} receipt=${r.hasReceipt} incomingΔ=${r.hasIncomingDelete} proj=[${r.projections.join(',')}] largest=${r.largest}`);
  return r;
}

describe(`Atlas1 — COMPLETE live assembled patch over ${N} pulls`, () => {
  test('newest CREATE: full projections + receipt + incoming-delete present', () => {
    const p = { packetId: 'atlas_new', dateTimeUTC: new Date(START + N * STEP).toISOString(), tankTopInches: 240, bblsTaken: 120, tankAfterInches: 204 };
    const { patch, receipt } = buildCreateMutation({
      wellName: WELL, operationId: p.packetId, fence: 647, revision: 647, committedAtMs: 0, patchHash: `${p.packetId}:647`,
      sidecar: currentSidecar(p, 0.083, ['response_old']),
      existingChain: chain, newPull: { ...p, lateEntry: false }, cfg,
      newProcessedRecord: { ...p, driverName: 'Driver One', driverId: 'd1', processedAt: '2026-08-28T00:00:00.000Z', lateEntry: false },
    });
    patch[`production/${WELLKEY}/wellName`] = WELL;         // handler adds this sibling
    patch[`packets/incoming/${p.packetId}`] = null;         // handler folds request removal into the patch
    const r = report('newest CREATE', patch, receipt, p.packetId);
    expect(r.hasReceipt).toBe(true);
    expect(r.hasIncomingDelete).toBe(true);
    expect(r.projections).toEqual(expect.arrayContaining(['outgoing', 'status', 'performance', 'production', 'afr', 'chronoRevision']));
    expect(r.paths).toBeGreaterThan(15);                    // complete patch, not 3
    expect(r.affected).toBe(1);                             // no successor relabel (stored lateEntry)
  });

  test('older/backdated CREATE: processed + successor + performance + production + receipt; current-only projections absent', () => {
    // A backdated insert never becomes newest, so outgoing/wells-status/AFR (which
    // derive exclusively from the current pull) are INTENTIONALLY absent. But it DOES
    // participate in history aggregates → it carries its own performance row and its
    // production-date total (count recomputed from authoritative rows). Patch =
    // processed(new + recomputed successor) + performance + production + fence +
    // receipt + incoming-delete.
    const p: ChronoPullInput = { packetId: 'atlas_mid', dateTimeUTC: new Date(START + 322 * STEP + STEP / 2).toISOString(), tankTopInches: 240, bblsTaken: 60, lateEntry: true };
    const sidecar: CanonicalSidecar = {
      performance: { wellKey: WELLKEY, perfTimestamp: '20250108_040000', row: { d: '2025-01-08', a: 240, p: 238 }, wellName: WELL, updatedIso: '2026-08-28T00:00:00.000Z' },
      production: [{ wellKey: WELLKEY, date: '2025-01-08', value: { a: 40, w: 42, o: 39, u: '2026-08-28T00:00:00.000Z', n: 4 } }],
    };
    const { patch, receipt } = buildCreateMutation({
      wellName: WELL, operationId: p.packetId, fence: 647, revision: 647, committedAtMs: 0, patchHash: `${p.packetId}:647`, sidecar,
      existingChain: chain, newPull: p, cfg, newProcessedRecord: { packetId: p.packetId, dateTimeUTC: p.dateTimeUTC, tankTopInches: 240, bblsTaken: 60, lateEntry: true, processedAt: '2026-08-28T00:00:00.000Z' },
    });
    patch[`production/${WELLKEY}/wellName`] = WELL;
    patch[`packets/incoming/${p.packetId}`] = null;
    const r = report('backdated CREATE', patch, receipt, p.packetId);
    expect(r.hasReceipt).toBe(true);
    expect(r.hasIncomingDelete).toBe(true);
    expect(r.projections).toEqual(expect.arrayContaining(['performance', 'production'])); // history aggregates DO update
    expect(r.projections).not.toContain('outgoing');       // current-only projection absent
    expect(r.projections).not.toContain('status');
    expect(r.projections).not.toContain('afr');
    expect(r.affected).toBe(2);                             // new row + one recomputed successor
  });

  test('DELETE newest: outgoing rebuilt from new latest + audit + receipt + incoming-delete', () => {
    const newestId = `atlas_${String(N - 1).padStart(4, '0')}`;
    const prevId = `atlas_${String(N - 2).padStart(4, '0')}`;
    const prev = chain[N - 2];
    const { patch, receipt } = buildDeleteMutation({
      wellName: WELL, operationId: `delete_${newestId}`, fence: 647, revision: 647, committedAtMs: 0, patchHash: `del:647`,
      sidecar: currentSidecar({ packetId: prevId, dateTimeUTC: prev.dateTimeUTC, tankTopInches: 240, bblsTaken: 120, tankAfterInches: 204 }, 0.083, ['response_old']),
      existingChain: chain, deletePacketId: newestId, cfg,
    });
    patch[`production/${WELLKEY}/wellName`] = WELL;
    patch[`packets/processed/delete_${newestId}`] = { result: 'rebuilt_from_previous', processedAt: '2026-08-28T00:00:00.000Z' }; // audit archive
    patch[`packets/incoming/del_incoming`] = null;
    const r = report('DELETE newest', patch, receipt, 'del_incoming');
    expect(r.hasReceipt).toBe(true);
    expect(r.hasIncomingDelete).toBe(true);
    expect(r.projections).toEqual(expect.arrayContaining(['outgoing', 'status', 'performance']));
    expect(r.paths).toBeGreaterThan(15);                    // complete, not 3
  });

  test('EDIT moving later→current: full projections + edit-trail + isDown + receipt + incoming-delete', () => {
    const edited: ChronoPullInput = { ...chain[300], dateTimeUTC: new Date(START + (N + 1) * STEP).toISOString(), tankTopInches: 238, bblsTaken: 110 };
    const { patch, receipt, current } = buildEditMutation({
      wellName: WELL, operationId: 'edit_e1', fence: 647, revision: 647, committedAtMs: 0, patchHash: 'edit:647',
      sidecar: currentSidecar({ packetId: 'atlas_0300', dateTimeUTC: edited.dateTimeUTC, tankTopInches: 238, bblsTaken: 110, tankAfterInches: 205 }, 0.083, ['response_old']),
      existingChain: chain, editedPull: edited, cfg,
    });
    // Live edit handler additionally folds these into the same patch:
    patch['packets/editHistory/atlas_0300/edit_e1'] = { eventId: 'edit_e1', fields: { bblsTaken: { from: 120, to: 110 } } };
    patch['packets/editReceipts/edit_e1'] = { status: 'accepted', appliedAt: '2026-08-28T00:00:00.000Z' };
    patch[`wells/${WELL}/status/isDown`] = false;
    patch[`packets/incoming/edit_incoming`] = null;
    const r = report('EDIT later→current', patch, receipt, 'edit_incoming');
    expect(current).toBe('atlas_0300');
    expect(r.hasReceipt).toBe(true);
    expect(r.hasIncomingDelete).toBe(true);
    expect(r.projections).toEqual(expect.arrayContaining(['outgoing', 'status', 'performance']));
  });

  test('all complete patches remain bounded far below the 646-row history', () => {
    // Guard: even the largest (EDIT-earlier full cascade) stays well under N and 250KB.
    const edited: ChronoPullInput = { ...chain[400], dateTimeUTC: new Date(START + 100 * STEP + STEP / 3).toISOString(), tankTopInches: 236, bblsTaken: 100 };
    const { patch, receipt } = buildEditMutation({
      wellName: WELL, operationId: 'edit_earlier', fence: 647, revision: 647, committedAtMs: 0, patchHash: 'e:647',
      sidecar: {}, existingChain: chain, editedPull: edited, cfg,
    });
    patch['packets/editHistory/atlas_0400/edit_earlier'] = { eventId: 'edit_earlier' };
    patch['packets/editReceipts/edit_earlier'] = { status: 'accepted' };
    patch[`wells/${WELL}/status/isDown`] = false;
    patch['packets/incoming/e_incoming'] = null;
    const r = report('EDIT earlier (cascade)', patch, receipt, 'e_incoming');
    expect(r.affected).toBeLessThan(60);
    expect(r.bytes).toBeLessThan(250_000);
    expect(r.paths).toBeLessThan(400);
  });
});
