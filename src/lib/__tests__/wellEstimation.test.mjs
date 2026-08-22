/**
 * Well Status estimation + freshness.
 *
 * Runs with `node --test src/lib/__tests__/` — no jest, no vitest, no install.
 * Node strips the TypeScript types from the module under test.
 *
 * Everything here is deterministic: `nowMs` is always passed explicitly, so a
 * slow machine can never turn a timing assertion into a flake.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWellRows,
  computeHealth,
  describePoolHealth,
  errorCodeOf,
  estimateCurrentLevel,
  formatAge,
  inchesToDisplay,
  parseFeetInchesStr,
  routesFromRows,
  STALE_AFTER_MS,
} from '../wellEstimation.ts';

const T0 = Date.parse('2026-08-20T17:42:02.991Z'); // Gabriel 1's real last pull
const MIN = 60 * 1000;

/** Gabriel 1's real production shape: 140 BBL, 2 tanks, AFR 360.56 min/ft. */
function gabriel1({ down = false, bottom = "2'7\"", pulledAt = '2026-08-20T17:42:02.991Z' } = {}) {
  return {
    wellConfig: {
      'Gabriel 1': {
        route: 'Gabriels',
        tanks: 2,
        pullBbls: 140,
        bottomLevel: 3,
        allowedBottom: 3,
        avgFlowRate: '6:00:33',
        avgFlowRateMinutes: 360.56,
      },
    },
    wellStatus: {
      'Gabriel 1': {
        wellName: 'Gabriel 1',
        currentLevel: bottom,
        lastPullBottomLevel: bottom,
        lastPullDateTimeUTC: pulledAt,
        wellDown: down,
        timeTillPull: '12h 0m',
      },
    },
  };
}

// ── 1. normal secure initial load ───────────────────────────────────────────

test('initial load estimates forward from the last pull, not the recorded level', () => {
  const { wellConfig, wellStatus } = gabriel1();
  // 30.047 min per inch → 60 min of fill is 1.997in above the 31in bottom,
  // i.e. 32.997in, which the display floors to whole inches: 2'8".
  const rows = buildWellRows({ wellConfig, wellStatus, nowMs: T0 + 60 * MIN });

  assert.equal(rows.length, 1);
  const g1 = rows[0];
  assert.equal(g1.estimationBasis, 'live');
  assert.equal(g1.wellName, 'Gabriel 1');
  assert.ok(g1.currentLevelInches > 31, 'must be above the pull bottom level');
  assert.ok(Math.abs(g1.currentLevelInches - 32.997) < 0.01, 'exact fill arithmetic');
  assert.equal(g1.currentLevel, "2'8\"", 'expected 31in + 1.997in of rise, floored');
  assert.notEqual(g1.currentLevel, "2'7\"", 'must not display the frozen pull value');
  assert.equal(g1.route, 'Gabriels');
});

test('a well in config with no pull still appears, and is not faked', () => {
  const rows = buildWellRows({
    wellConfig: { 'Brand New 1': { route: 'Gabriels', avgFlowRateMinutes: 300 } },
    wellStatus: {},
    nowMs: T0,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].estimationBasis, 'no_pull');
  assert.equal(rows[0].currentLevel, '--');
});

// ── 2. 30-second estimation ─────────────────────────────────────────────────

test('the estimate advances across successive ticks', () => {
  const { wellConfig, wellStatus } = gabriel1();
  const t1 = buildWellRows({ wellConfig, wellStatus, nowMs: T0 + 60 * MIN })[0];
  const t2 = buildWellRows({ wellConfig, wellStatus, nowMs: T0 + 60 * MIN + 30_000 })[0];
  const t3 = buildWellRows({ wellConfig, wellStatus, nowMs: T0 + 60 * MIN + 60_000 })[0];

  assert.ok(t2.currentLevelInches > t1.currentLevelInches, 'tick 1 → 2 must rise');
  assert.ok(t3.currentLevelInches > t2.currentLevelInches, 'tick 2 → 3 must rise');
  // 30s at 30.047 min/inch ≈ 0.0166in — small, but strictly monotonic.
  const step = t2.currentLevelInches - t1.currentLevelInches;
  assert.ok(step > 0 && step < 0.05, `implausible 30s step: ${step}`);
});

test('time till pull shrinks as the level rises', () => {
  const { wellConfig, wellStatus } = gabriel1();
  const early = buildWellRows({ wellConfig, wellStatus, nowMs: T0 + 60 * MIN })[0];
  const later = buildWellRows({ wellConfig, wellStatus, nowMs: T0 + 600 * MIN })[0];
  assert.notEqual(early.timeTillPull, 'Unknown');
  assert.notEqual(early.timeTillPull, later.timeTillPull);
});

// ── 3. arrival of a new pull ────────────────────────────────────────────────

