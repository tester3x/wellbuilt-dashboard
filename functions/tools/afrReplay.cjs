/**
 * AFR v1 vs v2-HYBRID — READ-ONLY replay/shadow over real packets/processed.
 * No writes, no deploy. Reports per-well MAE distribution (median/p90), worst
 * regression, activation frequency, and reconciliation of the backtested set.
 *
 * Usage: node tools/afrReplay.cjs <path-to-all-processed.json>
 */
const fs = require('fs');
const { computeAfrV1FromRates } = require('../lib/afr/afrV1.js');
const { computeAfrHybrid } = require('../lib/afr/afrV2.js');
const { AFR_V2_POLICY } = require('../lib/afr/afrV2Policy.js');

const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) || {};
const P = AFR_V2_POLICY;

const byWell = new Map();
for (const [key, d] of Object.entries(raw)) {
  if (!d || typeof d !== 'object') continue;
  if (key.startsWith('edit_') || key.startsWith('delete_') || key.startsWith('history_')) continue;
  if (!(d.flowRateDays > 0)) continue;
  let ts = d.dateTimeUTC ? Date.parse(d.dateTimeUTC) : d.gaugeTime ? Date.parse(d.gaugeTime) : d.dateTime ? Date.parse(d.dateTime) : 0;
  if (Number.isNaN(ts)) ts = 0;
  const w = d.wellName || '(unknown)';
  if (!byWell.has(w)) byWell.set(w, []);
  byWell.get(w).push({ key, timestamp: ts, rate: d.flowRateDays, topLevelFeet: typeof d.tankLevelFeet === 'number' ? d.tankLevelFeet : undefined, bblsTaken: typeof d.bblsTaken === 'number' ? d.bblsTaken : undefined });
}

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

let totalWells = 0, backtested = 0, sumV1 = 0, sumV2 = 0, nPred = 0;
let stepsTotal = 0, stepsActivated = 0, wellsEverActivated = 0, passthroughExactV1 = 0;
const perWell = [];
const fewPred = [];

for (const [well, esRaw] of byWell) {
  totalWells++;
  const es = esRaw.sort((a, b) => a.timestamp - b.timestamp);
  if (es.length < 5) continue;
  backtested++;
  let wV1 = 0, wV2 = 0, wN = 0, wAct = 0, wSteps = 0;
  for (let i = 4; i < es.length; i++) {
    const hist = es.slice(0, i);
    const actual = es[i].rate;
    const v1 = computeAfrV1FromRates(hist.map((e) => e.rate));
    const intervals = hist.map((e, j) => ({ key: e.key, timestamp: e.timestamp, flowRateDays: e.rate, intervalMs: j > 0 ? e.timestamp - hist[j - 1].timestamp : undefined, topLevelFeet: e.topLevelFeet, priorTopLevelFeet: j > 0 ? hist[j - 1].topLevelFeet : undefined, bblsTaken: e.bblsTaken, bblPerFoot: 20 }));
    const h = computeAfrHybrid(intervals, P);
    wSteps++; stepsTotal++;
    if (h.activated) { wAct++; stepsActivated++; }
    if (v1 > 0 && h.afr > 0 && actual > 0) { sumV1 += Math.abs(v1 - actual); sumV2 += Math.abs(h.afr - actual); wV1 += Math.abs(v1 - actual); wV2 += Math.abs(h.afr - actual); nPred++; wN++; }
  }
  if (wAct > 0) wellsEverActivated++;
  const maeV1 = wN ? wV1 / wN : 0, maeV2 = wN ? wV2 / wN : 0;
  if (wN < 3) fewPred.push({ well, n: es.length, preds: wN });
  perWell.push({ well, n: es.length, preds: wN, maeV1, maeV2, delta: maeV2 - maeV1, actRate: wSteps ? wAct / wSteps : 0 });
}

