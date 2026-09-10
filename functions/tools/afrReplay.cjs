/**
 * AFR v1 vs v2 — READ-ONLY replay/shadow over real packets/processed.
 * No writes, no deploy. Compares one-step-ahead prediction error and final AFR.
 *
 * Usage: node tools/afrReplay.cjs <path-to-all-processed.json>
 */
const fs = require('fs');
const { computeAfrV1FromRates } = require('../lib/afr/afrV1.js');
const { computeAfrV2 } = require('../lib/afr/afrV2.js');
const { AFR_V2_POLICY } = require('../lib/afr/afrV2Policy.js');

const path = process.argv[2];
const raw = JSON.parse(fs.readFileSync(path, 'utf8')) || {};

// Group processed packets by well (mirror calculateAFR's intake filters).
const byWell = new Map();
for (const [key, d] of Object.entries(raw)) {
  if (!d || typeof d !== 'object') continue;
  if (key.startsWith('edit_') || key.startsWith('delete_') || key.startsWith('history_')) continue;
  if (!(d.flowRateDays > 0)) continue;
  let ts = d.dateTimeUTC ? Date.parse(d.dateTimeUTC)
    : d.gaugeTime ? Date.parse(d.gaugeTime)
    : d.dateTime ? Date.parse(d.dateTime) : 0;
  if (Number.isNaN(ts)) ts = 0;
  const w = d.wellName || '(unknown)';
  if (!byWell.has(w)) byWell.set(w, []);
  byWell.get(w).push({
    key, timestamp: ts, rate: d.flowRateDays,
    topLevelFeet: typeof d.tankLevelFeet === 'number' ? d.tankLevelFeet : undefined,
    bblsTaken: typeof d.bblsTaken === 'number' ? d.bblsTaken : undefined,
  });
}

const P = AFR_V2_POLICY;
let totalWells = 0, comparedWells = 0;
let sumAbsV1 = 0, sumAbsV2 = 0, nPred = 0;
let v2Better = 0, v1Better = 0, tie = 0;
let regimeWells = 0, invalidIntervals = 0, lowConfIntervals = 0, totalIntervals = 0;
const perWell = [];

for (const [well, entriesRaw] of byWell) {
  totalWells++;
  const entries = entriesRaw.sort((a, b) => a.timestamp - b.timestamp);
  if (entries.length < 5) continue; // need history to backtest
  comparedWells++;

  let wV1 = 0, wV2 = 0, wN = 0, wRegime = false;
  // One-step-ahead: predict entry i from history [0..i-1].
  for (let i = 4; i < entries.length; i++) {
    const hist = entries.slice(0, i);
    const actual = entries[i].rate;
    const v1 = computeAfrV1FromRates(hist.map(e => e.rate));
    const intervals = hist.map((e, j) => ({
      key: e.key, timestamp: e.timestamp, flowRateDays: e.rate,
      intervalMs: j > 0 ? e.timestamp - hist[j - 1].timestamp : undefined,
      topLevelFeet: e.topLevelFeet, priorTopLevelFeet: j > 0 ? hist[j - 1].topLevelFeet : undefined,
      bblsTaken: e.bblsTaken, bblPerFoot: 20,
    }));
    const res = computeAfrV2(intervals, P);
    if (v1 > 0 && actual > 0) { sumAbsV1 += Math.abs(v1 - actual); wV1 += Math.abs(v1 - actual); }
    if (res.afr > 0 && actual > 0) { sumAbsV2 += Math.abs(res.afr - actual); wV2 += Math.abs(res.afr - actual); }
    if (v1 > 0 && res.afr > 0 && actual > 0) { nPred++; wN++; }
    if (res.regimeAccepted) wRegime = true;
  }

  // Final-state diagnostics on the full series.
  const allIntervals = entries.map((e, j) => ({
    key: e.key, timestamp: e.timestamp, flowRateDays: e.rate,
    intervalMs: j > 0 ? e.timestamp - entries[j - 1].timestamp : undefined,
    topLevelFeet: e.topLevelFeet, priorTopLevelFeet: j > 0 ? entries[j - 1].topLevelFeet : undefined,
    bblsTaken: e.bblsTaken, bblPerFoot: 20,
  }));
  const finalV2 = computeAfrV2(allIntervals, P);
  const finalV1 = computeAfrV1FromRates(entries.map(e => e.rate));
  totalIntervals += finalV2.perInterval.length;
  invalidIntervals += finalV2.perInterval.filter(p => !p.validity.valid).length;
  lowConfIntervals += finalV2.perInterval.filter(p => p.validity.valid && p.weight < 0.5).length;
  if (finalV2.regimeAccepted) regimeWells++;
  if (wRegime) {} // per-well regime seen during backtest

  const maeV1 = wN ? wV1 / wN : 0, maeV2 = wN ? wV2 / wN : 0;
  if (wN >= 3) {
    if (maeV2 < maeV1 * 0.999) v2Better++;
    else if (maeV1 < maeV2 * 0.999) v1Better++;
    else tie++;
  }
  perWell.push({ well, n: entries.length, preds: wN, maeV1, maeV2, finalV1, finalV2: finalV2.afr, regime: finalV2.regimeAccepted });
}

