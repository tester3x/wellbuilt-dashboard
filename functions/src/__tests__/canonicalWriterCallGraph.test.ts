// Source call-graph proof for the canonical-writer unification (packet 60427,
// item 2). Asserts, by static analysis of index.ts, which exported triggers
// reach the ONE serialized coordinator (runCanonicalMutation → assembleCanonicalPatch),
// that the removed legacy writers are gone, and it PINS the one remaining
// non-coordinator writer (the v2 chronological-edit convergence) so the gap is
// tracked in code, not hidden. When the v2 path is unified, the pin flips and
// this test must be updated deliberately.
import { readFileSync } from 'fs';
import { join } from 'path';

const index = readFileSync(join(__dirname, '../index.ts'), 'utf8');

/** Slice one exported trigger's body from `export const <name>` to the next
 *  `export const ` (or a following handler marker). */
function triggerBody(name: string): string {
  const start = index.indexOf(`export const ${name}`);
  expect(start).toBeGreaterThan(-1);
  const rest = index.slice(start + name.length);
  const nextExport = rest.indexOf('\nexport const ');
  return rest.slice(0, nextExport === -1 ? undefined : nextExport);
}

describe('canonical-writer call graph', () => {
  test('CREATE (processIncomingPull): newest + backdated both reach the coordinator', () => {
    const body = triggerBody('processIncomingPull');
    // Newest path: assembles the patch inline and commits via the coordinator.
    expect(body).toMatch(/runCanonicalMutation\(makeCoordinatorIO\(db, wellName\)/);
    expect(body).toMatch(/assembleCanonicalPatch\(\{/);
    // Backdated path: engine builder through the SAME coordinator.
    expect(body).toMatch(/buildCreateMutation\(\{/);
    // No legacy sequential canonical writes remain in the handler.
    expect(body).not.toMatch(/packets\/outgoing\/\$\{responseId\}`\)\.set\(/);
    expect(body).not.toMatch(/wells\/\$\{wellName\}\/status`\)\.set\(wellStatus\)/);
    expect(body).not.toMatch(/performance\/\$\{wellKey\}\/rows\/\$\{perf\.perfTimestamp\}`\)\.set\(/);
    expect(body).not.toMatch(/runBackdatedInsertion\(/);
  });

  test('DELETE (processDeleteRequest) reaches the coordinator via buildDeleteMutation', () => {
    const body = triggerBody('processDeleteRequest');
    expect(body).toMatch(/runCanonicalMutation\(makeCoordinatorIO\(db, wellName\)/);
    expect(body).toMatch(/buildDeleteMutation\(\{/);
    // The hand-rolled next-packet cascade + standalone processed remove are gone.
    expect(body).not.toMatch(/Delete cascade: Updated next packet/);
    expect(body).not.toMatch(/packets\/processed\/\$\{targetPacketId\}`\)\.remove\(\)/);
  });

  test('EDIT v1 path (processIncomingEdit non-v2, incl. no-level) reaches the coordinator', () => {
    const body = triggerBody('processEditRequest');
    // processEditRequest delegates to processIncomingEdit — both live in this file;
    // assert against the whole file section from the edit trigger onward.
    const editSection = index.slice(index.indexOf('export const processEditRequest'), index.indexOf('export const processDeleteRequest'));
    // Two coordinator commits: the tank-math edit and the no-level edit.
    expect(editSection.match(/runCanonicalMutation\(makeCoordinatorIO\(db, wellName\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(editSection).toMatch(/assembleCanonicalPatch\(\{/);
    // The legacy single-hop persistence is gone from the v1 edit path.
    expect(editSection).not.toMatch(/wells\/\$\{wellName\}\/status`\)\.set\(editWellStatus\)/);
    expect(editSection).not.toMatch(/Edit cascade: Updated next packet/);
    // reference the extracted body so an unused-var lint never masks a rename
    expect(body.length).toBeGreaterThan(0);
  });

  test('removed legacy writers are absent from the whole module', () => {
    expect(index).not.toMatch(/function makeBackdatedIO\(/);
    expect(index).not.toMatch(/async function writeProductionLog\(/);
    expect(index).not.toMatch(/await runBackdatedInsertion\(/); // no live call (comment mention is fine)
    expect(index).not.toMatch(/from '\.\/processBackdatedPull'/); // legacy writer not imported
  });

  test('the completion receipt is only ever written via receiptPathFor (never ad hoc)', () => {
    // Every canonical commit path routes its receipt through receiptPathFor, so a
    // receipt can never be minted at a hand-typed path divergent from the one the
    // coordinator reads for idempotency/recovery.
    expect(index).toMatch(/receiptPathFor\(wellName, packetId\)/);          // create
    expect(index).toMatch(/receiptPathFor\(wellName, `delete_\$\{targetPacketId\}`\)|receiptPathFor\(wellName, editEventId\)/);
    expect(index).not.toMatch(/chronoReceipts\/\$\{[^}]+\}`\)\.set\(/);      // no ad-hoc receipt writes
  });

  // ── The tracked remaining gap ────────────────────────────────────────────
  // applyV2ChronologicalEdit (the schemaVersion===2 chronological-edit path) still
  // converges the edited row via a transaction and projects canonical state via
  // fencedSourceWrite — it does NOT yet route through runCanonicalMutation. This
  // is a protocol-level redesign (moving correction-materialization inside the
  // coordinator's buildPatch) that must be verified on the real Firebase emulator
  // before it lands. This test PINS that gap so it cannot be silently forgotten:
  // when the v2 path is unified, delete this test (and the fencedSourceWrite refs).
  test('KNOWN GAP: v2 chronological-edit still uses fencedSourceWrite (not yet unified)', () => {
    const v2 = index.slice(index.indexOf('export async function applyV2ChronologicalEdit'), index.indexOf('export const processEditRequest'));
    expect(v2).toMatch(/fencedSourceWrite\(/);                 // still the fenced writer
    expect(v2).not.toMatch(/runCanonicalMutation\(/);          // not yet on the coordinator
    // It is reached only for schemaVersion===2 corrections.
    expect(index).toMatch(/const isV2Correction = \(data as \{ schemaVersion\?: unknown \}\)\.schemaVersion === 2;/);
    expect(index).toMatch(/if \(isV2Correction\) \{\s*await applyV2ChronologicalEdit\(/);
  });
});