test('a new pull resets the baseline to its own bottom level and timestamp', () => {
  const before = gabriel1();
  const drifted = buildWellRows({ ...before, nowMs: T0 + 600 * MIN })[0];
  assert.ok(drifted.currentLevelInches > 45, 'level should have climbed well above 31in');

  // Driver pulls the well down to 2'0" ten hours later.
  const after = gabriel1({ bottom: "2'0\"", pulledAt: new Date(T0 + 600 * MIN).toISOString() });
  const reset = buildWellRows({ ...after, nowMs: T0 + 601 * MIN })[0];

  assert.equal(reset.estimationBasis, 'live');
  assert.ok(
    reset.currentLevelInches < drifted.currentLevelInches,
    'the new pull must drop the displayed level, not keep estimating from the old one',
  );
  assert.ok(reset.currentLevelInches >= 24, 'must be at or above the new 24in bottom');
  assert.ok(reset.currentLevelInches < 25, 'one minute after the pull it has barely risen');
  assert.equal(reset.timestampUTC, new Date(T0 + 600 * MIN).toISOString());
});

// ── 4. wellDown ─────────────────────────────────────────────────────────────

test('a down well is never estimated forward', () => {
  const { wellConfig, wellStatus } = gabriel1({ down: true });
  const early = buildWellRows({ wellConfig, wellStatus, nowMs: T0 + 60 * MIN })[0];
  const later = buildWellRows({ wellConfig, wellStatus, nowMs: T0 + 6000 * MIN })[0];

  assert.equal(early.estimationBasis, 'well_down');
  assert.equal(early.currentLevel, "2'7\"", 'shows the recorded level');
  assert.equal(early.currentLevel, later.currentLevel, 'must not drift over time');
  assert.equal(early.isDown, true);
  assert.equal(early.timeTillPull, 'Down');
});

test('isDown is honoured as well as wellDown', () => {
  const { wellConfig } = gabriel1();
  const rows = buildWellRows({
    wellConfig,
    wellStatus: {
      'Gabriel 1': {
        wellName: 'Gabriel 1', currentLevel: "2'7\"", lastPullBottomLevel: "2'7\"",
        lastPullDateTimeUTC: '2026-08-20T17:42:02.991Z', isDown: true,
      },
    },
    nowMs: T0 + 600 * MIN,
  });
  assert.equal(rows[0].estimationBasis, 'well_down');
});

// ── 5. degraded inputs must not fabricate a level ───────────────────────────

test('missing or zero flow rate falls back to the recorded level', () => {
  for (const afr of [undefined, 0, -5]) {
    const { wellConfig, wellStatus } = gabriel1();
    wellConfig['Gabriel 1'].avgFlowRateMinutes = afr;
    const row = buildWellRows({ wellConfig, wellStatus, nowMs: T0 + 600 * MIN })[0];
    assert.equal(row.estimationBasis, 'no_flow_rate', `afr=${afr}`);
    assert.equal(row.currentLevel, "2'7\"");
  }
});

test('an unparsable bottom level or timestamp does not produce a number', () => {
  for (const bad of [{ lastPullBottomLevel: 'n/a' }, { lastPullDateTimeUTC: 'not-a-date' }]) {
    const { wellConfig, wellStatus } = gabriel1();
    Object.assign(wellStatus['Gabriel 1'], bad);
    const row = buildWellRows({ wellConfig, wellStatus, nowMs: T0 + 600 * MIN })[0];
    assert.equal(row.estimationBasis, 'unparsable', JSON.stringify(bad));
  }
});

test('a future-dated pull never runs the estimate backwards', () => {
  // Guards the real `Python` row, which carries a 2026-12-03 timestamp.
  const est = estimateCurrentLevel(31, '2026-12-03T13:45:00.000Z', 360.56, T0);
  assert.equal(est, 31, 'clamped to the pull bottom, not below it');
});

// ── 6. permission-denied fallback + refresh ─────────────────────────────────

test('a failed refresh reports degraded and keeps the last good snapshot', () => {
  const loadedAt = T0 + 60 * MIN;
  const health = computeHealth({
    lastAuthoritativeAt: loadedAt,
    errorCode: 'permission-denied',
    nowMs: loadedAt + 90_000,
  });
  assert.equal(health.degraded, true);
  assert.equal(health.hasData, true, 'the last good snapshot is still usable');
  assert.equal(health.errorCode, 'permission-denied');
  assert.equal(health.staleForMs, 90_000);
});

test('estimation continues while degraded', () => {
  // The whole point of keeping the snapshot: levels still advance offline.
  const { wellConfig, wellStatus } = gabriel1();
  const a = buildWellRows({ wellConfig, wellStatus, nowMs: T0 + 60 * MIN })[0];
  const b = buildWellRows({ wellConfig, wellStatus, nowMs: T0 + 120 * MIN })[0];
  assert.ok(b.currentLevelInches > a.currentLevelInches);
});

