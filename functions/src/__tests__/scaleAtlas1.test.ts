// Atlas1 646-row scale measurement (packet 60427 item 7). Builds a realistic
// 646-pull well and reports the EXACT complete assembled canonical patch for every
// mutation type — affected row count, total path count, serialized bytes. The point:
// the patch is bounded by the CHANGED rows (recovery is a 1-hop intrinsic, AFR a
// ~5-row window), NOT by the well's history size.
import { buildCreateMutation, buildDeleteMutation, buildEditMutation } from '../mutationBuilders';
import type { ChronoPullInput, WellChronoConfig, ChronoPullResult } from '../chronoRecompute';
import { recomputeWell } from '../chronoRecompute';
import type { CommitReceipt } from '../chronoCommitCoordinator';

const cfg: WellChronoConfig = { bblPerFoot: 40, tanks: 2, allowedBottomInches: 30 }; // Atlas1: 2 tanks, 40 bbl/ft

const N = 646;
const START = Date.parse('2025-01-01T00:00:00.000Z');
const STEP = 8 * 3600 * 1000; // ~one pull every 8h
const chain: ChronoPullInput[] = Array.from({ length: N }, (_, i) => ({
  packetId: `atlas_${String(i).padStart(4, '0')}`,
  dateTimeUTC: new Date(START + i * STEP).toISOString(),
  tankTopInches: 240,
  bblsTaken: 120,
  lateEntry: false,
}));

const common = (op: string) => ({
  wellName: 'Atlas1', operationId: op, fence: 1, revision: 1, committedAtMs: 0, patchHash: 'h', sidecar: {},
});
const bytes = (patch: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(patch), 'utf8');
const measure = (label: string, patch: Record<string, unknown>, receipt: CommitReceipt) => {
  const paths = Object.keys(patch).length;
  const processed = Object.keys(patch).filter((k) => k.startsWith('packets/processed/')).length;
  const b = bytes(patch);
  console.log(`[Atlas1] ${label.padEnd(26)} affected=${String(receipt.affectedPacketIds.length).padStart(3)}  paths=${String(paths).padStart(3)}  processedPaths=${String(processed).padStart(3)}  bytes=${String(b).padStart(6)}`);
  return { affected: receipt.affectedPacketIds.length, paths, processed, bytes: b };
};

describe(`Atlas1 scale — EXACT complete assembled patch over ${N} pulls`, () => {
  test('every mutation type writes a bounded patch (measured), independent of the 646-row history', () => {
    const results: Record<string, { affected: number; paths: number; processed: number; bytes: number }> = {};

    // 1. newest CREATE
    {
      const p: ChronoPullInput = { packetId: 'atlas_new', dateTimeUTC: new Date(START + N * STEP).toISOString(), tankTopInches: 240, bblsTaken: 120, lateEntry: false };
      const { patch, receipt } = buildCreateMutation({ ...common('atlas_new'), existingChain: chain, newPull: p, cfg, newProcessedRecord: { packetId: 'atlas_new', dateTimeUTC: p.dateTimeUTC, tankTopInches: 240, bblsTaken: 120, lateEntry: false } });
      results.newestCreate = measure('newest CREATE', patch, receipt);
    }
    // 2. OLDEST backdated CREATE (insert before the very first pull)
    {
      const p: ChronoPullInput = { packetId: 'atlas_oldest', dateTimeUTC: new Date(START - STEP).toISOString(), tankTopInches: 240, bblsTaken: 60, lateEntry: true };
      const { patch, receipt } = buildCreateMutation({ ...common('atlas_oldest'), existingChain: chain, newPull: p, cfg, newProcessedRecord: { packetId: 'atlas_oldest', dateTimeUTC: p.dateTimeUTC, tankTopInches: 240, bblsTaken: 60, lateEntry: true } });
      results.oldestBackdated = measure('oldest backdated CREATE', patch, receipt);
    }
    // 3. MIDDLE backdated CREATE (insert between rows 322 and 323)
    {
      const p: ChronoPullInput = { packetId: 'atlas_midins', dateTimeUTC: new Date(START + 322 * STEP + STEP / 2).toISOString(), tankTopInches: 240, bblsTaken: 60, lateEntry: true };
      const { patch, receipt } = buildCreateMutation({ ...common('atlas_midins'), existingChain: chain, newPull: p, cfg, newProcessedRecord: { packetId: 'atlas_midins', dateTimeUTC: p.dateTimeUTC, tankTopInches: 240, bblsTaken: 60, lateEntry: true } });
      results.middleBackdated = measure('middle backdated CREATE', patch, receipt);
    }
    // 4. EDIT moving EARLIER (move row 400 back near row 100)
    {
      const edited: ChronoPullInput = { ...chain[400], dateTimeUTC: new Date(START + 100 * STEP + STEP / 3).toISOString(), tankTopInches: 236, bblsTaken: 100 };
      const { patch, receipt } = buildEditMutation({ ...common('edit_earlier'), existingChain: chain, editedPull: edited, cfg });
      results.editEarlier = measure('EDIT moving earlier', patch, receipt);
    }
    // 5. EDIT moving LATER and becoming current (move row 300 to newest)
    {
      const edited: ChronoPullInput = { ...chain[300], dateTimeUTC: new Date(START + (N + 1) * STEP).toISOString(), tankTopInches: 238, bblsTaken: 110 };
      const { patch, receipt, current } = buildEditMutation({ ...common('edit_later'), existingChain: chain, editedPull: edited, cfg });
      expect(current).toBe('atlas_0300'); // it becomes the current pull
      results.editLaterCurrent = measure('EDIT moving later→current', patch, receipt);
    }
    // 6. DELETE oldest
    {
      const { patch, receipt } = buildDeleteMutation({ ...common('del_oldest'), existingChain: chain, deletePacketId: 'atlas_0000', cfg });
      results.deleteOldest = measure('DELETE oldest', patch, receipt);
    }
    // 7. DELETE middle
    {
      const { patch, receipt } = buildDeleteMutation({ ...common('del_middle'), existingChain: chain, deletePacketId: 'atlas_0323', cfg });
      results.deleteMiddle = measure('DELETE middle', patch, receipt);
    }
    // 8. DELETE newest
    {
      const { patch, receipt } = buildDeleteMutation({ ...common('del_newest'), existingChain: chain, deletePacketId: `atlas_${String(N - 1).padStart(4, '0')}`, cfg });
      results.deleteNewest = measure('DELETE newest', patch, receipt);
    }

    // Every complete patch is bounded FAR below the 646-row history size.
    for (const [label, r] of Object.entries(results)) {
      expect(r.affected).toBeGreaterThanOrEqual(1);
      expect(r.affected).toBeLessThan(60);         // bounded cascade, not O(N)
      expect(r.bytes).toBeLessThan(250_000);       // complete patch stays small
      expect(r.paths).toBeLessThan(400);
      void label;
    }
    // Sanity: recompute of the full 646-row chain is coherent (no throw, all present).
    const full: ChronoPullResult[] = recomputeWell(chain, cfg);
    expect(full).toHaveLength(N);
  });
});
