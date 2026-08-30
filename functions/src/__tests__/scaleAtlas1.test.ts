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

interface Report { label: string; affected: number; paths: number; bytes: number; largest: string; hasReceipt: boolean; hasIncomingDelete: boolean; hasV2Revision: boolean; hasLegacyRevision: boolean; projections: string[]; }
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
    hasV2Revision: keys.includes('packets/incoming_revision_v2'),
    hasLegacyRevision: JSON.stringify(patch['packets/incoming_version'] ?? null) === JSON.stringify({ '.sv': { increment: 1048576 } }),
    hasIncomingDelete: patch[`packets/incoming/${incomingId}`] === null,
    projections,
  };
  console.log(`[Atlas1] ${label.padEnd(24)} affected=${String(r.affected).padStart(2)} paths=${String(r.paths).padStart(3)} bytes=${String(r.bytes).padStart(6)} receipt=${r.hasReceipt} incomingΔ=${r.hasIncomingDelete} v2rev=${r.hasV2Revision} legacyRev=${r.hasLegacyRevision} proj=[${r.projections.join(',')}] largest=${r.largest}`);
  // (completion audit item 1: the legacy revision is now IN the same atomic
  //  patch as a 2^20 server-side increment sentinel — no post-commit step.)
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

// ── Phase-9 additions (packet 2026-08-29): the remaining required mutations ──
describe(`Atlas1 — Phase-9 scale completions over ${N} pulls`, () => {
  test('OLDEST CREATE (backdated before row 0): bounded insert + receipt + v2', () => {
    const p = { packetId: 'atlas_oldest', dateTimeUTC: new Date(START - STEP).toISOString(), tankTopInches: 240, bblsTaken: 120, tankAfterInches: 204 };
    const { patch, receipt } = buildCreateMutation({
      wellName: WELL, operationId: p.packetId, fence: 648, revision: 648, committedAtMs: 0, patchHash: `${p.packetId}:648`,
      sidecar: { performance: { wellKey: WELLKEY, perfTimestamp: '20241231_160000', row: { d: '2024-12-31', a: 240, p: 200 }, wellName: WELL, updatedIso: '2026-08-29T00:00:00.000Z' }, production: [{ wellKey: WELLKEY, date: getProductionDate(Date.parse(p.dateTimeUTC)), value: { a: 40, w: 42, o: 39, u: '2026-08-29T00:00:00.000Z', n: 1 } }] },
      existingChain: chain, newPull: { ...p, lateEntry: true }, cfg,
      newProcessedRecord: { ...p, driverName: 'Driver One', driverId: 'd1', processedAt: '2026-08-29T00:00:00.000Z', lateEntry: true },
    });
    patch['packets/incoming/atlas_oldest'] = null;
    const r = report('OLDEST CREATE', patch, receipt, 'atlas_oldest');
    expect(r.hasReceipt).toBe(true);
    expect(r.hasV2Revision).toBe(true);
    expect(r.affected).toBeLessThanOrEqual(2);      // inserted row + first successor recompute
    expect(r.bytes).toBeLessThan(250_000);
    expect(r.paths).toBeLessThan(60);               // never scales with the 646-row history
  });

  test('DELETE oldest: successor recompute only — bounded, receipted, v2', () => {
    const { patch, receipt } = buildDeleteMutation({
      wellName: WELL, operationId: 'delete_atlas_0000', fence: 649, revision: 649, committedAtMs: 0, patchHash: 'del0:649',
      sidecar: {}, existingChain: chain, deletePacketId: 'atlas_0000', cfg,
    });
    patch['packets/incoming/del0_incoming'] = null;
    const r = report('DELETE oldest', patch, receipt, 'del0_incoming');
    expect(r.hasReceipt).toBe(true);
    expect(r.hasV2Revision).toBe(true);
    expect(r.bytes).toBeLessThan(250_000);
    expect(r.paths).toBeLessThan(60);
  });

  test('DELETE middle: neighbor stitch — bounded, receipted, v2', () => {
    const { patch, receipt } = buildDeleteMutation({
      wellName: WELL, operationId: 'delete_atlas_0323', fence: 650, revision: 650, committedAtMs: 0, patchHash: 'delm:650',
      sidecar: {}, existingChain: chain, deletePacketId: 'atlas_0323', cfg,
    });
    patch['packets/incoming/delm_incoming'] = null;
    const r = report('DELETE middle', patch, receipt, 'delm_incoming');
    expect(r.hasReceipt).toBe(true);
    expect(r.hasV2Revision).toBe(true);
    expect(r.bytes).toBeLessThan(250_000);
    expect(r.paths).toBeLessThan(60);
  });

  test('CROSS-PRODUCTION-DATE EDIT: vacated old date nulled + new date written in ONE patch', () => {
    // Move row 200 (its own 8h slot) to a completely different production date.
    const edited: ChronoPullInput = { ...chain[200], dateTimeUTC: new Date(START + 500 * STEP + 3600_000).toISOString(), tankTopInches: 238, bblsTaken: 110 };
    const oldDate = getProductionDate(Date.parse(chain[200].dateTimeUTC));
    const newDate = getProductionDate(Date.parse(edited.dateTimeUTC));
    const { patch, receipt } = buildEditMutation({
      wellName: WELL, operationId: 'edit_xdate', fence: 651, revision: 651, committedAtMs: 0, patchHash: 'x:651',
      sidecar: { production: [
        { wellKey: WELLKEY, date: oldDate, value: null },                       // vacated date removed
        { wellKey: WELLKEY, date: newDate, value: { a: 40, w: 42, o: 39, u: '2026-08-29T00:00:00.000Z', n: 4 } },
      ] },
      existingChain: chain, editedPull: edited, cfg,
    });
    patch['packets/editHistory/atlas_0200/edit_xdate'] = { eventId: 'edit_xdate' };
    patch['packets/editReceipts/edit_xdate'] = { status: 'accepted' };
    patch['packets/incoming/x_incoming'] = null;
    const r = report('CROSS-DATE EDIT', patch, receipt, 'x_incoming');
    expect(oldDate).not.toBe(newDate);
    expect(patch[`production/${WELLKEY}/${oldDate}`]).toBeNull();
    expect(patch[`production/${WELLKEY}/${newDate}`]).toBeTruthy();
    expect(r.hasReceipt).toBe(true);
    expect(r.hasV2Revision).toBe(true);
    expect(r.projections).toEqual(expect.arrayContaining(['production']));
    expect(r.bytes).toBeLessThan(250_000);
  });

  test('every measured patch carries BOTH revision signals atomically', () => {
    // Completion audit item 1: the legacy node moves via the in-patch
    // server-side increment sentinel; no post-commit revision step exists.
    const p = { packetId: 'atlas_v2chk', dateTimeUTC: new Date(START + (N + 5) * STEP).toISOString(), tankTopInches: 240, bblsTaken: 120, tankAfterInches: 204 };
    const { patch } = buildCreateMutation({
      wellName: WELL, operationId: p.packetId, fence: 652, revision: 652, committedAtMs: 0, patchHash: 'v:652',
      sidecar: {}, existingChain: chain, newPull: { ...p, lateEntry: false }, cfg,
      newProcessedRecord: { ...p, processedAt: '2026-08-29T00:00:00.000Z', lateEntry: false },
    });
    expect(patch['packets/incoming_revision_v2']).toMatchObject({ v: 2, token: 'atlas_v2chk' });
    expect(patch['packets/incoming_version']).toEqual({ '.sv': { increment: 1048576 } });
  });
});
