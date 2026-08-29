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

  test('source-request removal joins the canonical patch (no lone snapshot.ref.remove in the routed paths)', () => {
    // CREATE + EDIT consume the incoming request INSIDE buildPatch (atomic with
    // canonical state + receipt), never via a trailing remove.
    const create = triggerBody('processIncomingPull');
    expect(create).toMatch(/patch\[`packets\/incoming\/\$\{packetId\}`\] = null/);
    expect(create).not.toMatch(/await snapshot\.ref\.remove\(\)/);
    const editSection = index.slice(index.indexOf('export const processEditRequest'), index.indexOf('export const processDeleteRequest'));
    expect(editSection).toMatch(/patch\[`packets\/incoming\/\$\{context\.params\.packetId\}`\] = null/);
    expect(editSection).not.toMatch(/await snapshot\.ref\.remove\(\)/);
    // DELETE consumes the request in the commit patch (found) or one atomic update
    // (not-found) — never a lone remove.
    const del = triggerBody('processDeleteRequest');
    expect(del).toMatch(/built\.patch\[`packets\/incoming\/\$\{deleteIncomingId\}`\] = null/);
    expect(del).not.toMatch(/await snapshot\.ref\.remove\(\)/);
  });

  test('DELETE-not-found is a receipted coordinator no-op; malformed delete is a distinct governed reject', () => {
    const del = triggerBody('processDeleteRequest');
    // Authorized target-absent delete routes through the coordinator (receipt) —
    // not a lone {archive, incoming:null} write.
    expect(del).toMatch(/if \(!deletedPacket\) \{[\s\S]*runCanonicalMutation\(makeCoordinatorIO\(db, wellName\)/);
    expect(del).toMatch(/affectedPacketIds: \[\]/); // terminal no-op
    // Malformed (no well / no target id) takes the governed quarantine path.
    expect(del).toMatch(/malformedDeleteVerdict\(/);
    expect(del).toMatch(/quarantineIncomingPacket\(/);
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

  // ── Phase 5 (2026-08-29): the gap is CLOSED ─────────────────────────────
  // applyV2ChronologicalEdit now converges corrections and projects EVERY
  // canonical location through runCanonicalMutation → assembleCanonicalPatch:
  // ONE atomic multi-location update (converged row + trail + classification
  // receipts + status + cascade + outgoing + AFR + performance + incoming
  // consumption + completion receipt). The fenced follow-up writers are gone.
  test('v2 chronological-edit routes through the coordinator — ONE canonical writer, fenced writers removed', () => {
    const v2 = index.slice(index.indexOf('export async function applyV2ChronologicalEdit'), index.indexOf('export const processEditRequest'));
    expect(v2).toMatch(/runCanonicalMutation\(makeCoordinatorIO\(db, wellName\)/);
    expect(v2).toMatch(/assembleCanonicalPatch\(\{/);
    expect(v2).toMatch(/receiptPathFor\(wellName, editEventId\)/);
    expect(v2).toMatch(/patch\[`packets\/incoming\/\$\{incomingPacketId\}`\] = null/); // consumed atomically
    expect(v2).not.toMatch(/fencedSourceWrite\(/);
    expect(v2).not.toMatch(/fencedRevWrite\(/);
    expect(v2).not.toMatch(/\.transaction\(/);                 // convergence is lock-serialized, not a txn
    // The fenced writers are gone from the whole module — no writer left to fence.
    expect(index).not.toMatch(/async function fencedSourceWrite\(/);
    expect(index).not.toMatch(/async function fencedRevWrite\(/);
    // Still reached only for schemaVersion===2 corrections.
    expect(index).toMatch(/const isV2Correction = \(data as \{ schemaVersion\?: unknown \}\)\.schemaVersion === 2;/);
    expect(index).toMatch(/if \(isV2Correction\) \{\s*await applyV2ChronologicalEdit\(/);
    // Deferred outcomes leave the incoming request untouched for retry.
    expect(v2).toMatch(/V2_EDIT_DEFERRED/);
    // Replays consume the residue without re-committing.
    expect(v2).toMatch(/already_done/);
  });
});
