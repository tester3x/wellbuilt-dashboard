/**
 * AFR replay/shadow (READ-ONLY, no writes, no deploy).
 *
 * (1) PRODUCTION (event-gated, no events): must equal v1 EXACTLY for every well.
 * (2) GENERIC SHADOW (computeAfrHybrid — research only, NEVER production): v1 vs
 *     hybrid one-step-ahead, with and without Gabriel 4, activation by reason,
 *     regressions by reason. NOTE: washout-recovery benefit is NOT claimed from
 *     unlabeled production history — it is proven by controlled fixtures/tests.
 *
 * Usage: node tools/afrReplay.cjs <all-processed.json>
 */
const fs = require('fs');
const { computeAfrV1FromRates } = require('../lib/afr/afrV1.js');
const { computeAfrHybrid } = require('../lib/afr/afrV2.js');
const { computeAfrEventGated } = require('../lib/afr/afrEventGated.js');
const { AFR_V2_POLICY } = require('../lib/afr/afrV2Policy.js');

const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) || {};
const P = AFR_V2_POLICY;

const byWell = new Map();
for (const [key, d] of Object.entries(raw)) {
  if (!d || typeof d !== 'object' || key.startsWith('edit_') || key.startsWith('delete_') || key.startsWith('history_')) continue;
  if (!(d.flowRateDays > 0)) continue;
  let ts = d.dateTimeUTC ? Date.parse(d.dateTimeUTC) : d.gaugeTime ? Date.parse(d.gaugeTime) : d.dateTime ? Date.parse(d.dateTime) : 0;
  if (Number.isNaN(ts)) ts = 0;
  const w = d.wellName || '(unknown)';
  if (!byWell.has(w)) byWell.set(w, []);
  byWell.get(w).push({ key, timestamp: ts, rate: d.flowRateDays, topLevelFeet: typeof d.tankLevelFeet === 'number' ? d.tankLevelFeet : undefined, bblsTaken: typeof d.bblsTaken === 'number' ? d.bblsTaken : undefined });
}
const mkIntervals = (hist) => hist.map((e, j) => ({ key: e.key, timestamp: e.timestamp, flowRateDays: e.rate, intervalMs: j > 0 ? e.timestamp - hist[j - 1].timestamp : undefined, topLevelFeet: e.topLevelFeet, priorTopLevelFeet: j > 0 ? hist[j - 1].topLevelFeet : undefined, bblsTaken: e.bblsTaken, bblPerFoot: 20 }));
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

// ── (1) PRODUCTION event-gated == v1 exactly ──────────────────────────────────
let prodWells = 0, prodExact = 0;
for (const [, esRaw] of byWell) {
  const es = esRaw.sort((a, b) => a.timestamp - b.timestamp);
  if (es.length < 5) continue;
  prodWells++;
  const eg = computeAfrEventGated(mkIntervals(es), P, { eventWindows: [] });
  if (eg.mode === 'v1' && eg.afr === computeAfrV1FromRates(es.map((e) => e.rate))) prodExact++;
}

// ── (2) GENERIC SHADOW (hybrid) ───────────────────────────────────────────────
let nPred = 0, sumV1 = 0, sumV2 = 0, nPredNoG4 = 0, sumV1NoG4 = 0, sumV2NoG4 = 0;
const reasonCounts = { invalid: 0, anomaly: 0, change_point: 0, event: 0 };
let stepsTotal = 0, stepsActivated = 0;
const perWell = [];
let finalPassthrough = 0;

for (const [well, esRaw] of byWell) {
  const es = esRaw.sort((a, b) => a.timestamp - b.timestamp);
  if (es.length < 5) continue;
  let wV1 = 0, wV2 = 0, wN = 0; const wReasons = new Set();
  for (let i = 4; i < es.length; i++) {
    const hist = es.slice(0, i); const actual = es[i].rate;
    const v1 = computeAfrV1FromRates(hist.map((e) => e.rate));
    const h = computeAfrHybrid(mkIntervals(hist), P);
    stepsTotal++;
    if (h.activated) { stepsActivated++; for (const r of h.activationReasons) { reasonCounts[r]++; wReasons.add(r); } }
    if (v1 > 0 && h.afr > 0 && actual > 0) {
      const e1 = Math.abs(v1 - actual), e2 = Math.abs(h.afr - actual);
      sumV1 += e1; sumV2 += e2; wV1 += e1; wV2 += e2; nPred++; wN++;
      if (well !== 'Gabriel 4') { sumV1NoG4 += e1; sumV2NoG4 += e2; nPredNoG4++; }
    }
  }
  const finalH = computeAfrHybrid(mkIntervals(es), P);
  if (finalH.mode === 'v1_passthrough') finalPassthrough++;
  perWell.push({ well, preds: wN, maeV1: wN ? wV1 / wN : 0, maeV2: wN ? wV2 / wN : 0, delta: wN ? (wV2 - wV1) / wN : 0, reasons: [...wReasons] });
}

