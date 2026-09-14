/**
 * WB‑M vc58 estimator unit tests (pure; fixed clocks).
 * Run: node --test --experimental-strip-types src/lib/__tests__/wbmLevelEstimator.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFeetDecimal, parseFlowMinutesPerFoot, formatFeetWBM,
  estimateCurrentFeet, readyLevelFeet, predictedReadyAtMs, MAX_LEVEL_FEET,
} from '../wbmLevelEstimator.ts';

test('parseFeetDecimal', () => {
  assert.equal(parseFeetDecimal("5'"), 5);
  assert.equal(parseFeetDecimal("18'6\""), 18.5);
  assert.equal(parseFeetDecimal("6'7\""), 6 + 7 / 12);
  assert.equal(parseFeetDecimal('9'), 9);
  assert.equal(parseFeetDecimal('--'), null);
  assert.equal(parseFeetDecimal('DOWN'), null);
  assert.equal(parseFeetDecimal(null), null);
});

test('parseFlowMinutesPerFoot (H:MM:SS = minutes per foot)', () => {
  assert.equal(parseFlowMinutesPerFoot('0:30:00'), 30);
  assert.equal(parseFlowMinutesPerFoot('0:15:00'), 15);
  assert.equal(parseFlowMinutesPerFoot('1:16:00'), 76);
  assert.equal(parseFlowMinutesPerFoot('0:00:00'), null); // non-positive → invalid
  assert.equal(parseFlowMinutesPerFoot('Unknown'), null);
  assert.equal(parseFlowMinutesPerFoot(''), null);
});

test('formatFeetWBM: floor(feet*12+0.0001), omit zero inches, cap 20', () => {
  assert.equal(formatFeetWBM(9), "9'");
  assert.equal(formatFeetWBM(7.5), "7'6\"");
  assert.equal(formatFeetWBM(6 + 7 / 12), "6'7\"");   // epsilon guards the float
  assert.equal(formatFeetWBM(22.5), "20'");           // cap
  assert.equal(formatFeetWBM(20), "20'");
  assert.equal(formatFeetWBM(null), '--');
});

test('estimateCurrentFeet: rise, cap, freeze', () => {
  const pull = Date.UTC(2026, 8, 14, 16);
  const asOf = Date.UTC(2026, 8, 14, 18);
  // A: 5 + 120/30 = 9
  assert.deepEqual(estimateCurrentFeet({ startingBottomFeet: 5, pullTimeMs: pull, flowMinutesPerFoot: 30, wellDown: false }, asOf).feet, 9);
  // cap at 20
  assert.equal(estimateCurrentFeet({ startingBottomFeet: 18.5, pullTimeMs: Date.UTC(2026, 8, 14, 17), flowMinutesPerFoot: 15, wellDown: false }, asOf).feet, MAX_LEVEL_FEET);
  // down → freeze at baseline
  const down = estimateCurrentFeet({ startingBottomFeet: 6 + 7 / 12, pullTimeMs: pull, flowMinutesPerFoot: 76, wellDown: true }, asOf);
  assert.equal(down.frozen, true); assert.equal(formatFeetWBM(down.feet), "6'7\"");
  // no flow → freeze
  const noflow = estimateCurrentFeet({ startingBottomFeet: 6, pullTimeMs: pull, flowMinutesPerFoot: null, wellDown: false }, asOf);
  assert.equal(noflow.hasFlow, false); assert.equal(noflow.feet, 6);
  // no baseline → null (never zero)
  assert.equal(estimateCurrentFeet({ startingBottomFeet: null, pullTimeMs: pull, flowMinutesPerFoot: 30, wellDown: false }, asOf).feet, null);
});

test('readyLevelFeet = allowedBottom + loadBbls/bblsPerFoot', () => {
  assert.equal(readyLevelFeet({ allowedBottomFeet: 3, loadBbls: 140, bblsPerFoot: 20 }), 10);
  assert.equal(readyLevelFeet({ allowedBottomFeet: 3, loadBbls: 280, bblsPerFoot: 20 }), 17);
  assert.equal(readyLevelFeet({ allowedBottomFeet: null, loadBbls: 140, bblsPerFoot: 20 }), null);
  assert.equal(readyLevelFeet({ allowedBottomFeet: 3, loadBbls: 140, bblsPerFoot: 0 }), null);
});

test('predictedReadyAtMs: pull + (ready-bottom)*flow*60000', () => {
  const pull = Date.UTC(2026, 8, 14, 16);
  assert.equal(
    predictedReadyAtMs({ startingBottomFeet: 5, pullTimeMs: pull, flowMinutesPerFoot: 30, wellDown: false }, 10),
    Date.UTC(2026, 8, 14, 18, 30),
  );
  assert.equal(predictedReadyAtMs({ startingBottomFeet: 5, pullTimeMs: pull, flowMinutesPerFoot: 30, wellDown: true }, 10), null);
  assert.equal(predictedReadyAtMs({ startingBottomFeet: 5, pullTimeMs: pull, flowMinutesPerFoot: null, wellDown: false }, 10), null);
});