// Byte-identical proof: non-activated final computations equal v1 exactly.
for (const [well, esRaw] of byWell) {
  const es = esRaw.sort((a, b) => a.timestamp - b.timestamp);
  if (es.length < 5) continue;
  const intervals = es.map((e, j) => ({ key: e.key, timestamp: e.timestamp, flowRateDays: e.rate, intervalMs: j > 0 ? e.timestamp - es[j - 1].timestamp : undefined, topLevelFeet: e.topLevelFeet, priorTopLevelFeet: j > 0 ? es[j - 1].topLevelFeet : undefined, bblsTaken: e.bblsTaken, bblPerFoot: 20 }));
  const h = computeAfrHybrid(intervals, P);
  if (!h.activated && h.afr === computeAfrV1FromRates(es.map((e) => e.rate))) passthroughExactV1++;
}

const withPreds = perWell.filter((w) => w.preds >= 3);
const deltas = withPreds.map((w) => w.delta);
let v2Better = 0, v1Better = 0, tie = 0;
for (const w of withPreds) { if (w.maeV2 < w.maeV1 - 1e-9) v2Better++; else if (w.maeV1 < w.maeV2 - 1e-9) v1Better++; else tie++; }
withPreds.sort((a, b) => b.delta - a.delta);

console.log('===== AFR v1 vs v2-HYBRID — read-only replay (no writes) =====');
console.log(`wells total: ${totalWells} | backtested (>=5 pulls): ${backtested} | one-step preds compared: ${nPred}`);
console.log(`AGGREGATE MAE (days/ft): v1=${(sumV1 / nPred).toFixed(5)}  v2=${(sumV2 / nPred).toFixed(5)}  (${((sumV2 - sumV1) / (sumV1) * 100).toFixed(1)}%)`);
console.log('');
console.log('PER-WELL MAE distribution (>=3 preds, n=' + withPreds.length + '):');
console.log(`  v1: median=${pct(withPreds.map((w) => w.maeV1), 0.5).toFixed(4)} p90=${pct(withPreds.map((w) => w.maeV1), 0.9).toFixed(4)} mean=${mean(withPreds.map((w) => w.maeV1)).toFixed(4)}`);
console.log(`  v2: median=${pct(withPreds.map((w) => w.maeV2), 0.5).toFixed(4)} p90=${pct(withPreds.map((w) => w.maeV2), 0.9).toFixed(4)} mean=${mean(withPreds.map((w) => w.maeV2)).toFixed(4)}`);
console.log(`  per-well winner: v2 better=${v2Better}  v1 better=${v1Better}  tie(identical)=${tie}`);
console.log('');
console.log(`ACTIVATION: ${stepsActivated}/${stepsTotal} backtest steps activated (${(stepsActivated / stepsTotal * 100).toFixed(1)}%); wells that ever activated: ${wellsEverActivated}/${backtested}`);
console.log(`BYTE-IDENTICAL: ${passthroughExactV1}/${backtested} wells' final AFR is v1_passthrough and === computeAfrV1FromRates exactly`);
console.log('');
console.log('WORST REGRESSIONS (v2 - v1, days/ft) — all should be activated wells:');
for (const w of withPreds.slice(0, 5)) console.log(`  ${w.well.padEnd(20)} delta=+${w.delta.toFixed(4)} maeV1=${w.maeV1.toFixed(4)} maeV2=${w.maeV2.toFixed(4)} activation=${(w.actRate * 100).toFixed(0)}%`);
console.log('BIGGEST IMPROVEMENTS (v1 - v2):');
for (const w of withPreds.slice(-5).reverse()) console.log(`  ${w.well.padEnd(20)} delta=${w.delta.toFixed(4)} maeV1=${w.maeV1.toFixed(4)} maeV2=${w.maeV2.toFixed(4)} activation=${(w.actRate * 100).toFixed(0)}%`);
console.log('');
console.log(`RECONCILE: backtested ${backtested} = winner-tallied ${withPreds.length} (>=3 preds) + ${fewPred.length} with <3 comparable preds:`);
for (const w of fewPred) console.log(`  ${w.well.padEnd(20)} pulls=${w.n} comparable-preds=${w.preds}`);
console.log('');
console.log('WASHOUT: no explicit event source in production → Days 1-3 windows N/A, not inferred. Anthony wells not identifiable without guessing; none singled out.');
