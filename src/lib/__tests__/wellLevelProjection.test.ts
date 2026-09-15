// wellLevelProjection acceptance tests.
//
// Proves the ONE shared current-level projection that /mobile, /well, the Dispatch
// queue and the Assign/Reassign modals all consume produces the IDENTICAL current
// estimate from ONE governed response at ONE clock instant — and that it behaves
// correctly across time advancement, new pull / corrected edit / flow change,
// DOWN aliases, missing/invalid/pre-2020 timestamps, and never fabricates a value.
//
// The fixture is a REAL governed row: it is built through mergeWellPool from a
// sample adminGetWellPool-shaped payload (wellConfig + wellStatus), exactly as the
// live surfaces obtain their rows — not a hand-authored WellResponse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWellPool } from '../wellPoolCore.ts';
import { projectWellLevel, wbmInputsFromWell } from '../wellLevelProjection.ts';
import { classifyWell } from '../dispatchPriority.ts';

const PULL_ISO = '2026-09-14T00:00:00.000Z';
const PULL_MS = Date.parse(PULL_ISO);
const MIN = 60_000;

// A real governed row: bottom-after-pull 4'0", pull at PULL_ISO, flow 6h/foot
// (360 min/ft), allowed bottom 3', 1 tank, 20 bbl/ft, load default → readyLevel 10'.
// currentLevel is the STALE stored reading ("4'4\"") — it must never be the basis.
function row(overrides: {
  config?: Record<string, unknown>;
  status?: Record<string, unknown>;
} = {}) {
  const wellConfig = {
    'Gabriel 2': {
      route: 'R1', tanks: 1, pullBbls: 140, bottomLevel: 3, bblPerFoot: 20,
      avgFlowRate: '6:00:00',
      ...(overrides.config || {}),
    },
  };
  const wellStatus = {
    'Gabriel 2': {
      currentLevel: "4'4\"",           // stale stored reading — NOT the baseline
      lastPullBottomLevel: "4'0\"",    // immutable raw baseline = 4.0 ft
      lastPullDateTimeUTC: PULL_ISO,
      timestampUTC: PULL_ISO,
      flowRate: '6:00:00',             // 360 min/ft
      wellDown: false,
      ...(overrides.status || {}),
    },
  };
  return mergeWellPool(wellConfig, wellStatus)[0];
}

// classifyWell needs bottomLevel numeric on the row (mergeWellPool provides it).
const classifyOpts = {};

test('ONE governed response → identical current estimate across every surface at one instant', () => {
  const w = row();
  const asOf = PULL_MS + 180 * MIN; // +3h → 4.0 + 180/360 = 4.5 ft → 4'6"
  const proj = projectWellLevel(w, asOf);
  const cls = classifyWell(w, asOf, classifyOpts);
  assert.equal(proj.estDisplay, "4'6\"");
  // The Dispatch queue (classifyWell) and the pages/modals (projectWellLevel) agree
  // BYTE-FOR-BYTE because both resolve inputs via wbmInputsFromWell and format via
  // formatFeetWBM off the same estimator.
  assert.equal(proj.estDisplay, cls.estDisplay);
  assert.equal(proj.estFeet, 4.5);
});

test('reproduces the Gabriel-2 mismatch: modal now shows the queue estimate, not the stale 4\'4"', () => {
  const w = row();
  // Advance until the estimate is 10'2" (past the 10' ready target).
  const asOf = PULL_MS + 2220 * MIN; // 4.0 + 2220/360 = 10.1667 ft → 10'2"
  const proj = projectWellLevel(w, asOf);
  const cls = classifyWell(w, asOf, classifyOpts);
  assert.equal(proj.estDisplay, "10'2\"");
  assert.equal(cls.estDisplay, "10'2\"");
  // The stale stored reading must NOT be what any current-level surface shows.
  assert.notEqual(proj.estDisplay, w.currentLevel);   // w.currentLevel === "4'4\""
});

