/**
 * WB‑M vc58 LIVE-LEVEL PARITY classification tests (fixed clocks; no Firebase).
 *
 * The estimated current level is the single source of truth for badge, column,
 * filters, TTP, counts, and sorting. estimate = startingBottom + minutesSincePull
 * / flowMinutesPerFoot (cap 20'); readyLevel = allowedBottom + loadBbls/bblsPerFoot;
 * Needs Pull = est >= readyLevel; Next 24h = predictedReadyAt within 24h. No 48h
 * rejection. Includes DTC's three verified vectors A/B/C.
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/dispatchPriority.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWell, formatTTP, matchesView, wellBucket, hasValidPrediction, inchesToLevel,
} from '../dispatchPriority.ts';

const BASE = Date.UTC(2026, 8, 14, 0, 0, 0);
const at = (h: number, m = 0) => new Date(BASE + h * 3600_000 + m * 60_000).toISOString();
const ms = (h: number, m = 0) => BASE + h * 3600_000 + m * 60_000;
const w = (o: Record<string, unknown>) => o as never;

// ── DTC VERIFIED VECTORS ───────────────────────────────────────────────────
test('VECTOR A: bottom 5\', pull 16:00Z, AFR 0:30:00, asOf 18:00Z → est 9\', target 10\', readyAt 18:30Z, APPROACHING', () => {
  const well = w({ lastPullBottomLevel: "5'", lastPullDateTimeUTC: at(16), flowRate: '0:30:00', bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 });
  const c = classifyWell(well, ms(18));
  assert.equal(c.estDisplay, "9'");
  assert.equal(c.estFeet, 9);
  assert.equal(c.readyFeet, 10);           // 3 + 140/20
  assert.equal(c.state, 'approaching');
  assert.equal(c.predictedReadyAtMs, ms(18, 30)); // 16:00 + (10-5)*30min
  assert.equal(matchesView(well, 'next-24h', ms(18)), true);
});

test('VECTOR B: bottom 18\'6", pull 17:00Z, AFR 0:15:00, asOf 18:00Z → capped 20\', ready now, PULL NOW (target 17\')', () => {
  const well = w({ lastPullBottomLevel: "18'6\"", lastPullDateTimeUTC: at(17), flowRate: '0:15:00', bottomLevel: 3, pullBbls: 280, bblPerFoot: 20 });
  const c = classifyWell(well, ms(18));
  assert.equal(c.estDisplay, "20'");       // 18.5 + 60/15 = 22.5 → cap 20
  assert.equal(c.estFeet, 20);
  assert.equal(c.readyFeet, 17);           // 3 + 280/20 (two 140-bbl loads over a 3' bottom at 20 bbl/ft)
  assert.equal(c.state, 'pull-now');
  assert.equal(matchesView(well, 'needs-pull', ms(18)), true);
  assert.ok(c.predictedReadyAtMs !== null && c.predictedReadyAtMs <= ms(18), 'ready time is now/past');
});

test('VECTOR C: bottom 6\'7", pull 15:00Z, AFR 1:16:00, asOf 18:00Z, Well Down → stays 6\'7", no ready time, DOWN', () => {
  const well = w({ lastPullBottomLevel: "6'7\"", lastPullDateTimeUTC: at(15), flowRate: '1:16:00', wellDown: true, bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 });
  const c = classifyWell(well, ms(18));
  assert.equal(c.estDisplay, "6'7\"");     // frozen at baseline
  assert.equal(c.state, 'down');
  assert.equal(c.predictedReadyAtMs, null);
});

// ── REQUIRED BEHAVIORS ──────────────────────────────────────────────────────
test('crossing the target changes Needs Pull', () => {
  const well = w({ lastPullBottomLevel: "5'", lastPullDateTimeUTC: at(16), flowRate: '0:30:00', bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 }); // target 10'
  assert.equal(matchesView(well, 'needs-pull', ms(18)), false);       // est 9' < 10'
  assert.equal(matchesView(well, 'needs-pull', ms(18, 30)), true);    // est 10' at 18:30
});

test('time alone advances the estimate WITHOUT mutating stored inputs', () => {
  const well = w({ lastPullBottomLevel: "5'", lastPullDateTimeUTC: at(16), flowRate: '0:30:00', bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 });
  const snapshot = JSON.stringify(well);
  const e18 = classifyWell(well, ms(18)).estFeet;
  const e19 = classifyWell(well, ms(19)).estFeet;
  assert.equal(e18, 9); assert.equal(e19, 11);
  assert.equal(JSON.stringify(well), snapshot, 'input object never mutated');
});

test('absolute predicted ready time is STABLE across later UI ticks', () => {
  const well = w({ lastPullBottomLevel: "5'", lastPullDateTimeUTC: at(16), flowRate: '0:30:00', bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 });
  const r1 = classifyWell(well, ms(18)).predictedReadyAtMs;
  const r2 = classifyWell(well, ms(18, 20)).predictedReadyAtMs;
  const r3 = classifyWell(well, ms(20)).predictedReadyAtMs;
  assert.equal(r1, ms(18, 30)); assert.equal(r1, r2); assert.equal(r2, r3);
});

test('new pull inputs replace the forecast basis', () => {
  const oldW = w({ lastPullBottomLevel: "5'", lastPullDateTimeUTC: at(16), flowRate: '0:30:00', bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 });
  const newW = w({ lastPullBottomLevel: "3'", lastPullDateTimeUTC: at(17, 30), flowRate: '0:30:00', bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 });
  assert.equal(classifyWell(oldW, ms(18)).estFeet, 9);
  assert.equal(classifyWell(newW, ms(18)).estFeet, 4);   // 3 + 30/30
  assert.notEqual(classifyWell(oldW, ms(18)).predictedReadyAtMs, classifyWell(newW, ms(18)).predictedReadyAtMs);
});

test('duplicate/identical status is idempotent (pure function of the snapshot)', () => {
  const well = w({ lastPullBottomLevel: "5'", lastPullDateTimeUTC: at(16), flowRate: '0:30:00', bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 });
  assert.deepEqual(classifyWell(well, ms(18)), classifyWell(well, ms(18)));
});

test('missing/corrupt flow FREEZES at baseline (no fake rise, no urgency)', () => {
  for (const bad of ['Unknown', '', '0:00:00', 'Ready']) {
    const well = w({ lastPullBottomLevel: "6'", lastPullDateTimeUTC: at(10), flowRate: bad, bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 });
    const c = classifyWell(well, ms(18));
    assert.equal(c.estDisplay, "6'", `flow=${bad} freezes`);
    assert.equal(c.hasFlow, false);
    assert.equal(c.state, 'no-gain');         // below target 10', no forecast
    assert.equal(c.predictedReadyAtMs, null);
  }
});

test('Overnight/window bbl-day NEVER change the displayed feet', () => {
  const bare = w({ lastPullBottomLevel: "5'", lastPullDateTimeUTC: at(16), flowRate: '0:30:00', bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 });
  const withOvernight = w({ ...(bare as object), overnightBblsDay: '9999', windowBblsDay: '9999', bbls24hrs: '9999' });
  assert.equal(classifyWell(withOvernight, ms(18)).estDisplay, classifyWell(bare, ms(18)).estDisplay);
});

test('Down never rises even with old pull + fast flow', () => {
  const well = w({ lastPullBottomLevel: "4'", lastPullDateTimeUTC: at(0), flowRate: '0:05:00', wellDown: true, bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 });
  assert.equal(classifyWell(well, ms(23)).estDisplay, "4'");
});

test('no 48h rejection: an old valid basis still forecasts (does not become NEEDS DATA by age)', () => {
  const oldBase = new Date(BASE - 200 * 3600_000).toISOString(); // 200h before
  const well = w({ lastPullBottomLevel: "5'", lastPullDateTimeUTC: oldBase, flowRate: '0:30:00', bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 });
  const c = classifyWell(well, ms(0));
  assert.notEqual(c.state, 'verify');   // NOT NEEDS DATA merely for being old
  assert.equal(c.state, 'pull-now');    // 5 + 200*60/30 huge → capped 20 ≥ 10
});

test('missing baseline / timestamp is genuinely unavailable (never zero)', () => {
  assert.equal(classifyWell(w({ flowRate: '0:30:00', bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 }), ms(18)).reason, 'missing_baseline');
  assert.equal(classifyWell(w({ lastPullBottomLevel: "5'", flowRate: '0:30:00', bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 }), ms(18)).reason, 'missing_timestamp');
  assert.equal(classifyWell(w({ lastPullBottomLevel: "5'", flowRate: '0:30:00', bottomLevel: 3, pullBbls: 140, bblPerFoot: 20 }), ms(18)).estDisplay, '--'); // not "0'"
});

test('badge, column, filter, TTP, bucket, and prediction all consume the SAME estimate', () => {
  const well = w({ lastPullBottomLevel: "18'6\"", lastPullDateTimeUTC: at(17), flowRate: '0:15:00', bottomLevel: 3, pullBbls: 280, bblPerFoot: 20 });
  const c = classifyWell(well, ms(18));
  assert.equal(c.label, 'PULL NOW');                         // badge
  assert.equal(c.estDisplay, "20'");                         // column
  assert.equal(matchesView(well, 'needs-pull', ms(18)), true); // filter
  assert.equal(formatTTP(well, ms(18)), 'PULL NOW');          // TTP
  assert.equal(wellBucket(well, ms(18)), 'needs-pull');       // counts
  assert.equal(hasValidPrediction(well, ms(18)), true);
  // assigned overrides to ASSIGNED and drops from actionable views
  assert.equal(classifyWell(well, ms(18), { assigned: true }).state, 'assigned');
  assert.equal(matchesView(well, 'needs-pull', ms(18), { assigned: true }), false);
});

test('inchesToLevel unchanged (legacy helper)', () => {
  assert.equal(inchesToLevel(90), "7'6\"");
  assert.equal(inchesToLevel(null), '--');
});
