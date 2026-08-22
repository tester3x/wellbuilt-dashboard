/**
 * Well Status subscription lifecycle.
 *
 * `createWellPoolSubscription` takes every side effect as a dependency, so this
 * suite drives real teardown, ordering and failure paths with a fake clock and
 * fake timers. No Firebase, no real time, no sleeping — nothing here can flake.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWellPoolSubscription } from '../wellEstimation.ts';

const T0 = Date.parse('2026-08-20T17:42:02.991Z');
const MIN = 60 * 1000;

/** Controllable clock + timer table standing in for setInterval/clearInterval. */
function harness() {
  let nowMs = T0;
  let nextId = 1;
  const timers = new Map();
  const emitted = [];
  const errors = [];

  return {
    emitted,
    errors,
    get liveTimerCount() { return timers.size; },
    now: () => nowMs,
    advance: (ms) => { nowMs += ms; },
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    /** Fire every timer registered at this interval, as the runtime would. */
    fire: (ms) => { for (const t of [...timers.values()]) if (t.ms === ms) t.fn(); },
    emit: (rows, routes, health) => emitted.push({ rows, routes, health }),
    onError: (e) => errors.push(e),
  };
}

const CONFIG = {
  'Gabriel 1': {
    route: 'Gabriels', avgFlowRate: '6:00:33', avgFlowRateMinutes: 360.56,
    bottomLevel: 3, tanks: 2, pullBbls: 140,
  },
};
const statusAt = (bottom, iso, down = false) => ({
  'Gabriel 1': {
    wellName: 'Gabriel 1', currentLevel: bottom, lastPullBottomLevel: bottom,
    lastPullDateTimeUTC: iso, wellDown: down,
  },
});
const POOL = { wellConfig: CONFIG, wellStatus: statusAt("2'7\"", '2026-08-20T17:42:02.991Z') };

const flush = () => new Promise((r) => setImmediate(r));

// ── teardown ────────────────────────────────────────────────────────────────

test('unsubscribe clears both timers', async () => {
  const h = harness();
  const stop = createWellPoolSubscription({
    loadPool: async () => POOL, emit: h.emit, now: h.now,
    setTimer: h.setTimer, clearTimer: h.clearTimer,
    authoritativeMs: 60_000, estimateMs: 30_000,
  });
  await flush();
  assert.equal(h.liveTimerCount, 2, 'refresh + estimate timers must both be registered');
  stop();
  assert.equal(h.liveTimerCount, 0, 'both timers must be cleared on unsubscribe');
});

test('no callback fires after unsubscribe, even when timers still fire', async () => {
  const h = harness();
  const stop = createWellPoolSubscription({
    loadPool: async () => POOL, emit: h.emit, now: h.now,
    setTimer: h.setTimer, clearTimer: h.clearTimer,
    authoritativeMs: 60_000, estimateMs: 30_000,
  });
  await flush();
  const before = h.emitted.length;
  stop();
  // Simulate a runtime that fires a timer already queued when stop() ran.
  h.fire(30_000);
  h.fire(60_000);
  await flush();
  assert.equal(h.emitted.length, before, 'no emission may occur after unsubscribe');
});

test('a callable response arriving after unsubscribe is ignored', async () => {
  const h = harness();
  let release;
  const stop = createWellPoolSubscription({
    loadPool: () => new Promise((resolve) => { release = () => resolve(POOL); }),
    emit: h.emit, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer,
    authoritativeMs: 60_000, estimateMs: 30_000,
  });
  // Tear down while the very first load is still in flight.
  stop();
  release();
  await flush();
  assert.equal(h.emitted.length, 0, 'a late response must not resurrect a stopped subscription');
});

// ── ordering ────────────────────────────────────────────────────────────────

test('overlapping refreshes cannot reorder snapshots', async () => {
  const h = harness();
  const pending = [];
  const stop = createWellPoolSubscription({
    loadPool: () => new Promise((resolve) => pending.push(resolve)),
    emit: h.emit, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer,
    authoritativeMs: 60_000, estimateMs: 30_000,
  });

  // First load in flight. A refresh tick while it is outstanding must not
  // start a second overlapping request.
  assert.equal(pending.length, 1);
  h.fire(60_000);
  await flush();
  assert.equal(pending.length, 1, 'in-flight guard must suppress the overlapping refresh');

  // Resolve the first with the OLD pull, then let a later refresh bring a NEWER
  // pull. The newer snapshot must win and must never be undone.
  pending[0](POOL);
  await flush();
  assert.equal(h.emitted.at(-1).rows[0].lastPullBottomLevel, "2'7\"");

  h.advance(60 * MIN);
  h.fire(60_000);
  await flush();
  assert.equal(pending.length, 2, 'a refresh may start once the previous settled');
  pending[1]({ wellConfig: CONFIG, wellStatus: statusAt("2'0\"", new Date(T0 + 60 * MIN).toISOString()) });
  await flush();
  assert.equal(h.emitted.at(-1).rows[0].lastPullBottomLevel, "2'0\"", 'newest snapshot must be applied');
  stop();
});

