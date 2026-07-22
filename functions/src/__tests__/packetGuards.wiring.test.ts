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
    expect(editHandler).toContain('orphanEditVerdict(originalPacketId)');
  });
});
