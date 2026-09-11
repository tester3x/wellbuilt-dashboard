/**
 * AFR v2 INTEGRATION — READ-ONLY real-history replay (no writes, no deploy).
 * Three-way one-step-ahead backtest on REAL production packets/processed for the
 * Gabriel route + Watford route wells (fetched read-only).
 *   v1        = computeAfrV1FromRates    (DEPLOYED baseline)
 *   baseV2    = computeAfrHybrid         (AFR v2 confidence engine @ 53fb454a)
 *   candidate = computeAfrAuto           (integrated automatic transient engine)
 *   prodEG    = computeAfrEventGated(no events)  == v1 sanity (the 53fb454a prod path)
 */
const fs = require('fs');
const path = require('path');
// Requires resolve relative to THIS file (functions/tools) → functions/lib/afr.
// Build first: `npx tsc -p tsconfig.json`. Usage: node tools/afrIntegrationReplay.cjs <dir-of-perWell-json>
const LIB = path.join(__dirname, '../lib/afr/');
const { computeAfrV1FromRates } = require(LIB + 'afrV1.js');
const { computeAfrHybrid } = require(LIB + 'afrV2.js');
const { computeAfrEventGated } = require(LIB + 'afrEventGated.js');
const { computeAfrAuto } = require(LIB + 'afrAutoTransient.js');
const { AFR_V2_POLICY: P } = require(LIB + 'afrV2Policy.js');

const DIR = process.argv[2];
const GAB = ['Gabriel 1','Gabriel 2','Gabriel 3','Gabriel 4','Gabriel 5','Gabriel 6','Gabriel 7','Thor 1','Thor 5'];
const WAT = ['Atlas 1','Crossbow 1','Cyclone 1','Hatchet 1','Kahuna 1','Pesek 10','Phazor 1'];
const WELLS = [...GAB, ...WAT];

