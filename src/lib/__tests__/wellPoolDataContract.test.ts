/**
 * DATA-CONTRACT proof: adminGetWellPool(raw) -> mergeWellPool -> classifyWell,
 * under the WB‑M vc58 live-level parity model.
 *
 * The governed merge must carry the WB‑M estimator inputs from the newest
 * outgoing status (`lastPullBottomLevel`, `flowRate`, `timestampUTC`/
 * `lastPullDateTimeUTC`, `wellDown`) plus the config target inputs
 * (`bottomLevel`, `pullBbls`, `bblPerFoot`). classifyWell then estimates the
 * live level (startingBottom + minutesSincePull / flowMinutesPerFoot, cap 20')
 * and compares it to readyLevel = allowedBottom + loadBbls/bblsPerFoot.
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/wellPoolDataContract.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWellPool } from '../wellPoolCore.ts';
import { classifyWell } from '../dispatchPriority.ts';

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const iso = (hoursFromNow: number) => new Date(NOW + hoursFromNow * 3600_000).toISOString();

// readyLevel = bottomLevel + pullBbls/bblPerFoot = 3 + 140/20 = 10'
const CFG = { tanks: 1, pullBbls: 140, bottomLevel: 3, bblPerFoot: 20, route: 'North', ndicName: 'NDIC-X' };

test('governed merge carries the WB‑M estimator inputs from outgoing status + config target inputs', () => {
  const [w] = mergeWellPool(
    { A: { ...CFG } },
    { A: { lastPullBottomLevel: "5'", lastPullDateTimeUTC: iso(-2), flowRate: '0:30:00', wellDown: false } },
  );
  assert.equal(w.lastPullBottomLevel, "5'");     // baseline carried
  assert.equal(w.flowRate, '0:30:00');           // AFR (min/ft) carried
  assert.equal(w.lastPullDateTimeUTC, iso(-2));  // pull time carried
  assert.equal(w.bottomLevel, 3);                // allowedBottom (config)
  assert.equal(w.pullBbls, 140);                 // load (config)
  assert.equal(w.bblPerFoot, 20);                // bbl/ft (config)
  const c = classifyWell(w, NOW);
  assert.equal(c.readyFeet, 10);
  assert.equal(c.estFeet, 9);                    // 5 + 120/30
  assert.equal(c.state, 'approaching');
});

test('REASON CODES: missing_baseline / missing_timestamp / no_flow_data are distinct', () => {
  // missing_baseline: config present but no outgoing status at all
  const [noStatus] = mergeWellPool({ Lonely: { ...CFG } }, {});
  const cB = classifyWell(noStatus, NOW);
  assert.equal(cB.state, 'verify');
  assert.equal(cB.reason, 'missing_baseline');
  assert.equal(cB.estDisplay, '--');             // never zero

  // missing_timestamp: baseline present, no pull/observation timestamp
  const [noTs] = mergeWellPool({ NoTs: { ...CFG } }, { NoTs: { lastPullBottomLevel: "5'", flowRate: '0:30:00' } });
  const cT = classifyWell(noTs, NOW);
  assert.equal(cT.reason, 'missing_timestamp');
  assert.equal(cT.estDisplay, '--');

  // no_flow_data: recent baseline below target, invalid/absent flow → frozen
  const [flat] = mergeWellPool({ Flat: { ...CFG } }, { Flat: { lastPullBottomLevel: "4'", lastPullDateTimeUTC: iso(-3), flowRate: 'Unknown' } });
  const cF = classifyWell(flat, NOW);
  assert.equal(cF.state, 'no-gain');
  assert.equal(cF.reason, 'no_flow_data');
  assert.equal(cF.estDisplay, "4'");             // frozen at baseline, not zero
});

test('CATALOG LEFT-JOIN: config wells lacking outgoing status are preserved (missing_baseline), never dropped', () => {
  const config: Record<string, unknown> = {};
  const status: Record<string, unknown> = {};
  for (let i = 0; i < 80; i++) config[`W${i}`] = { ...CFG };
  for (let i = 0; i < 71; i++) status[`W${i}`] = { lastPullBottomLevel: "7'8\"", lastPullDateTimeUTC: iso(-5), flowRate: '0:20:00' };
  const wells = mergeWellPool(config, status);
  assert.equal(wells.length, 80, 'complete configured roster preserved (left-join base = wellConfig)');
  const withStatus = wells.filter(w => w.lastPullBottomLevel);
  const withoutStatus = wells.filter(w => !w.lastPullBottomLevel && w.currentLevel === '--');
  assert.equal(withStatus.length, 71);
  assert.equal(withoutStatus.length, 9);
  for (const w of withoutStatus) {
    const c = classifyWell(w, NOW);
    assert.equal(c.state, 'verify');
    assert.equal(c.reason, 'missing_baseline');  // genuinely unavailable, not fabricated
  }
});

test('MIXED OUTCOMES: a 100+ well production-shaped pool yields every WB‑M bucket, not all-NEEDS-DATA', () => {
  const config: Record<string, unknown> = {};
  const status: Record<string, unknown> = {};
  const add = (name: string, st: Record<string, unknown> | null) => { config[name] = { ...CFG }; if (st) status[name] = st; };
  // 30 PULL NOW: baseline + flow already at/over 10' target
  for (let i = 0; i < 30; i++) add(`Pull${i}`, { lastPullBottomLevel: "9'", lastPullDateTimeUTC: iso(-1), flowRate: '0:30:00' }); // 9 + 60/30 = 11
  // 25 APPROACHING: below target, valid flow
  for (let i = 0; i < 25; i++) add(`App${i}`, { lastPullBottomLevel: "5'", lastPullDateTimeUTC: iso(-2), flowRate: '0:30:00' }); // 9 < 10
  // 20 NO FLOW: recent baseline below target, invalid flow → frozen
  for (let i = 0; i < 20; i++) add(`Flat${i}`, { lastPullBottomLevel: "4'", lastPullDateTimeUTC: iso(-3), flowRate: 'Unknown' });
  // 15 DOWN
  for (let i = 0; i < 15; i++) add(`Down${i}`, { lastPullBottomLevel: "4'", lastPullDateTimeUTC: iso(-3), flowRate: '0:30:00', wellDown: true });
  // 10 NEEDS DATA (missing_baseline): config only, no status
  for (let i = 0; i < 10; i++) add(`Missing${i}`, null);

  const wells = mergeWellPool(config, status);
  assert.equal(wells.length, 100);
  const tally: Record<string, number> = {};
  for (const w of wells) { const c = classifyWell(w, NOW); tally[c.state] = (tally[c.state] || 0) + 1; }
  assert.equal(tally['pull-now'], 30);
  assert.equal(tally['approaching'], 25);
  assert.equal(tally['no-gain'], 20);
  assert.equal(tally['down'], 15);
  assert.equal(tally['verify'], 10);
  assert.ok(tally['verify'] < wells.length, 'NOT all wells NEEDS DATA');
});

test('NO 48h rejection: an old valid basis still classifies (not forced to NEEDS DATA by age)', () => {
  const [oldW] = mergeWellPool({ Old: { ...CFG } }, { Old: { lastPullBottomLevel: "5'", lastPullDateTimeUTC: iso(-200), flowRate: '0:30:00' } });
  const c = classifyWell(oldW, NOW);
  assert.notEqual(c.state, 'verify');   // old but valid → still forecast (capped)
});

test('NO-FLOW low well never becomes urgent by age alone', () => {
  const [low] = mergeWellPool({ Low: { ...CFG } }, { Low: { lastPullBottomLevel: "1'", lastPullDateTimeUTC: iso(-2), flowRate: 'Unknown' } });
  assert.equal(classifyWell(low, NOW).state, 'no-gain');
  assert.equal(classifyWell(low, NOW + 300 * 3600_000).state, 'no-gain'); // still frozen, never urgent
});