test('display advances with time WITHOUT a new packet — and never compounds', () => {
  const w = row();
  const t1 = PULL_MS + 180 * MIN;  // 4.5 ft
  const t2 = PULL_MS + 360 * MIN;  // 5.0 ft
  const e1 = projectWellLevel(w, t1).estFeet!;
  const e2 = projectWellLevel(w, t2).estFeet!;
  assert.equal(e1, 4.5);
  assert.equal(e2, 5.0);
  // Growth over the interval equals elapsed/flow exactly (0.5 ft), and e2 is
  // base + total elapsed / flow — NOT e1 used as a new baseline (no compounding).
  assert.equal(e2 - e1, 0.5);
  assert.equal(e2, 4.0 + (360 * MIN) / MIN / 360);
});

test('predictedReadyAt is deterministic — it does not move as the clock advances', () => {
  const w = row();
  const a = classifyWell(w, PULL_MS + 10 * MIN, classifyOpts).predictedReadyAtMs;
  const b = classifyWell(w, PULL_MS + 5000 * MIN, classifyOpts).predictedReadyAtMs;
  assert.notEqual(a, null);
  assert.equal(a, b);
  // ready 10', base 4', flow 360 min/ft → pull + 6*360*60000.
  assert.equal(a, PULL_MS + 6 * 360 * MIN);
});

test('a NEW pull resets the basis immediately', () => {
  const later = '2026-09-14T12:00:00.000Z';
  const w = row({ status: { lastPullBottomLevel: "3'0\"", lastPullDateTimeUTC: later } });
  const proj = projectWellLevel(w, Date.parse(later)); // at the new pull instant
  assert.equal(proj.estFeet, 3.0);                     // reset to the new bottom
  assert.equal(proj.estDisplay, "3'");
});

test('a corrected pull timestamp rebuilds the basis', () => {
  const corrected = '2026-09-13T18:00:00.000Z'; // 6h earlier than original
  const w = row({ status: { lastPullDateTimeUTC: corrected } });
  const asOf = Date.parse(corrected) + 360 * MIN;      // +6h from the corrected time
  assert.equal(projectWellLevel(w, asOf).estFeet, 5.0);
});

test('a flow/AFR change changes the rise', () => {
  const w = row({ status: { flowRate: '3:00:00' } }); // 180 min/ft (twice as fast)
  const asOf = PULL_MS + 180 * MIN;
  assert.equal(projectWellLevel(w, asOf).estFeet, 5.0); // 4.0 + 180/180 = 5.0
});

test('DOWN / offline / shut-in freeze at the baseline (never a rising estimate)', () => {
  for (const status of [
    { wellDown: true },
    { currentLevel: 'offline' },
    { currentLevel: 'shut in' },
    { currentLevel: 'DOWN' },
  ]) {
    const w = row({ status });
    const proj = projectWellLevel(w, PULL_MS + 5000 * MIN);
    assert.equal(proj.wellDown, true, JSON.stringify(status));
    assert.equal(proj.frozen, true, JSON.stringify(status));
    assert.equal(proj.estFeet, 4.0, JSON.stringify(status)); // frozen at raw bottom
    assert.equal(proj.available, true, JSON.stringify(status));
  }
});

test('missing baseline → unavailable "--", never zero', () => {
  const w = row({ status: { lastPullBottomLevel: undefined, currentLevel: '--' } });
  const proj = projectWellLevel(w, PULL_MS + 180 * MIN);
  assert.equal(proj.available, false);
  assert.equal(proj.estDisplay, '--');
  assert.notEqual(proj.estDisplay, "0'");
  assert.equal(proj.estFeet, null);
  // Parity: the queue is also unavailable, not zero.
  assert.equal(classifyWell(w, PULL_MS + 180 * MIN, classifyOpts).estDisplay, '--');
});

test('invalid and pre-2020 timestamps → unavailable "--" for a live well (never zero)', () => {
  for (const ts of ['not-a-date', '2019-12-31T23:59:59.000Z', '1899-12-30T00:00:00.000Z']) {
    const w = row({ status: { lastPullDateTimeUTC: ts, timestampUTC: ts } });
    const inp = wbmInputsFromWell(w);
    assert.equal(inp.pullTimeMs, null, ts);
    const proj = projectWellLevel(w, PULL_MS + 180 * MIN);
    assert.equal(proj.available, false, ts);
    assert.equal(proj.estDisplay, '--', ts);
    assert.equal(classifyWell(w, PULL_MS + 180 * MIN, classifyOpts).estDisplay, '--', ts);
  }
});