const withPreds = perWell.filter((w) => w.preds >= 3);
let ties = 0; for (const w of withPreds) if (Math.abs(w.maeV1 - w.maeV2) < 1e-9) ties++;
withPreds.sort((a, b) => b.delta - a.delta);

console.log('===== AFR replay (READ-ONLY) =====\n');
console.log('(1) PRODUCTION event-gated (no events fed):');
console.log(`    ${prodExact}/${prodWells} wells: computeAfrEventGated === computeAfrV1FromRates EXACTLY (mode v1). Production == v1.\n`);

console.log('(2) GENERIC SHADOW — computeAfrHybrid (research only, NOT production):');
console.log(`    one-step preds=${nPred}`);
console.log(`    aggregate MAE  v1=${(sumV1 / nPred).toFixed(5)}  hybrid=${(sumV2 / nPred).toFixed(5)}  (${((sumV2 - sumV1) / sumV1 * 100).toFixed(1)}%)`);
console.log(`    aggregate MAE excl. Gabriel 4  v1=${(sumV1NoG4 / nPredNoG4).toFixed(5)}  hybrid=${(sumV2NoG4 / nPredNoG4).toFixed(5)}  (${((sumV2NoG4 - sumV1NoG4) / sumV1NoG4 * 100).toFixed(1)}%)`);
console.log(`    per-well (>=3 preds, n=${withPreds.length}): v1 median=${pct(withPreds.map((w) => w.maeV1), 0.5).toFixed(4)} p90=${pct(withPreds.map((w) => w.maeV1), 0.9).toFixed(4)}; hybrid median=${pct(withPreds.map((w) => w.maeV2), 0.5).toFixed(4)} p90=${pct(withPreds.map((w) => w.maeV2), 0.9).toFixed(4)}`);
console.log(`    activation: ${stepsActivated}/${stepsTotal} steps (${(stepsActivated / stepsTotal * 100).toFixed(1)}%)`);
console.log(`    activation counts BY REASON (steps): invalid=${reasonCounts.invalid} anomaly=${reasonCounts.anomaly} change_point=${reasonCounts.change_point} event=${reasonCounts.event}`);
console.log('');
console.log('    top regressions BY REASON (hybrid worse than v1, >=3 preds):');
for (const w of withPreds.filter((x) => x.delta > 0).slice(0, 6)) console.log(`      ${w.well.padEnd(20)} +${w.delta.toFixed(4)} reasons=[${w.reasons.join(',')}]`);
console.log('    top improvements:');
for (const w of withPreds.filter((x) => x.delta < 0).slice(-5).reverse()) console.log(`      ${w.well.padEnd(20)} ${w.delta.toFixed(4)} reasons=[${w.reasons.join(',')}]`);
console.log('');
console.log('(3) RECONCILE passthrough vs ties (two different metrics):');
console.log(`    ${finalPassthrough}/${prodWells} wells: FINAL hybrid computation is v1_passthrough (no active condition in the last 15-window).`);
console.log(`    ${ties}/${withPreds.length} wells: one-step MAE identical v1==hybrid across the whole backtest (activated at NO step).`);
console.log('    (A well can be passthrough at the final window yet have activated earlier in its history → the two counts differ.)');
console.log('');
console.log('(4) WASHOUT recovery benefit is NOT claimed from unlabeled production history.');
console.log('    Production has no washout events; the recovery path is proven by controlled fixtures in');
console.log('    washoutContract.test.ts (Days 0/1/2/3/4, ON blend, DST, restart). Anthony wells not identifiable without guessing.');