// ── failure and recovery ────────────────────────────────────────────────────

test('a failed refresh retains the last good snapshot and reports degraded', async () => {
  const h = harness();
  let mode = 'ok';
  const stop = createWellPoolSubscription({
    loadPool: async () => {
      if (mode === 'fail') throw Object.assign(new Error('denied'), { code: 'permission-denied' });
      return POOL;
    },
    emit: h.emit, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer,
    onError: h.onError, authoritativeMs: 60_000, estimateMs: 30_000,
  });
  await flush();
  assert.equal(h.emitted.at(-1).health.degraded, false);

  mode = 'fail';
  h.advance(60 * MIN);
  h.fire(60_000);
  await flush();

  const after = h.emitted.at(-1);
  assert.equal(after.health.degraded, true, 'failure must be reported');
  assert.equal(after.health.errorCode, 'permission-denied');
  assert.equal(after.rows.length, 1, 'the last good snapshot must still render');
  assert.equal(after.rows[0].wellName, 'Gabriel 1');
  assert.equal(h.errors.length, 1, 'onError must be notified');
  stop();
});

test('successful recovery replaces the snapshot and clears degraded', async () => {
  const h = harness();
  let mode = 'fail';
  const stop = createWellPoolSubscription({
    loadPool: async () => {
      if (mode === 'fail') throw Object.assign(new Error('denied'), { code: 'permission-denied' });
      return { wellConfig: CONFIG, wellStatus: statusAt("2'0\"", new Date(T0 + 60 * MIN).toISOString()) };
    },
    emit: h.emit, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer,
    onError: h.onError, authoritativeMs: 60_000, estimateMs: 30_000,
  });
  await flush();
  assert.equal(h.emitted.at(-1).health.degraded, true);
  assert.equal(h.emitted.at(-1).health.hasData, false, 'nothing loaded yet');

  mode = 'ok';
  h.advance(60 * MIN);
  h.fire(60_000);
  await flush();

  const ok = h.emitted.at(-1);
  assert.equal(ok.health.degraded, false, 'recovery must clear the degraded flag');
  assert.equal(ok.health.errorCode, null);
  assert.equal(ok.health.hasData, true);
  assert.equal(ok.rows[0].lastPullBottomLevel, "2'0\"", 'recovered snapshot must replace the old one');
  stop();
});

// ── estimation between refreshes ────────────────────────────────────────────

test('estimation advances on its own tick, between authoritative refreshes', async () => {
  const h = harness();
  let loads = 0;
  const stop = createWellPoolSubscription({
    loadPool: async () => { loads++; return POOL; },
    emit: h.emit, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer,
    authoritativeMs: 60_000, estimateMs: 30_000,
  });
  await flush();
  assert.equal(loads, 1);
  const first = h.emitted.at(-1).rows[0].currentLevelInches;

  h.advance(30_000);
  h.fire(30_000);          // estimate tick only — no refresh
  await flush();

  assert.equal(loads, 1, 'the estimate tick must not call the callable');
  const second = h.emitted.at(-1).rows[0].currentLevelInches;
  assert.ok(second > first, 'level must advance between authoritative refreshes');
  stop();
});

test('estimation keeps advancing while degraded', async () => {
  const h = harness();
  let mode = 'ok';
  const stop = createWellPoolSubscription({
    loadPool: async () => {
      if (mode === 'fail') throw new Error('offline');
      return POOL;
    },
    emit: h.emit, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer,
    authoritativeMs: 60_000, estimateMs: 30_000,
  });
  await flush();
  mode = 'fail';
  h.advance(60 * MIN);
  h.fire(60_000);
  await flush();
  const degradedLevel = h.emitted.at(-1).rows[0].currentLevelInches;

  h.advance(30 * MIN);
  h.fire(30_000);
  await flush();
  const later = h.emitted.at(-1);

  assert.equal(later.health.degraded, true, 'still degraded');
  assert.ok(later.rows[0].currentLevelInches > degradedLevel, 'estimation must continue offline');
  stop();
});

// ── a new pull, through the normal workflow ─────────────────────────────────