test('the projection NEVER uses the stale stored currentLevel as its baseline', () => {
  // currentLevel is a wildly wrong 19' but the raw last-pull bottom is 4' — the
  // estimate must anchor on 4', proving no currentLevel fallback (compounding guard).
  const w = row({ status: { currentLevel: "19'0\"" } });
  assert.equal(projectWellLevel(w, PULL_MS).estFeet, 4.0);
  assert.equal(wbmInputsFromWell(w).startingBottomFeet, 4.0);
});

test('the estimate caps at 20 feet (WB-M FULL_TANK_FEET)', () => {
  const w = row();
  const proj = projectWellLevel(w, PULL_MS + 100000 * MIN); // far future
  assert.equal(proj.estFeet, 20);
  assert.equal(proj.capped, true);
  assert.equal(proj.estDisplay, "20'");
});

test('numeric and string flow-rate inputs produce identical estimates (string is canonical)', () => {
  // The governed row carries flow as the "H:MM:SS" STRING. Prove the string parse
  // (parseFlowMinutesPerFoot) yields the same minutes/foot a numeric config field
  // (avgFlowRateMinutes) would, and that the estimate equals the hand-computed
  // numeric result — so migrating off the numeric-only builder changes nothing.
  const NUMERIC_MIN_PER_FT = 360; // what avgFlowRateMinutes would have held
  const w = row({ status: { flowRate: '6:00:00' } });
  assert.equal(wbmInputsFromWell(w).flowMinutesPerFoot, NUMERIC_MIN_PER_FT);
  const asOf = PULL_MS + 240 * MIN;
  const expectedFeet = 4.0 + 240 / NUMERIC_MIN_PER_FT; // base + elapsed/(min per ft)
  assert.equal(projectWellLevel(w, asOf).estFeet, expectedFeet);
});

test('missing FLOW → frozen at the last reading (never zero, never a fake rise)', () => {
  for (const flowRate of [undefined, '--', 'Unknown', '0:00:00']) {
    // Neutralize the catalog avgFlowRate fallback so `undefined` truly means no flow.
    const w = row({ config: { avgFlowRate: 'Unknown' }, status: { flowRate } });
    const proj = projectWellLevel(w, PULL_MS + 5000 * MIN);
    assert.equal(proj.available, true, String(flowRate));   // baseline is known
    assert.equal(proj.hasFlow, false, String(flowRate));    // cannot forecast a rise
    assert.equal(proj.frozen, true, String(flowRate));
    assert.equal(proj.estFeet, 4.0, String(flowRate));      // frozen at baseline, NOT 0
    assert.notEqual(proj.estDisplay, "0'", String(flowRate));
  }
});

test('DOWN wells are frozen identically on the queue (classifyWell) and pages (projectWellLevel)', () => {
  const w = row({ status: { wellDown: true } });
  const asOf = PULL_MS + 5000 * MIN;
  const proj = projectWellLevel(w, asOf);
  const cls = classifyWell(w, asOf, classifyOpts);
  assert.equal(cls.state, 'down');
  assert.equal(proj.estDisplay, cls.estDisplay); // same frozen baseline string
  assert.equal(proj.estDisplay, "4'");
});

test('clock passage does not reorder absolute predicted-ready results', () => {
  // Two wells with different pull times / flows → different absolute ready times.
  // Their relative order must be identical at any asOfMs (ordering is by the
  // deterministic predictedReadyAtMs, not by anything the clock changes).
  const slow = row({ status: { flowRate: '9:00:00' } }); // slower rise → later ready
  const fast = row({ status: { flowRate: '3:00:00' } }); // faster rise → earlier ready
  const at = (t: number) => [slow, fast]
    .map(w => ({ w, r: classifyWell(w, t, classifyOpts).predictedReadyAtMs }))
    .sort((a, b) => (a.r ?? Infinity) - (b.r ?? Infinity))
    .map(x => x.w);
  const orderEarly = at(PULL_MS + 1 * MIN);
  const orderLate = at(PULL_MS + 100000 * MIN);
  assert.equal(orderEarly[0], fast);              // fast is ready first, always
  assert.deepEqual(orderEarly, orderLate);        // order stable across the clock
});
