import test from 'node:test';
import assert from 'node:assert/strict';
import {
  waitForDeleteCompletion,
  filterVisiblePulls,
  type DeleteCompletionOptions,
} from '../pullDeleteCompletion.ts';

// ── Test 1: Delayed Processing ───────────────────────────────────────────────

test('Delete completion check: succeeds when processor finishes after delay (delayed processing)', async () => {
  let attempts = 0;
  const targetPacketId = '20260925_000835_Gabriel7_nnksoz';

  // Simulate processor finishing on attempt 3
  const isPacketPresent = async (pid: string) => {
    attempts++;
    assert.equal(pid, targetPacketId);
    // Present on attempts 1 and 2, removed on attempt 3
    return attempts < 3;
  };

  const sleepCalls: number[] = [];
  const sleep = async (ms: number) => {
    sleepCalls.push(ms);
  };

  const result = await waitForDeleteCompletion(targetPacketId, {
    maxAttempts: 10,
    intervalMs: 600,
    isPacketPresent,
    sleep,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.attempts, 3);
  assert.deepEqual(sleepCalls, [600, 600, 600]);
});

// ── Test 2: Failure / Timeout ────────────────────────────────────────────────

test('Delete completion check: times out after maxAttempts if processor is stuck', async () => {
  let attempts = 0;
  const targetPacketId = 'pk_stuck_123';

  // Packet remains stubbornly present forever
  const isPacketPresent = async () => {
    attempts++;
    return true;
  };

  const sleepCalls: number[] = [];
  const sleep = async (ms: number) => {
    sleepCalls.push(ms);
  };

  const result = await waitForDeleteCompletion(targetPacketId, {
    maxAttempts: 5,
    intervalMs: 300,
    isPacketPresent,
    sleep,
  });

  assert.equal(result.status, 'timeout');
  assert.equal(result.attempts, 5);
  assert.equal(attempts, 5);
  assert.equal(sleepCalls.length, 5);
});

// ── Test 3: Repeated Refresh & Pending State Filtering ───────────────────────

test('Visible pulls filtering: pending deleted pull is hidden and does not reappear during refresh', () => {
  const pulls = [
    { packetId: 'pk_normal_1', wellName: 'Gabriel 7', bblsTaken: 140 },
    { packetId: 'pk_deleting_2', wellName: 'Gabriel 7', bblsTaken: 140 },
    { packetId: 'pk_normal_3', wellName: 'Gabriel 7', bblsTaken: 140 },
  ];

  const pending = new Set(['pk_deleting_2']);

  // During repeated refresh, the old re-read containing pk_deleting_2 must NOT be presented
  const visible = filterVisiblePulls(pulls, pending);
  assert.deepEqual(
    visible.map((p) => p.packetId),
    ['pk_normal_1', 'pk_normal_3'],
    'Pending deleted packet must be omitted from visible pulls',
  );

  // Once processor finishes and pending set is cleared:
  const serverPullsAfterProcessor = [
    { packetId: 'pk_normal_1', wellName: 'Gabriel 7', bblsTaken: 140 },
    { packetId: 'pk_normal_3', wellName: 'Gabriel 7', bblsTaken: 140 },
  ];
  const refreshedVisible = filterVisiblePulls(serverPullsAfterProcessor, new Set());
  assert.deepEqual(
    refreshedVisible.map((p) => p.packetId),
    ['pk_normal_1', 'pk_normal_3'],
  );
});

// ── Test 4: Delete Audit Entries Kept Out of Pull History ────────────────────

test('Delete audit entries: delete_ prefixed records and requestType=delete are filtered out', () => {
  const mixedPulls = [
    { packetId: '20260925_000835_Gabriel7_nnksoz', wellName: 'Gabriel 7', bblsTaken: 140 },
    { packetId: 'delete_20260925_000835_Gabriel7_nnksoz', wellName: 'Gabriel 7', requestType: 'delete' },
    { packetId: 'edit_20260925_000835_Gabriel7_nnksoz', wellName: 'Gabriel 7' },
    { packetId: '20260924_151106_Gabriel7_abc', wellName: 'Gabriel 7', bblsTaken: 140 },
  ];

  const visible = filterVisiblePulls(mixedPulls, new Set());
  assert.deepEqual(
    visible.map((p) => p.packetId),
    ['20260925_000835_Gabriel7_nnksoz', '20260924_151106_Gabriel7_abc'],
    'Delete audit records and edit markers must be completely excluded from history display',
  );
});

// ── Test 5: Another Well Not Disturbed ───────────────────────────────────────

test('Well isolation: operations on Well A do not affect Well B', () => {
  const wellAPulls = [
    { packetId: 'pk_a_1', wellName: 'Gabriel 7' },
    { packetId: 'pk_a_2', wellName: 'Gabriel 7' },
  ];
  const wellBPulls = [
    { packetId: 'pk_b_1', wellName: 'Gabriel 3' },
    { packetId: 'pk_b_2', wellName: 'Gabriel 3' },
  ];

  // Deleting pk_a_1 on Gabriel 7
  const pendingA = new Set(['pk_a_1']);
  const visibleA = filterVisiblePulls(wellAPulls, pendingA);
  const visibleB = filterVisiblePulls(wellBPulls, pendingA);

  assert.deepEqual(visibleA.map((p) => p.packetId), ['pk_a_2']);
  assert.deepEqual(visibleB.map((p) => p.packetId), ['pk_b_1', 'pk_b_2'], 'Well B must not be altered');
});
