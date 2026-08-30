// Atomic legacy-revision contract (completion audit item 1): the legacy node
// moves via a server-side increment sentinel INSIDE the canonical patch — no
// post-commit publication step exists anywhere in the module.
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LEGACY_BUMP_VALID_BELOW,
  LEGACY_INCOMING_VERSION_PATH,
  LEGACY_REVISION_BUMP,
  applyLegacyBump,
  legacyRevisionIncrement,
} from '../incomingVersionPublish';
import { assembleCanonicalPatch, receiptPathFor } from '../canonicalPatch';
import type { CommitReceipt } from '../chronoCommitCoordinator';

const SAT = 4.3005353146607763e20;

describe('the increment sentinel', () => {
  test('is exactly the RTDB ServerValue.increment wire shape', () => {
    expect(legacyRevisionIncrement()).toEqual({ '.sv': { increment: 1048576 } });
    expect(LEGACY_REVISION_BUMP).toBe(Math.pow(2, 20));
  });

  test('changes the exact saturated production magnitude (and +1 provably does not)', () => {
    expect(SAT + 1).toBe(SAT);                                   // the deployed defect
    expect(applyLegacyBump(SAT)).toBeGreaterThan(SAT);           // the bump moves it
    // Strict-greater old clients wake; inequality consumers see a change.
    expect(applyLegacyBump(SAT) > SAT).toBe(true);
  });

  test('monotonic and observable for every representable magnitude below 2^73', () => {
    for (const v of [0, 61, 1787927108195, Number.MAX_SAFE_INTEGER, SAT, 8.6e20, 3.4e21]) {
      expect(v).toBeLessThan(LEGACY_BUMP_VALID_BELOW);
      const bumped = applyLegacyBump(v);
      expect(bumped).toBeGreaterThan(v);
      // repeated bumps keep climbing — no stall, no wraparound
      expect(applyLegacyBump(bumped)).toBeGreaterThan(bumped);
    }
    // The proof bound itself: half of ULP(2^73) is 2^20 — at and past that
    // magnitude a fixed 2^20 stops being a guaranteed change. The node needs
    // ~8.6e15 more mutations to get there from production's value.
    expect(Math.pow(2, Math.floor(Math.log2(LEGACY_BUMP_VALID_BELOW)) - 52) / 2).toBe(LEGACY_REVISION_BUMP);
    expect((LEGACY_BUMP_VALID_BELOW - SAT) / LEGACY_REVISION_BUMP).toBeGreaterThan(8e15);
  });
});

describe('atomic placement — one update carries business state + receipt + BOTH revisions', () => {
  const receipt: CommitReceipt = {
    operationId: 'op1', mutationType: 'create', wellName: 'Gabriel 1', fence: 2, revision: 2,
    affectedPacketIds: ['op1'], committedAtMs: 5, patchHash: 'h',
  };

  test('assembleCanonicalPatch emits the sentinel alongside the v2 token and receipt', () => {
    const patch = assembleCanonicalPatch({
      processedUpdates: { 'packets/processed/op1/x': 1 },
      receipt, receiptPath: receiptPathFor('Gabriel 1', 'op1'),
    });
    expect(patch[LEGACY_INCOMING_VERSION_PATH]).toEqual({ '.sv': { increment: 1048576 } });
    expect(patch['packets/incoming_revision_v2']).toMatchObject({ v: 2, token: 'op1' });
    expect(patch[receiptPathFor('Gabriel 1', 'op1')]).toBe(receipt);
  });

  test('no commit-owning path performs a second revision persistence step', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8');
    expect(index).not.toContain('notifyIncomingVersionBestEffort');
    expect(index).not.toContain('publishIncomingVersionAfterOutgoing');
    // The ONLY writes to the legacy node come from the assembled patch.
    expect(index).not.toMatch(/ref\('packets\/incoming_version'\)[\s\S]{0,80}(set|transaction|update)\(/);
  });
});