const maeV1 = nPred ? sumAbsV1 / nPred : 0;
const maeV2 = nPred ? sumAbsV2 / nPred : 0;

console.log('===== AFR v1 vs v2 — read-only replay (no writes) =====');
console.log(`wells total: ${totalWells}  | backtested (>=5 pulls): ${comparedWells}`);
console.log(`one-step-ahead predictions compared: ${nPred}`);
console.log(`MAE (days/ft)  v1=${maeV1.toFixed(5)}  v2=${maeV2.toFixed(5)}  ` +
  `→ v2 ${maeV2 < maeV1 ? 'LOWER (better)' : maeV2 > maeV1 ? 'higher (worse)' : 'equal'} by ${(Math.abs(maeV1 - maeV2)).toFixed(5)} (${maeV1 ? ((maeV2 - maeV1) / maeV1 * 100).toFixed(1) : '—'}%)`);
console.log(`per-well winner (>=3 preds):  v2 better=${v2Better}  v1 better=${v1Better}  tie=${tie}`);
console.log(`v2 interval classification: total=${totalIntervals}  invalid(0.0)=${invalidIntervals}  valid-but-low-weight(<0.5)=${lowConfIntervals}`);
console.log(`wells where v2 accepted a sustained regime change: ${regimeWells}`);
console.log('');
console.log('WASHOUT WINDOWS: no explicit washout/hot-oiler/maintenance event exists in production');
console.log('  → post-washout Days 1-3 error is NOT computable and is NOT inferred (event capture required).');
console.log('  → Anthony\'s specific tested wells are not identifiable from the data without guessing; none singled out.');
console.log('');
// Show the 8 wells with the largest v1→v2 improvement and 4 with the largest regression.
perWell.sort((a, b) => (a.maeV2 - a.maeV1) - (b.maeV2 - b.maeV1));
const fmt = (x) => x.toFixed(4);
console.log('Top wells where v2 improves one-step MAE:');
for (const w of perWell.filter(w => w.preds >= 3).slice(0, 8)) {
  console.log(`  ${w.well.padEnd(22)} n=${String(w.n).padStart(3)} preds=${String(w.preds).padStart(3)} maeV1=${fmt(w.maeV1)} maeV2=${fmt(w.maeV2)} finalV1=${fmt(w.finalV1)} finalV2=${fmt(w.finalV2)}${w.regime ? ' [regime]' : ''}`);
}
console.log('Wells where v2 regresses one-step MAE most:');
for (const w of perWell.filter(w => w.preds >= 3).slice(-4).reverse()) {
  console.log(`  ${w.well.padEnd(22)} n=${String(w.n).padStart(3)} preds=${String(w.preds).padStart(3)} maeV1=${fmt(w.maeV1)} maeV2=${fmt(w.maeV2)} finalV1=${fmt(w.finalV1)} finalV2=${fmt(w.finalV2)}${w.regime ? ' [regime]' : ''}`);
}
