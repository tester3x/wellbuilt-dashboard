// Phase-2: the v2 refresh-signal contract + its atomic placement in the
// canonical patch, and the legacy-bridge invariants.
import { INCOMING_REVISION_V2_PATH, buildRevisionV2, revisionV2TokenOf } from '../revisionV2';
import { assembleCanonicalPatch, receiptPathFor } from '../canonicalPatch';
import { applyLegacyBump } from '../incomingVersionPublish';
import type { CommitReceipt } from '../chronoCommitCoordinator';

const receipt = (operationId: string, committedAtMs = 1787927108195): CommitReceipt => ({
  operationId,
  mutationType: 'create',
  wellName: 'Gabriel 1',
  fence: 3,
  revision: 3,
  affectedPacketIds: [operationId],
  committedAtMs,
  patchHash: 'h',
});

describe('revision v2 token contract', () => {
  test('token is the committed operationId — distinct mutations in the same millisecond differ', () => {
    const a = buildRevisionV2(receipt('20260828_150000_Gabriel1_4p2ds2', 1000));
    const b = buildRevisionV2(receipt('20260828_150000_Gabriel3_r3uyzy', 1000)); // same ms, other well
    expect(a.token).not.toBe(b.token);
    expect(a).toEqual({ v: 2, token: '20260828_150000_Gabriel1_4p2ds2', at: 1000 });
  });

  test('replay produces the SAME token (no false mutation signal)', () => {
    const first = buildRevisionV2(receipt('op1', 1000));
    const replay = buildRevisionV2(receipt('op1', 1000));
    expect(replay.token).toBe(first.token); // inequality consumers see no change
  });

  test('node is minimal: no well name, no mutation type, no business material', () => {
    const node = buildRevisionV2(receipt('op1'));
    expect(Object.keys(node).sort()).toEqual(['at', 'token', 'v']);
  });

  test('token parsing is defensive: canonical node, bare string, everything else null', () => {
    expect(revisionV2TokenOf({ v: 2, token: 'op1', at: 5 })).toBe('op1');
    expect(revisionV2TokenOf('bare-token')).toBe('bare-token');
    expect(revisionV2TokenOf('   ')).toBeNull();
    expect(revisionV2TokenOf(null)).toBeNull();
    expect(revisionV2TokenOf(430053531466077630000)).toBeNull();  // the saturated legacy double is NOT a token
    expect(revisionV2TokenOf({ v: 2 })).toBeNull();
    expect(revisionV2TokenOf({ token: 42 })).toBeNull();
    expect(revisionV2TokenOf(['op1'])).toBeNull();
  });
});

describe('atomic placement in the canonical patch', () => {
  test('every assembled patch carries the v2 node alongside the receipt — same all-or-nothing update', () => {
    const r = receipt('20260828_090803_Predator1_3k806o');
    const patch = assembleCanonicalPatch({
      processedUpdates: { 'packets/processed/20260828_090803_Predator1_3k806o/tankAfterInches': 100.8 },
      receipt: r,
      receiptPath: receiptPathFor('Predator 1', r.operationId),
    });
    expect(patch[INCOMING_REVISION_V2_PATH]).toEqual({ v: 2, token: r.operationId, at: r.committedAtMs });
    expect(patch[receiptPathFor('Predator 1', r.operationId)]).toBe(r);
  });

  test('a delete no-op receipt still replaces the token (a distinct committed operation)', () => {
    const r: CommitReceipt = { ...receipt('delete_20260828_x'), mutationType: 'delete', affectedPacketIds: [] };
    const patch = assembleCanonicalPatch({ processedUpdates: {}, receipt: r, receiptPath: receiptPathFor('Gabriel 1', r.operationId) });
    expect(revisionV2TokenOf(patch[INCOMING_REVISION_V2_PATH])).toBe('delete_20260828_x');
  });
});

describe('legacy bridge invariants (atomic increment sentinel)', () => {
  test('cannot decrease, at any magnitude below the proof bound', () => {
    for (const v of [0, 1, 61, 1787927108195, Number.MAX_SAFE_INTEGER, 4.3005353146607763e20, 8.6e20]) {
      expect(applyLegacyBump(v)).toBeGreaterThan(v);
    }
  });

  test('serialized server-side application yields N distinct increasing values from the saturated start', () => {
    // RTDB applies each update's increment atomically against the then-current
    // value — concurrent commits serialize server-side. Model the serialized
    // outcome from the saturated production value.
    let v = 4.3005353146607763e20;
    const seen = new Set<number>([v]);
    for (let i = 0; i < 10; i++) {
      v = applyLegacyBump(v);
      expect(seen.has(v)).toBe(false); // every bump observable
      seen.add(v);
    }
  });
});
