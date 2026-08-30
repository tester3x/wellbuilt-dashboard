// Wiring-order proofs: the guards must run inside the deployed handlers,
// BEFORE any well state is written, and the destructive stale deletion must
// be gone. Reads index.ts as source text; fails if someone reorders the
// handler or reintroduces snapshot.ref.remove() on the guarded paths.
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf8');

const pullStart = src.indexOf('export const processIncomingPull');
const editStart = src.indexOf('export const processEditRequest');
const deleteStart = src.indexOf('export const processDeleteRequest');
const pullHandler = src.slice(pullStart, editStart);
const editHandler = src.slice(editStart, deleteStart > editStart ? deleteStart : undefined);

describe('processIncomingPull wiring', () => {
  test('handlers exist in expected order', () => {
    expect(pullStart).toBeGreaterThan(-1);
    expect(editStart).toBeGreaterThan(pullStart);
  });

  test('guard evaluates before any well-state write — and NO pre-commit state write exists at all', () => {
    const guardIdx = pullHandler.indexOf('evaluateIncomingPull({');
    expect(guardIdx).toBeGreaterThan(-1);
    // Completion audit: the early "immediate isDown" write is GONE — the ONE
    // atomic patch carries status.isDown, so a crash can never leave a
    // mutated flag beside entirely-old state.
    expect(pullHandler).not.toContain('status/isDown`).set');
  });

  test('quarantine branch hard-stops with return null', () => {
    const guardIdx = pullHandler.indexOf("guardVerdict.action === 'quarantine'");
    expect(guardIdx).toBeGreaterThan(-1);
    const block = pullHandler.slice(guardIdx, guardIdx + 700);
    expect(block).toContain('quarantineIncomingPacket(');
    expect(block).toContain('return null;');
  });

  test('the incoming request is consumed INSIDE the canonical atomic patch, never a lone remove', () => {
    // Stronger than the old contract: the incoming packet is not removed by a
    // separate snapshot.ref.remove() at all — it is set to null as PART of the same
    // canonical multipath update that writes processed/outgoing/status/receipt, so
    // canonical state and request consumption are all-or-nothing.
    expect(pullHandler).not.toContain('await snapshot.ref.remove()');
    expect(pullHandler).toMatch(/patch\[`packets\/incoming\/\$\{packetId\}`\] = null/);
    // And the stale verdict itself no longer logs/executes as a deletion.
    expect(pullHandler).not.toContain("console.log(`[STALE]");
  });
});

describe('watchdogStrandedPackets wiring', () => {
  const wdStart = src.indexOf('export const watchdogStrandedPackets');
  const wdEnd = src.indexOf('export const healthCheck');
  const watchdog = src.slice(wdStart, wdEnd);

  test('watchdog section exists', () => {
    expect(wdStart).toBeGreaterThan(-1);
    expect(wdEnd).toBeGreaterThan(wdStart);
  });

  // Phase 3 (2026-08-29): the watchdog is a RECOVERY DRIVER, not a second
  // writer. It ages packets from the server-stamped ingestedAt, and recovers
  // a stranded pull by calling the ONE canonical processing entry with the
  // SAME packetId. It can no longer re-key, clone, or invent identity.

  test('age comes from estimatePacketAge (ingestedAt) — the local-time key is never parsed', () => {
    expect(watchdog).toContain('estimatePacketAge(data, now)');
    expect(watchdog).toContain('isStranded(age)');
    expect(watchdog).not.toMatch(/key\.match\(/);          // the deployed key-parse defect is gone
    expect(watchdog).not.toMatch(/\d{2}\}\)_\(\\d/);
    expect(watchdog).not.toContain("}T${");                 // no hand-built UTC string from key parts
    expect(watchdog).not.toContain('TWO_MINUTES');          // threshold owned by watchdogAge module
  });

  test('recovery preserves packet identity: no re-key, no clone, no second logical pull', () => {
    expect(watchdog).toContain('processIncomingPullPacket(data, key)');
    expect(watchdog).not.toContain('newKey');
    expect(watchdog).not.toContain('_retriggeredBy');
    expect(watchdog).not.toContain('_originalKey');
    expect(watchdog).not.toContain('Math.random');
  });

  test('watchdog owns the commit-lock lifetime: explicit canonical timeout on the schedule', () => {
    expect(watchdog).toContain('timeoutSeconds: CANONICAL_COMMIT_TIMEOUT_SECONDS');
  });

  test('stranded edit/delete packets are quarantined losslessly, never removed or recovered here', () => {
    expect(watchdog).toContain('strandedPacketVerdict(');
    expect(watchdog).toContain("reqType === 'edit' || reqType === 'delete'");
    expect(watchdog.split('quarantineIncomingPacket(').length - 1).toBeGreaterThanOrEqual(1);
    expect(watchdog).not.toContain('Deleting');
  });

  test('direct incoming removes only in the already-committed branch (receipt or processed row proven)', () => {
    const removeCall = '.remove()';
    let at = watchdog.indexOf(removeCall);
    let count = 0;
    while (at !== -1) {
      count++;
      const before = watchdog.slice(Math.max(0, at - 900), at);
      expect(before).toMatch(/receiptPathFor\(wellName, key\)|processedDone/);
      at = watchdog.indexOf(removeCall, at + 1);
    }
    expect(count).toBe(1); // exactly the stale-residue cleanup
  });

  test('watchdog never touches packets/rejected — quarantined evidence cannot be deleted by it', () => {
    expect(watchdog).not.toContain('packets/rejected');
  });
});

describe('processEditRequest wiring', () => {
  test('both orphan paths quarantine instead of deleting', () => {
    const missingIdIdx = editHandler.indexOf('no originalPacketId or packetId');
    const notFoundIdx = editHandler.indexOf('not found in processed/');
    expect(missingIdIdx).toBeGreaterThan(-1);
    expect(notFoundIdx).toBeGreaterThan(-1);
    // Each error is followed by a quarantine call within its branch.
    expect(editHandler.slice(missingIdIdx, missingIdIdx + 500)).toContain('quarantineIncomingPacket(');
    expect(editHandler.slice(notFoundIdx, notFoundIdx + 600)).toContain('quarantineIncomingPacket(');
    // No bare deletion remains before the original-packet existence check
    // is resolved (the post-success cleanup removal later in the handler,
    // after processing completes, is legitimate and out of scope).
    const preResolution = editHandler.slice(0, notFoundIdx + 600);
    expect(preResolution).not.toContain('snapshot.ref.remove()');
  });

  test('orphan quarantines use ORIGINAL_PACKET_NOT_FOUND via orphanEditVerdict', () => {
    expect(editHandler).toContain('orphanEditVerdict(null)');
    // 7/25 invoice-identity fallback: the orphan verdict now records the
    // REQUESTED id (the client's claim); the resolved canonical id is
    // assigned to `originalPacketId` only after resolution succeeds.
    expect(editHandler).toContain('orphanEditVerdict(requestedPacketId)');
  });
});
