// Atlas1 646-row scale measurement (packet 60427 item 7). Builds a realistic
// 646-pull well and measures the COMPLETE assembled canonical patch for each
// mutation type. The point: the patch is bounded by the CHANGED rows (recovery is
// a 1-hop intrinsic, AFR a ~5-row window), NOT by the well's history size — so a
// newest CREATE on a 646-row well writes O(1) rows, and even a start-of-history
// backdated insert cascades a bounded set, never all 646.
import { buildCreateMutation, buildDeleteMutation, buildEditMutation } from '../mutationBuilders';
import type { ChronoPullInput, WellChronoConfig } from '../chronoRecompute';

const cfg: WellChronoConfig = { bblPerFoot: 40, tanks: 2, allowedBottomInches: 30 }; // Atlas1: 2 tanks, 40 bbl/ft

// 646 pulls, ~one every 8h from a fixed start, each carrying stored provenance.
const N = 646;
const START = Date.parse('2025-01-01T00:00:00.000Z');
const STEP = 8 * 3600 * 1000;
const chain: ChronoPullInput[] = Array.from({ length: N }, (_, i) => ({
  packetId: `atlas_${String(i).padStart(4, '0')}`,
  dateTimeUTC: new Date(START + i * STEP).toISOString(),
  tankTopInches: 240,
  bblsTaken: 120, // bottom 240 - (120/40)*12 = 204
  lateEntry: false,
}));

const common = (op: string) => ({
  wellName: 'Atlas1', operationId: op, fence: 1, revision: 1, committedAtMs: 0, patchHash: 'h', sidecar: {},
});
const bytes = (patch: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(patch), 'utf8');
const processedKeys = (patch: Record<string, unknown>) =>
  Object.keys(patch).filter((k) => k.startsWith('packets/processed/'));

describe(`Atlas1 scale — complete assembled patch over ${N} pulls`, () => {
  test('newest CREATE writes a bounded patch (one new row), independent of the 646-row history', () => {
    const newPull: ChronoPullInput = {
      packetId: 'atlas_new', dateTimeUTC: new Date(START + N * STEP).toISOString(),
      tankTopInches: 240, bblsTaken: 120, lateEntry: false,
    };
    const { patch, receipt } = buildCreateMutation({
      ...common('atlas_new'), existingChain: chain, newPull, cfg,
      newProcessedRecord: { packetId: 'atlas_new', dateTimeUTC: newPull.dateTimeUTC, tankTopInches: 240, bblsTaken: 120, lateEntry: false },
    });
    const touched = processedKeys(patch);
    // Only the new row's processed node is written (its full record). No successor.
    expect(touched).toEqual(['packets/processed/atlas_new']);
    expect(receipt.affectedPacketIds).toEqual(['atlas_new']);
    console.log(`[scale] newest CREATE: ${touched.length} processed row(s), patch ${bytes(patch)} bytes, ${Object.keys(patch).length} keys`);
    expect(touched.length).toBeLessThan(5); // bounded, not 646
  });

  test('start-of-history backdated insert cascades a BOUNDED successor set, never all 646', () => {
    // Insert just after the very first pull — the worst case for cascade reach.
    const backdated: ChronoPullInput = {
      packetId: 'atlas_back', dateTimeUTC: new Date(START + STEP / 2).toISOString(),
      tankTopInches: 240, bblsTaken: 60, lateEntry: true,
    };
    const { patch, receipt } = buildCreateMutation({
      ...common('atlas_back'), existingChain: chain, newPull: backdated, cfg,
      newProcessedRecord: { packetId: 'atlas_back', dateTimeUTC: backdated.dateTimeUTC, tankTopInches: 240, bblsTaken: 60, lateEntry: true },
    });
    const touched = processedKeys(patch);
    console.log(`[scale] backdated insert: ${receipt.affectedPacketIds.length} affected, ${touched.length} processed keys, patch ${bytes(patch)} bytes`);
    // The new row + a bounded cascade (recovery 1-hop + AFR window) — far below N.
    expect(receipt.affectedPacketIds.length).toBeGreaterThanOrEqual(1);
    expect(receipt.affectedPacketIds.length).toBeLessThan(50);
    expect(bytes(patch)).toBeLessThan(200_000); // complete patch stays small
  });

  test('DELETE middle-of-history writes a bounded patch', () => {
    const { patch, receipt } = buildDeleteMutation({
      ...common('delete_atlas_0323'), existingChain: chain, deletePacketId: 'atlas_0323', cfg,
    });
    const touched = processedKeys(patch);
    console.log(`[scale] DELETE middle: ${receipt.affectedPacketIds.length} affected, ${touched.length} processed keys, patch ${bytes(patch)} bytes`);
    expect(receipt.affectedPacketIds.length).toBeLessThan(50);
  });

  test('EDIT moving a middle row writes a bounded patch', () => {
    const edited: ChronoPullInput = { ...chain[323], tankTopInches: 236, bblsTaken: 100 };
    const { patch, receipt } = buildEditMutation({
      ...common('edit_atlas_0323'), existingChain: chain, editedPull: edited, cfg,
    });
    const touched = processedKeys(patch);
    console.log(`[scale] EDIT middle: ${receipt.affectedPacketIds.length} affected, ${touched.length} processed keys, patch ${bytes(patch)} bytes`);
    expect(receipt.affectedPacketIds.length).toBeLessThan(50);
  });
});
