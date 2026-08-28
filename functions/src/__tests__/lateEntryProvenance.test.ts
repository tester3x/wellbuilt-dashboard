// Late Entry is a STABLE stored provenance signal — "this pull was accepted behind
// an already-existing later pull" — set once at mutation time and PRESERVED on every
// recompute. It is NOT a positional synonym for "not the newest row". These pins are
// the contract Codex requires before the Dashboard review tag is valid.
import { recomputeWell, upsertPull, type ChronoPullInput, type WellChronoConfig } from '../chronoRecompute';
import { buildCreateMutation, buildEditMutation } from '../mutationBuilders';

const cfg: WellChronoConfig = { bblPerFoot: 20, tanks: 1, allowedBottomInches: 30 };
const P = (id: string, t: string, top: number, bbls: number, over: Partial<ChronoPullInput> = {}): ChronoPullInput =>
  ({ packetId: id, dateTimeUTC: t, tankTopInches: top, bblsTaken: bbls, ...over });

// Chain stamped the way the handlers stamp it: each newest CREATE stored lateEntry:false.
const A = P('A', '2026-08-27T12:00:00.000Z', 158, 145, { lateEntry: false });
const B = P('B', '2026-08-27T18:00:00.000Z', 100, 60, { lateEntry: false });

describe('Late Entry — stable stored provenance', () => {
  test('a normal CREATE accepted as newest is NOT late', () => {
    const res = recomputeWell([A, B], cfg);
    expect(res.find((r) => r.packetId === 'B')!.lateEntry).toBe(false);
  });

  test('adding a later normal CREATE does not change the earlier row\'s flag', () => {
    const C = P('C', '2026-08-27T22:00:00.000Z', 90, 40, { lateEntry: false });
    const before = recomputeWell([A, B], cfg).find((r) => r.packetId === 'B')!.lateEntry;
    const after = recomputeWell([A, B, C], cfg).find((r) => r.packetId === 'B')!.lateEntry;
    expect(before).toBe(false);
    expect(after).toBe(false); // B is not relabeled just because C is now newest
  });

  test('an older CREATE accepted behind a newer pull is late (stored true), and does not relabel the newer', () => {
    // The backdated handler stamps lateEntry:true on the older pull.
    const M = P('M', '2026-08-27T15:00:00.000Z', 120, 30, { lateEntry: true });
    const res = recomputeWell([A, B, M], cfg);
    expect(res.find((r) => r.packetId === 'M')!.lateEntry).toBe(true);
    expect(res.find((r) => r.packetId === 'B')!.lateEntry).toBe(false); // newest, untouched
    expect(res.find((r) => r.packetId === 'A')!.lateEntry).toBe(false); // unrelated, untouched
  });

  test('a row that never stored the flag is NOT invented as late (default false)', () => {
    const legacy = P('L', '2026-08-27T06:00:00.000Z', 80, 20); // no lateEntry stored
    const res = recomputeWell([A, B, legacy], cfg);
    expect(res.find((r) => r.packetId === 'L')!.lateEntry).toBe(false); // engine never infers
  });

  test('equal-time pulls: deterministic event-time + packetId order; provenance preserved', () => {
    const x = P('x', '2026-08-27T18:00:00.000Z', 90, 30, { lateEntry: false });
    const y = P('y', '2026-08-27T18:00:00.000Z', 88, 28, { lateEntry: true });
    const res = recomputeWell([y, x, A], cfg);
    // Tie broken by packetId (x before y); each keeps its own stored provenance.
    const order = res.map((r) => r.packetId);
    expect(order.indexOf('x')).toBeLessThan(order.indexOf('y'));
    expect(res.find((r) => r.packetId === 'x')!.lateEntry).toBe(false);
    expect(res.find((r) => r.packetId === 'y')!.lateEntry).toBe(true);
  });

  test('same-id replay does not change the flag (upsert same values keeps provenance)', () => {
    const first = recomputeWell([A, B], cfg).find((r) => r.packetId === 'B')!.lateEntry;
    const replayed = recomputeWell(upsertPull([A, B], { ...B }), cfg).find((r) => r.packetId === 'B')!.lateEntry;
    expect(first).toBe(false);
    expect(replayed).toBe(false);
  });

  test('buildCreateMutation: newest create stamps false and does not rewrite the prior row for lateEntry', () => {
    const C = P('C', '2026-08-27T22:00:00.000Z', 90, 40);
    const { patch, receipt } = buildCreateMutation({
      wellName: 'W', operationId: 'op', fence: 1, revision: 1, committedAtMs: 0, patchHash: 'h', sidecar: {},
      existingChain: [A, B], newPull: C, cfg,
      newProcessedRecord: { packetId: 'C', lateEntry: false },
    });
    expect((patch['packets/processed/C'] as Record<string, unknown>).lateEntry).toBe(false);
    expect(patch['packets/processed/B/lateEntry']).toBeUndefined(); // B not rewritten
    expect(receipt.affectedPacketIds).toEqual(['C']);
  });

  test('buildEditMutation: editing a row only touches the edited/affected rows, not unrelated provenance', () => {
    // Edit A's material (stays oldest) → A + its successor recompute, but B keeps stored false.
    const editedA = P('A', '2026-08-27T12:00:00.000Z', 150, 100, { lateEntry: false });
    const { patch } = buildEditMutation({
      wellName: 'W', operationId: 'e', fence: 2, revision: 2, committedAtMs: 0, patchHash: 'h', sidecar: {},
      existingChain: [A, B], editedPull: editedA, cfg,
    });
    // B may be recomputed (predecessor changed) but its lateEntry stays false.
    if (patch['packets/processed/B/lateEntry'] !== undefined) {
      expect(patch['packets/processed/B/lateEntry']).toBe(false);
    }
  });
});