test('a recovered refresh clears the degraded flag', () => {
  const recovered = computeHealth({
    lastAuthoritativeAt: T0 + 120 * MIN, errorCode: null, nowMs: T0 + 120 * MIN,
  });
  assert.equal(recovered.degraded, false);
  assert.equal(recovered.errorCode, null);
  assert.equal(recovered.staleForMs, 0);
});

// ── 7. stale / degraded indication ──────────────────────────────────────────

test('degraded pool produces a visible error notice naming the cause', () => {
  const notice = describePoolHealth(
    computeHealth({ lastAuthoritativeAt: T0, errorCode: 'permission-denied', nowMs: T0 + 5 * MIN }),
    T0 + 5 * MIN,
  );
  assert.ok(notice, 'a degraded pool must never render silently');
  assert.equal(notice.severity, 'error');
  assert.match(notice.detail, /permission-denied/);
  assert.match(notice.title, /Not updating/i);
});

test('a healthy, fresh pool shows no banner', () => {
  const notice = describePoolHealth(
    computeHealth({ lastAuthoritativeAt: T0, errorCode: null, nowMs: T0 + 5_000 }),
    T0 + 5_000,
  );
  assert.equal(notice, null);
});

test('a healthy but aged snapshot still warns — a silent stall is caught', () => {
  const at = T0 + STALE_AFTER_MS + 1000;
  const notice = describePoolHealth(
    computeHealth({ lastAuthoritativeAt: T0, errorCode: null, nowMs: at }), at,
  );
  assert.ok(notice);
  assert.equal(notice.severity, 'warning');
  assert.match(notice.title, /stale/i);
});

test('a total failure with no data ever loaded is reported as an error', () => {
  const notice = describePoolHealth(
    computeHealth({ lastAuthoritativeAt: null, errorCode: 'permission-denied', nowMs: T0 }), T0,
  );
  assert.ok(notice);
  assert.equal(notice.severity, 'error');
  assert.match(notice.title, /unavailable/i);
});

test('the very first load in flight is not reported as an error', () => {
  const notice = describePoolHealth(
    computeHealth({ lastAuthoritativeAt: null, errorCode: null, nowMs: T0 }), T0,
  );
  assert.equal(notice, null);
});

// ── 8. company isolation ────────────────────────────────────────────────────

test('only wells present in the projected config are rendered', () => {
  // The server projects the caller's catalog. A status row for a well outside
  // that projection must not leak onto the screen.
  const rows = buildWellRows({
    wellConfig: { 'Gabriel 1': { route: 'Gabriels', avgFlowRateMinutes: 360.56 } },
    wellStatus: {
      'Gabriel 1': {
        wellName: 'Gabriel 1', currentLevel: "2'7\"", lastPullBottomLevel: "2'7\"",
        lastPullDateTimeUTC: '2026-08-20T17:42:02.991Z',
      },
      'OtherCo Well 9': {
        wellName: 'OtherCo Well 9', currentLevel: "9'9\"", lastPullBottomLevel: "9'9\"",
        lastPullDateTimeUTC: '2026-08-20T17:42:02.991Z',
      },
    },
    nowMs: T0 + 60 * MIN,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wellName, 'Gabriel 1');
  assert.ok(!rows.some((r) => r.wellName === 'OtherCo Well 9'), 'foreign well leaked');
});

test('an empty projection renders nothing rather than everything', () => {
  const rows = buildWellRows({
    wellConfig: {},
    wellStatus: { 'Gabriel 1': { wellName: 'Gabriel 1', currentLevel: "2'7\"" } },
    nowMs: T0,
  });
  assert.deepEqual(rows, []);
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('feet/inches round-trip', () => {
  assert.equal(parseFeetInchesStr("2'7\""), 31);
  assert.equal(parseFeetInchesStr("10'11\""), 131);
  assert.equal(parseFeetInchesStr(''), 0);
  assert.equal(parseFeetInchesStr(undefined), 0);
  assert.equal(parseFeetInchesStr('garbage'), 0);
  assert.equal(inchesToDisplay(31), "2'7\"");
  assert.equal(inchesToDisplay(131), "10'11\"");
});

test('routes sort with Unrouted last', () => {
  assert.deepEqual(
    routesFromRows([{ route: 'Unrouted' }, { route: 'Watford' }, { route: 'Gabriels' }]),
    ['Gabriels', 'Watford', 'Unrouted'],
  );
});

test('error codes are extracted from both shapes', () => {
  assert.equal(errorCodeOf({ code: 'permission-denied' }), 'permission-denied');
  assert.equal(errorCodeOf(new Error('boom')), 'boom');
  assert.equal(errorCodeOf(null), 'unknown');
});

test('age formatting', () => {
  assert.equal(formatAge(null), 'never');
  assert.equal(formatAge(45_000), '45s');
  assert.equal(formatAge(6 * MIN), '6m');
  assert.equal(formatAge(2 * 60 * MIN), '2h');
});