test('a new pull rebaselines without a page reload and keeps the flow rate', async () => {
  const h = harness();
  let pool = POOL;
  const stop = createWellPoolSubscription({
    loadPool: async () => pool, emit: h.emit, now: h.now,
    setTimer: h.setTimer, clearTimer: h.clearTimer,
    authoritativeMs: 60_000, estimateMs: 30_000,
  });
  await flush();

  h.advance(600 * MIN);
  h.fire(30_000);
  await flush();
  const drifted = h.emitted.at(-1).rows[0];
  assert.ok(drifted.currentLevelInches > 45, 'level should have climbed while unpulled');

  // WB-M comes back and a driver submits a real pull; the callable now returns it.
  pool = { wellConfig: CONFIG, wellStatus: statusAt("2'0\"", new Date(T0 + 600 * MIN).toISOString()) };
  h.advance(1 * MIN);
  h.fire(60_000);
  await flush();

  const reset = h.emitted.at(-1).rows[0];
  assert.ok(reset.currentLevelInches < drifted.currentLevelInches, 'new pull must drop the level');
  assert.ok(reset.currentLevelInches >= 24 && reset.currentLevelInches < 25, 'rebaselined onto 2\'0"');
  assert.equal(reset.estimationBasis, 'live');
  assert.equal(reset.flowRate, '6:00:33', 'established flow-rate behaviour is preserved');
  stop();
});

// ── wellDown through the live subscription ──────────────────────────────────

test('wellDown pauses estimation and preserves the flow rate', async () => {
  const h = harness();
  const stop = createWellPoolSubscription({
    loadPool: async () => ({ wellConfig: CONFIG, wellStatus: statusAt("2'7\"", '2026-08-20T17:42:02.991Z', true) }),
    emit: h.emit, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer,
    authoritativeMs: 60_000, estimateMs: 30_000,
  });
  await flush();
  const first = h.emitted.at(-1).rows[0];

  h.advance(600 * MIN);
  h.fire(30_000);
  await flush();
  const later = h.emitted.at(-1).rows[0];

  assert.equal(first.estimationBasis, 'well_down');
  assert.equal(later.currentLevel, first.currentLevel, 'a down well must not drift');
  assert.equal(later.isDown, true);
  // Marking a well down must not destroy what we know about it.
  assert.equal(later.flowRate, '6:00:33', 'flow rate must survive wellDown');
  assert.equal(later.lastPullBottomLevel, "2'7\"", 'pull boundary preserved');
  assert.equal(later.lastPullDateTimeUTC, '2026-08-20T17:42:02.991Z', 'pull timestamp preserved');
  stop();
});

test('a well brought back online by a real pull resumes estimating', async () => {
  const h = harness();
  let pool = { wellConfig: CONFIG, wellStatus: statusAt("2'7\"", '2026-08-20T17:42:02.991Z', true) };
  const stop = createWellPoolSubscription({
    loadPool: async () => pool, emit: h.emit, now: h.now,
    setTimer: h.setTimer, clearTimer: h.clearTimer,
    authoritativeMs: 60_000, estimateMs: 30_000,
  });
  await flush();
  assert.equal(h.emitted.at(-1).rows[0].estimationBasis, 'well_down');

  // The driver's next accepted packet carries wellDown=false plus a fresh pull.
  pool = { wellConfig: CONFIG, wellStatus: statusAt("2'0\"", new Date(T0 + 600 * MIN).toISOString(), false) };
  h.advance(601 * MIN);
  h.fire(60_000);
  await flush();

  const back = h.emitted.at(-1).rows[0];
  assert.equal(back.estimationBasis, 'live', 'estimation resumes from the new pull');
  assert.ok(back.currentLevelInches >= 24, 'baselined on the new bottom level');
  assert.equal(back.flowRate, '6:00:33', 'flow rate unchanged by the down/up cycle');
  stop();
});

// ── isolation through the live subscription ─────────────────────────────────

test('a foreign status row from the callable cannot render', async () => {
  const h = harness();
  const stop = createWellPoolSubscription({
    loadPool: async () => ({
      wellConfig: CONFIG, // projection contains Gabriel 1 only
      wellStatus: {
        ...statusAt("2'7\"", '2026-08-20T17:42:02.991Z'),
        'OtherCo Well 9': { wellName: 'OtherCo Well 9', currentLevel: "9'9\"" },
      },
    }),
    emit: h.emit, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer,
    authoritativeMs: 60_000, estimateMs: 30_000,
  });
  await flush();
  const rows = h.emitted.at(-1).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wellName, 'Gabriel 1');
  stop();
});
