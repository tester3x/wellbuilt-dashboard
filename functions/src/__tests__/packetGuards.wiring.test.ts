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

  test('guard evaluates before ANY well-state write (isDown is the first one)', () => {
    const guardIdx = pullHandler.indexOf('evaluateIncomingPull({');
    const isDownWrite = pullHandler.indexOf('status/isDown`).set');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(isDownWrite).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(isDownWrite);
  });

  test('canonical wellStatus lastPull is read before the stale guard', () => {
    const statusRead = pullHandler.indexOf('status/lastPull/dateTimeUTC');
    const guardIdx = pullHandler.indexOf('evaluateIncomingPull({');
    expect(statusRead).toBeGreaterThan(-1);
    expect(statusRead).toBeLessThan(guardIdx);
    expect(pullHandler).toContain('canonicalLastPullUTC: wellStatusLastPullUTC');
  });

  test('AFR / wellStatus / outgoing writes sit after the quarantine return', () => {
    const quarantineReturn = pullHandler.indexOf("guardVerdict.action === 'quarantine'");
    expect(quarantineReturn).toBeGreaterThan(-1);
    expect(pullHandler.indexOf('avgFlowRateMinutes')).toBeGreaterThan(quarantineReturn);
    expect(pullHandler.indexOf('const wellStatus: WellStatus')).toBeGreaterThan(quarantineReturn);
    expect(pullHandler.indexOf('packets/outgoing/${responseId}')).toBeGreaterThan(quarantineReturn);
  });

  test('quarantine branch hard-stops with return null', () => {
    const guardIdx = pullHandler.indexOf("guardVerdict.action === 'quarantine'");
    expect(guardIdx).toBeGreaterThan(-1);
    const block = pullHandler.slice(guardIdx, guardIdx + 700);
    expect(block).toContain('quarantineIncomingPacket(');
    expect(block).toContain('return null;');
  });

  test('no destructive removal remains before processing commits', () => {
    // The old [STALE] guard deleted the incoming packet BEFORE anything was
    // processed. The only legitimate snapshot.ref.remove() calls are the
    // post-success cleanups, which all come AFTER the packet has been
    // written to packets/processed. Assert every remove sits after the
    // first processed-write in the handler.
    const firstProcessedWrite = pullHandler.indexOf('packets/processed/');
    expect(firstProcessedWrite).toBeGreaterThan(-1);
    const removeCall = 'await snapshot.ref.remove()';
    let at = pullHandler.indexOf(removeCall);
    expect(at).toBeGreaterThan(-1); // cleanups still exist
    while (at !== -1) {
      expect(at).toBeGreaterThan(firstProcessedWrite);
      at = pullHandler.indexOf(removeCall, at + 1);
    }
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

  test('duplicate-grouped and stranded edit/delete packets are quarantined, not removed', () => {
    const quarantineCalls = watchdog.split('quarantineIncomingPacket(').length - 1;
    expect(quarantineCalls).toBeGreaterThanOrEqual(2); // duplicates + edit/delete skip
    expect(watchdog).toContain('strandedPacketVerdict(');
    expect(watchdog).not.toContain('Deleting'); // old "Deleting N duplicate packets" log gone
  });

  test('retrigger re-key is one atomic update (no delete-then-set crash window)', () => {
    expect(watchdog).toContain('[`packets/incoming/${key}`]: null');
    expect(watchdog).toContain('[`packets/incoming/${newKey}`]: data');
    // Both paths live in the SAME update call.
    const updIdx = watchdog.indexOf('await db.ref().update({');
    expect(updIdx).toBeGreaterThan(-1);
    const updBlock = watchdog.slice(updIdx, updIdx + 220);
    expect(updBlock).toContain('${key}`]: null');
    expect(updBlock).toContain('${newKey}`]: data');
  });

  test('only already-processed cleanup may still remove incoming directly (content preserved in processed/)', () => {
    // Every remaining direct remove must sit inside an "already processed"
    // branch, i.e. after an exists() check against packets/processed.
    const removeCall = '.remove()';
    let at = watchdog.indexOf(removeCall);
    let count = 0;
    while (at !== -1) {
      count++;
      const before = watchdog.slice(Math.max(0, at - 700), at);
      expect(before).toMatch(/processedSnap\.exists\(\)|origProcessedSnap\.exists\(\)/);
      at = watchdog.indexOf(removeCall, at + 1);
    }
    expect(count).toBe(2); // already-processed cleanup + unreachable legacy edit branch
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