function loadWell(name) {
  const f = path.join(DIR, name.replace(/\s/g, '_') + '.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
  if (!raw || typeof raw !== 'object') return [];
  const es = [];
  for (const [key, d] of Object.entries(raw)) {
    if (!d || typeof d !== 'object') continue;
    if (key.startsWith('edit_') || key.startsWith('delete_') || key.startsWith('history_')) continue;
    if (!(d.flowRateDays > 0)) continue;
    let ts = d.dateTimeUTC ? Date.parse(d.dateTimeUTC) : d.gaugeTime ? Date.parse(d.gaugeTime) : d.dateTime ? Date.parse(d.dateTime) : 0;
    if (Number.isNaN(ts)) ts = 0;
    es.push({ key, timestamp: ts, rate: d.flowRateDays, topLevelFeet: typeof d.tankLevelFeet === 'number' ? d.tankLevelFeet : undefined, bblsTaken: typeof d.bblsTaken === 'number' ? d.bblsTaken : undefined });
  }
  es.sort((a, b) => a.timestamp - b.timestamp);
  return es;
}
const mkIntervals = (hist) => hist.map((e, j) => ({ key: e.key, timestamp: e.timestamp, flowRateDays: e.rate, intervalMs: j > 0 ? e.timestamp - hist[j - 1].timestamp : undefined, topLevelFeet: e.topLevelFeet, priorTopLevelFeet: j > 0 ? hist[j - 1].topLevelFeet : undefined, bblsTaken: e.bblsTaken, bblPerFoot: 20 }));
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
// Bounded per-step accuracy in [0,100]: 100*(1 - min(1, |pred-actual|/actual)).
// Capping the relative error at 1 prevents near-zero (dead-well) actuals from
// producing meaningless mega-negative "accuracy". A totally-wrong step scores 0,
// a perfect step scores 100 — so a per-well mean is a real percentage.
const realAcc = (pred, actual) => { if (!(actual > 0) || !(pred > 0)) return null; return 100 * (1 - Math.min(1, Math.abs(pred - actual) / actual)); };
const pctChg = (a, b) => a === 0 ? (b === 0 ? 0 : Infinity) : (b - a) / a * 100;

let gAll = { v1: [], base: [], cand: [] };
const bucket = { high: [], low: [], weak: [] };
// paired errors on the SAME high-confidence (candidate weight 1.0) steps
const pairedHigh = { v1: [], base: [], cand: [] };
let egExact = 0, egWells = 0;
const perWell = [];

for (const well of WELLS) {
  const es = loadWell(well);
  if (es.length < 6) { perWell.push({ well, n: es.length, skip: true }); continue; }
  egWells++;
  const eg = computeAfrEventGated(mkIntervals(es), P, { eventWindows: [] });
  if (eg.mode === 'v1' && Math.abs(eg.afr - computeAfrV1FromRates(es.map((e) => e.rate))) < 1e-9) egExact++;

  const eV1 = [], eBase = [], eCand = [], aV1 = [], aBase = [], aCand = [];
  let hi = 0, lo = 0, wk = 0;
  for (let i = 4; i < es.length; i++) {
    const hist = es.slice(0, i);
    const actual = es[i].rate;
    const pV1 = computeAfrV1FromRates(hist.map((e) => e.rate));
    const pBase = computeAfrHybrid(mkIntervals(hist), P).afr;
    const pCand = computeAfrAuto(mkIntervals(hist), P).afr;
    eV1.push(Math.abs(pV1 - actual)); eBase.push(Math.abs(pBase - actual)); eCand.push(Math.abs(pCand - actual));
    gAll.v1.push(Math.abs(pV1 - actual)); gAll.base.push(Math.abs(pBase - actual)); gAll.cand.push(Math.abs(pCand - actual));
    const ra1 = realAcc(pV1, actual); if (ra1 != null) aV1.push(ra1);
    const rab = realAcc(pBase, actual); if (rab != null) aBase.push(rab);
    const rac = realAcc(pCand, actual); if (rac != null) aCand.push(rac);
    const inc = computeAfrAuto(mkIntervals(es.slice(0, i + 1)), P);
    const pi = inc.perInterval[inc.perInterval.length - 1];
    if (pi && pi.valid) {
      const err = Math.abs(pCand - actual);
      if (pi.weight >= 1.0) {
        bucket.high.push(err); hi++;
        pairedHigh.v1.push(Math.abs(pV1 - actual)); pairedHigh.base.push(Math.abs(pBase - actual)); pairedHigh.cand.push(err);
      } else if (pi.weight <= 0.4) { bucket.low.push(err); lo++; }
      else { bucket.weak.push(err); wk++; }
    }
  }
  perWell.push({ well, n: es.length, preds: eV1.length, maeV1: mean(eV1), maeBase: mean(eBase), maeCand: mean(eCand), accV1: mean(aV1), accBase: mean(aBase), accCand: mean(aCand), dAccV1: mean(aCand) - mean(aV1), dAccBase: mean(aCand) - mean(aBase), hi, wk, lo });
}

console.log('===== AFR INTEGRATION — READ-ONLY REAL-HISTORY REPLAY =====');
console.log(`Source: production packets/processed (read-only), routes Gabriels + Watford. windowSize=${P.windowSize}.`);
console.log(`Sanity — 53fb454a production path (computeAfrEventGated, no events) == v1 exactly: ${egExact}/${egWells} wells.\n`);
console.log('AGGREGATE one-step MAE (days/ft), all eligible steps:');
console.log(`  n=${gAll.v1.length}  v1=${mean(gAll.v1).toFixed(5)}  baseV2(hybrid@53fb454a)=${mean(gAll.base).toFixed(5)} (${pctChg(mean(gAll.v1),mean(gAll.base)).toFixed(1)}%)  candidate(auto)=${mean(gAll.cand).toFixed(5)} (${pctChg(mean(gAll.v1),mean(gAll.cand)).toFixed(1)}%)\n`);
console.log('CANDIDATE accuracy split by its OWN confidence tier of the target reading (nothing hidden):');
console.log(`  all-eligible          n=${gAll.cand.length}  MAE=${mean(gAll.cand).toFixed(5)}`);
console.log(`  high-confidence (1.0) n=${bucket.high.length}  MAE=${mean(bucket.high).toFixed(5)}`);
console.log(`  weak-timing (0.8)     n=${bucket.weak.length}  MAE=${mean(bucket.weak).toFixed(5)}`);
console.log(`  disturbed-low (<=0.4) n=${bucket.low.length}  MAE=${mean(bucket.low).toFixed(5)}\n`);
console.log('PAIRED on the SAME high-confidence (candidate weight 1.0) steps — does the candidate worsen STABLE forecasting?');
console.log(`  n=${pairedHigh.cand.length}  MAE v1=${mean(pairedHigh.v1).toFixed(5)}  baseV2=${mean(pairedHigh.base).toFixed(5)}  candidate=${mean(pairedHigh.cand).toFixed(5)}\n`);
console.log('PER-WELL bounded accuracy % (100*(1-min(1,|err|/actual))); flags vs v1 AND vs base-v2 (the integration start point):');
console.log('  well              n  preds   MAE_v1   MAE_base  MAE_cand   acc_v1 acc_base acc_cand   dVSv1  dVSbase  flags');
const flaggedV1 = [], flaggedBase = [];
for (const r of perWell) {
  if (r.skip) { console.log(`  ${r.well.padEnd(16)} ${String(r.n).padStart(2)}   (skip <6 pulls)`); continue; }
  const fv1 = r.dAccV1 < -2, fbase = r.dAccBase < -2;
  if (fv1) flaggedV1.push(r); if (fbase) flaggedBase.push(r);
  const flags = [fv1 ? 'vs-v1' : '', fbase ? 'vs-base' : ''].filter(Boolean).join(',');
  console.log(`  ${r.well.padEnd(16)} ${String(r.n).padStart(2)} ${String(r.preds).padStart(5)}  ${r.maeV1.toFixed(5)}  ${r.maeBase.toFixed(5)}  ${r.maeCand.toFixed(5)}   ${r.accV1.toFixed(1).padStart(5)}  ${r.accBase.toFixed(1).padStart(5)}  ${r.accCand.toFixed(1).padStart(5)}  ${(r.dAccV1>=0?'+':'')+r.dAccV1.toFixed(1)}  ${(r.dAccBase>=0?'+':'')+r.dAccBase.toFixed(1)}   ${flags}`);
}
console.log('');
console.log(`FLAG vs v1 (deployed): ${flaggedV1.length}/15 wells worse >2pp — reflects the KNOWN v1→v2-family robustness/relative-accuracy trade-off.`);
console.log(`FLAG vs base-v2 @53fb454a (the integration's actual start point): ${flaggedBase.length}/15 wells worse >2pp.`);
if (flaggedBase.length) for (const r of flaggedBase) console.log(`  - ${r.well}: base=${r.accBase.toFixed(1)} -> cand=${r.accCand.toFixed(1)} (${r.dAccBase.toFixed(1)}pp), MAE ${r.maeBase.toFixed(4)}->${r.maeCand.toFixed(4)}`);
