/**
 * DATA-CONTRACT proof: adminGetWellPool(raw) -> mergeWellPool -> classifyWell.
 *
 * Production defect this locks down: the governed pool path (mergeWellPool +
 * wellResponsesFromCatalog) never populated the pull-height target
 * (`tankAtLevel`) nor the gain/level fields, so `classifyWell` short-circuited
 * to VERIFY (reason: missing_target) for EVERY well — 71 wells all NEEDS
 * DATA/VERIFY regardless of a fresh, at-target reading.
 *
 * These tests feed PRODUCTION-SHAPED raw inputs (the exact shapes the callable
 * returns: `wellConfig` from `well_config`, `wellStatus` from
 * `packets/outgoing`) through the REAL merge, then assert MIXED, correct
 * outcomes plus explicit reason codes. No Firebase; fixed clock.
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/wellPoolDataContract.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWellPool } from '../wellPoolCore.ts';
import { classifyWell } from '../dispatchPriority.ts';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const iso = (hoursFromNow: number) => new Date(NOW + hoursFromNow * 3600_000).toISOString();

// Config chosen so calcTankAtLevel yields a 7'6" (90") target:
//   bblPerFootPerTank = bblPerFoot/tanks = 40/2 = 20
//   tankAtInches = (pullBbls/tanks / 20)*12 + bottomLevel*12
//                = (180/2/20)*12 + 36 = 54 + 36 = 90"  (7'6")
const CFG = { tanks: 2, pullBbls: 180, bottomLevel: 3, bblPerFoot: 40, route: 'North', ndicName: 'NDIC-X' };

// -- The two production counterexamples the addendum called out -------------
test('COUNTEREXAMPLE AddedTest 5\'1" (fresh, gaining) is NOT VERIFY — APPROACHING with TTP', () => {
  const wells = mergeWellPool(
    { AddedTest: { ...CFG } },
    { AddedTest: { currentLevel: "5'1\"", windowBblsDay: '120', timestampUTC: iso(-36), wellDown: false } },
  );
  const added = wells.find(w => w.wellName === 'AddedTest')!;
  // The exact merged inputs the classifier now receives (were absent before):
  assert.equal(added.tankAtLevel, "2 @ 7'6\"");        // target present (was missing)
  assert.equal(added.currentLevelInches, 61);          // level parsed (was absent)
  assert.equal(added.windowBblsDay, '120');            // gain carried (was absent)
  assert.equal(added.bblPerFoot, 40);                  // bbl/ft carried (was absent)
  const c = classifyWell(added, NOW);
  assert.equal(c.state, 'approaching');                // NOT verify
  assert.equal(c.targetInches, 90);
  assert.equal(c.remainingInches, 29);                 // 90 - 61
  assert.ok(c.ttpHours !== null && c.ttpHours > 0, 'has a real TTP');
  assert.equal(c.reason, undefined);                   // actionable, no defect reason
});

test('COUNTEREXAMPLE Blackdog 8\'7" (fresh, gaining) is NOT VERIFY — PULL NOW', () => {
  const wells = mergeWellPool(
    { Blackdog: { ...CFG } },
    { Blackdog: { currentLevel: "8'7\"", windowBblsDay: '90', timestampUTC: iso(-42), wellDown: false } },
  );
  const bd = wells.find(w => w.wellName === 'Blackdog')!;
  assert.equal(bd.currentLevelInches, 103);            // 8'7"
  const c = classifyWell(bd, NOW);
  assert.equal(c.state, 'pull-now');                   // 103 >= 90 target
  assert.equal(c.reason, undefined);
});

// -- Reason codes distinguish the genuinely-incomplete cases ----------------
test('REASON CODES: missing_target / missing_level / stale_level / no_gain are distinct', () => {
  // missing_level: config present (has target) but no outgoing status at all
  const [noStatus] = mergeWellPool({ Lonely: { ...CFG } }, {});
  assert.equal(noStatus.tankAtLevel, "2 @ 7'6\"");
  const cLevel = classifyWell(noStatus, NOW);
  assert.equal(cLevel.state, 'verify');
  assert.equal(cLevel.reason, 'missing_level');

  // stale_level: fresh-looking value but reading older than the trust window
  const [stale] = mergeWellPool(
    { Old: { ...CFG } },
    { Old: { currentLevel: "1'3\"", windowBblsDay: '0', timestampUTC: iso(-136 * 24) } },
  );
  const cStale = classifyWell(stale, NOW);
  assert.equal(cStale.state, 'verify');
  assert.equal(cStale.reason, 'stale_level');

  // no_gain: recent, below target, zero validated gain
  const [flat] = mergeWellPool(
    { Flat: { ...CFG } },
    { Flat: { currentLevel: "4'0\"", windowBblsDay: '0', timestampUTC: iso(-3) } },
  );
  const cFlat = classifyWell(flat, NOW);
  assert.equal(cFlat.state, 'no-gain');
  assert.equal(cFlat.reason, 'no_gain');

  // missing_target: a config with no derivable target (no pullBbls/tanks path)
  const [noTgt] = mergeWellPool(
    { Bare: { route: 'X' } as Record<string, unknown> },
    { Bare: { currentLevel: "5'0\"", timestampUTC: iso(-2) } },
  );
  // Bare has defaults (tanks 1, pullBbls 140) so it DOES get a target; assert a
  // truly target-less object routes to missing_target at the classifier level.
  assert.equal(classifyWell({ currentLevel: "5'0\"", currentLevelInches: 60, timestampUTC: iso(-2) } as never, NOW).reason, 'missing_target');
  void noTgt;
});

// -- Roster-preserving catalog-left-join (80 vs 71 reconciliation) ----------
test('CATALOG LEFT-JOIN: config wells lacking outgoing status are preserved as missing_level, never dropped', () => {
  const config: Record<string, unknown> = {};
  const status: Record<string, unknown> = {};
  for (let i = 0; i < 80; i++) config[`W${i}`] = { ...CFG };
  // Only 71 of the 80 have an outgoing status entry.
  for (let i = 0; i < 71; i++) status[`W${i}`] = { currentLevel: "7'8\"", windowBblsDay: '100', timestampUTC: iso(-5) };
  const wells = mergeWellPool(config, status);
  assert.equal(wells.length, 80, 'complete configured roster preserved (left-join base = wellConfig)');
  const withStatus = wells.filter(w => w.currentLevel !== '--');
  const withoutStatus = wells.filter(w => w.currentLevel === '--');
  assert.equal(withStatus.length, 71);
  assert.equal(withoutStatus.length, 9);
  // The 9 status-less wells are genuinely-incomplete NEEDS DATA (missing_level),
  // NOT silently excluded and NOT fabricated as some other state.
  for (const w of withoutStatus) {
    const c = classifyWell(w, NOW);
    assert.equal(c.state, 'verify');
    assert.equal(c.reason, 'missing_level');
  }
});

// -- The whole point: MIXED production-shaped outcomes, not 100% VERIFY ------
test('MIXED OUTCOMES: a 100+ well production-shaped pool yields every actionable bucket, not all-VERIFY', () => {
  const config: Record<string, unknown> = {};
  const status: Record<string, unknown> = {};
  const add = (name: string, st: Record<string, unknown> | null) => {
    config[name] = { ...CFG };
    if (st) status[name] = st;
  };
  // 30 PULL NOW: fresh, at/over 90" target, gaining
  for (let i = 0; i < 30; i++) add(`Pull${i}`, { currentLevel: "7'9\"", windowBblsDay: '110', timestampUTC: iso(-4) });
  // 25 APPROACHING: fresh, below target, validated gain
  for (let i = 0; i < 25; i++) add(`App${i}`, { currentLevel: "6'0\"", windowBblsDay: '120', timestampUTC: iso(-4) });
  // 20 NO GAIN: fresh, below target, zero gain
  for (let i = 0; i < 20; i++) add(`Flat${i}`, { currentLevel: "4'0\"", windowBblsDay: '0', timestampUTC: iso(-4) });
  // 15 stale VERIFY: below target, ancient reading (low-well-never-urgent-by-age)
  for (let i = 0; i < 15; i++) add(`Stale${i}`, { currentLevel: "1'0\"", windowBblsDay: '0', timestampUTC: iso(-200) });
  // 10 DOWN
  for (let i = 0; i < 10; i++) add(`Down${i}`, { currentLevel: 'DOWN', wellDown: true, timestampUTC: iso(-4) });
  // 9 NEEDS DATA (missing_level): config only, no outgoing status
  for (let i = 0; i < 9; i++) add(`Missing${i}`, null);

  const wells = mergeWellPool(config, status);
  assert.equal(wells.length, 109, 'full roster preserved (30+25+20+15+10+9)');

  const tally: Record<string, number> = {};
  for (const w of wells) {
    const c = classifyWell(w, NOW);
    tally[c.state] = (tally[c.state] || 0) + 1;
  }
  assert.equal(tally['pull-now'], 30);
  assert.equal(tally['approaching'], 25);
  assert.equal(tally['no-gain'], 20);
  assert.equal(tally['verify'], 15 + 9); // stale + missing_level
  assert.equal(tally['down'], 10);
  // Explicitly: NOT everything is verify (the production regression).
  assert.ok(tally['verify'] < wells.length, 'NOT all wells VERIFY');
  assert.ok((tally['pull-now'] + tally['approaching']) > 0, 'actionable wells exist');
});

// -- low-well-never-urgent-by-age -----------------------------------------
test('LOW WELL never becomes urgent by age alone: 1\'0" stays VERIFY as the clock advances', () => {
  const [low] = mergeWellPool(
    { Low: { ...CFG } },
    { Low: { currentLevel: "1'0\"", windowBblsDay: '0', timestampUTC: iso(-2) } },
  );
  assert.equal(classifyWell(low, NOW).state, 'no-gain'); // fresh + no gain
  // advance 300h: the same reading only goes STALE, never pull-now
  const later = NOW + 300 * 3600_000;
  const c = classifyWell(low, later);
  assert.equal(c.state, 'verify');
  assert.equal(c.reason, 'stale_level');
});
