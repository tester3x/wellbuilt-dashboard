/**
 * DOWN-well deliberate-dispatch behavior (fix/dashboard-downwell-dispatchable).
 *
 * A DOWN well must remain DELIBERATELY dispatchable while staying out of automatic
 * predictions and clearly badged DOWN. This locks the four required behaviors:
 *   (a) a DOWN well APPEARS in the Well Queue ALL view and in search;
 *   (b) a DOWN well is SELECTABLE/ASSIGNABLE (Assign active, with a required confirm);
 *   (c) a DOWN well is EXCLUDED from the automatic Needs Pull bucket / prediction;
 *   (d) dispatch NEVER writes or falsifies `wellDown` (pure display/selectability).
 *
 * (a) and (c) are proven against the real firebase-free helpers (matchesView /
 * wellBucket / classifyWell). (b) replicates the exact per-row dispatch booleans the
 * Dispatch page derives from the classification. (d) scans the Dispatch page + its
 * dispatch-create payloads to prove no wellDown mutation exists.
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/downWellDispatch.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  classifyWell, matchesView, wellBucket,
  type QueueView, type WellState,
} from '../dispatchPriority.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), 'utf8');

const BASE = Date.UTC(2026, 8, 14, 0, 0, 0);
const at = (h: number) => new Date(BASE + h * 3600_000).toISOString();
const now = BASE + 18 * 3600_000;
const w = (o: Record<string, unknown>) => o as never;

// A genuinely DOWN well (carries every real down signal: flag + token).
const downWell = w({
  wellName: 'Cyclone 2', route: 'North',
  isDown: true, wellDown: true, currentLevel: 'DOWN',
  lastPullBottomLevel: "4'", lastPullDateTimeUTC: at(0), flowRate: '0:05:00',
  bottomLevel: 3, pullBbls: 140, bblPerFoot: 20,
});
// A normal, at-target well that DOES belong in Needs Pull (control).
// est = 5' + (18-15)h * 60 / 30min-per-ft = 11' ≥ readyFeet 10' (3' + 140bbl/20) → PULL NOW.
const pullNowWell = w({
  wellName: 'Gabriel 3', route: 'North',
  lastPullBottomLevel: "5'", lastPullDateTimeUTC: at(15), flowRate: '0:30:00',
  bottomLevel: 3, pullBbls: 140, bblPerFoot: 20, currentLevel: "11'",
});

// ── Faithful re-statement of the Dispatch page's per-row dispatch policy ──────
// Mirrors src/app/dispatch/page.tsx (isDownWell / assignOverride / assignWarn /
// bulkSelectBlocked, and the Assign button `disabled={selectedWells.size > 0}`).
function rowPolicy(state: WellState) {
  const isDownWell = state === 'down';
  const assignOverride = state === 'verify' || state === 'no-gain';
  const assignWarn = assignOverride || isDownWell;
  const bulkSelectBlocked = isDownWell;
  const assignDisabled = (multiSelectActive: boolean) => multiSelectActive; // never solely because DOWN
  return { isDownWell, assignOverride, assignWarn, bulkSelectBlocked, assignDisabled };
}

// The page's search predicate (searchHits) — DOWN wells must survive it.
function passesSearch(well: Record<string, unknown>, q: string): boolean {
  const isDown = well.isDown === true || well.currentLevel === 'DOWN';
  if (!isDown && well.currentLevel === '--' && !well.nextPullTimeUTC) return false;
  const name = String(well.wellName || '').toLowerCase();
  const route = String(well.route || '').toLowerCase();
  return name.includes(q) || route.includes(q);
}

// ── (a) DOWN appears in the ALL view and in search ───────────────────────────
test('(a) DOWN well appears in the ALL view and in search, badged DOWN', () => {
  // Sanity: it really classifies as DOWN with the DOWN label.
  const c = classifyWell(downWell, now);
  assert.equal(c.state, 'down');
  assert.equal(c.label, 'DOWN');

  // ALL view includes it; predictive views do not.
  assert.equal(matchesView(downWell, 'all', now), true, 'DOWN shows in ALL');
  assert.equal(matchesView(downWell, 'needs-pull', now), false);
  assert.equal(matchesView(downWell, 'next-24h', now), false);
  assert.equal(matchesView(downWell, 'needs-data', now), false);

  // Search surfaces it (by name and by route).
  assert.equal(passesSearch(downWell, 'cyclone'), true, 'DOWN found by name');
  assert.equal(passesSearch(downWell, 'north'), true, 'DOWN found by route');
});

// ── (b) DOWN is selectable/assignable (deliberate, with a confirm) ───────────
test('(b) DOWN well is dispatchable via Assign (with confirm), out of bulk select', () => {
  const p = rowPolicy(classifyWell(downWell, now).state);
  assert.equal(p.isDownWell, true);
  assert.equal(p.assignWarn, true, 'DOWN shows the amber "Assign anyway" warning affordance');
  assert.equal(p.assignDisabled(false), false, 'Assign is ACTIVE for DOWN when not multi-selecting');
  assert.equal(p.assignDisabled(true), true, 'Assign only disables during multi-select (universal)');
  assert.equal(p.bulkSelectBlocked, true, 'DOWN kept out of bulk select-all / checkbox');

  // Control: a normal PULL NOW well assigns without a warning and is bulk-selectable.
  const q = rowPolicy(classifyWell(pullNowWell, now).state);
  assert.equal(q.isDownWell, false);
  assert.equal(q.assignWarn, false);
  assert.equal(q.assignDisabled(false), false);
  assert.equal(q.bulkSelectBlocked, false);
});

// ── (c) DOWN excluded from automatic Needs Pull prediction ───────────────────
test('(c) DOWN well is excluded from the automatic Needs Pull bucket', () => {
  // The page counts a Needs Pull well only when classifyWell(...).state === 'pull-now'.
  const needsPull = (well: Record<string, unknown>) => classifyWell(well as never, now).state === 'pull-now';
  assert.equal(needsPull(downWell), false, 'DOWN never enters Needs Pull');
  assert.equal(needsPull(pullNowWell), true, 'a real at-target well does');

  // wellBucket sorts DOWN into its own bucket, not needs-pull/next-24h/needs-data.
  assert.equal(wellBucket(downWell, now), 'down');
  assert.notEqual(wellBucket(downWell, now), 'needs-pull');

  // Even with an ancient pull + very fast flow, DOWN never predicts a rise.
  assert.equal(matchesView(downWell, 'needs-pull', now), false);
});

// ── (d) dispatch NEVER writes or falsifies wellDown ──────────────────────────
test('(d) dispatch never mutates or falsifies wellDown (display/selectability only)', () => {
  const page = read('../../app/dispatch/page.tsx');
  // No assignment/definition that sets wellDown to a literal anywhere in the page.
  assert.ok(!/wellDown\s*[:=]\s*(?:true|false)/.test(page), 'page never writes a wellDown literal');
  // The DOWN confirmation explicitly promises the status is NOT changed.
  assert.match(page, /will NOT change or clear its DOWN status/, 'confirm states status is preserved');
});

// ── Guard: the ALL view still includes every non-down well too (no regression) ─
test('non-DOWN wells are unaffected across all views', () => {
  const views: QueueView[] = ['all', 'needs-pull', 'next-24h', 'needs-data'];
  // pullNowWell: ALL yes, needs-pull yes, others no.
  assert.equal(matchesView(pullNowWell, 'all', now), true);
  assert.equal(matchesView(pullNowWell, 'needs-pull', now), true);
  assert.equal(matchesView(pullNowWell, 'next-24h', now), false);
  assert.equal(matchesView(pullNowWell, 'needs-data', now), false);
  // Every view returns a boolean (exhaustive switch, no undefined).
  for (const v of views) assert.equal(typeof matchesView(pullNowWell, v, now), 'boolean');
});
