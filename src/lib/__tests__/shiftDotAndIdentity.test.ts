import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftDotFromResolve, shiftDotForDriver, type ShiftResolveResult } from '../shiftDotCore.ts';
import { operationalDriverName } from '../operationalDriverName.ts';
import { pruneExpandedGroups } from '../expandedGroupsRestoreCore.ts';

const MIKE = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const S24 = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
const openResult: ShiftResolveResult = { state: 'open', periodId: '2026-09-13_091427', originLocalDate: '2026-09-13' };

// ── Shift dot: 10 required cases ─────────────────────────────────────────────

test('1. active canonical shift → green', () => {
  assert.equal(shiftDotFromResolve(openResult).dot, 'green');
  assert.equal(shiftDotFromResolve(openResult).title, 'On shift');
});

test('2. closed / no shift → red', () => {
  assert.equal(shiftDotFromResolve({ state: 'none' }).dot, 'red');
  assert.equal(shiftDotFromResolve({ state: 'none' }).title, 'Off shift');
});

test('3. loading / read failure / unverifiable → gray (never a false red)', () => {
  assert.equal(shiftDotFromResolve({ state: 'unverifiable', reason: 'authority_absent' }).dot, 'gray');
  assert.equal(shiftDotFromResolve(null).dot, 'gray');
  assert.equal(shiftDotForDriver({ canonicalDriverId: MIKE, loading: true }).dot, 'gray');
  assert.equal(shiftDotForDriver({ canonicalDriverId: MIKE, error: true }).dot, 'gray');
  assert.equal(shiftDotForDriver({ canonicalDriverId: MIKE, resultsByDriverId: new Map() }).dot, 'gray');
});

test('4. HOS violation with an open shift is still green (dot ignores HOS — no HOS input exists)', () => {
  // There is no HOS parameter; an open shift maps to green regardless of legality.
  assert.equal(shiftDotFromResolve(openResult).dot, 'green');
});

test('5. accepted/active job with an open shift is still green (dot ignores dispatch state)', () => {
  // There is no job/dispatch parameter; open ⇒ green.
  assert.equal(shiftDotFromResolve(openResult).dot, 'green');
});

test('6. login/hash/displayName/authUID cannot impersonate — join is canonical driverId only', () => {
  const results = new Map<string, ShiftResolveResult>([[MIKE, openResult]]);
  // Correct canonical id → green.
  assert.equal(shiftDotForDriver({ canonicalDriverId: MIKE, resultsByDriverId: results }).dot, 'green');
  // A login alias / legacy hash / display name is NOT the canonical id → no match → gray.
  assert.equal(shiftDotForDriver({ canonicalDriverId: 'Mikezfold', resultsByDriverId: results }).dot, 'gray');
  assert.equal(shiftDotForDriver({ canonicalDriverId: 'a'.repeat(64), resultsByDriverId: results }).dot, 'gray');
  assert.equal(shiftDotForDriver({ canonicalDriverId: '', resultsByDriverId: results }).dot, 'gray');
});

test('7. same driverId resolved for another company cannot match (cross-company → gray)', () => {
  const results = new Map<string, ShiftResolveResult>([[MIKE, openResult]]);
  assert.equal(shiftDotForDriver({
    canonicalDriverId: MIKE, companyId: 'liquid-gold', resolvedCompanyId: 'acme', resultsByDriverId: results,
  }).dot, 'gray');
  assert.equal(shiftDotForDriver({
    canonicalDriverId: MIKE, companyId: 'liquid-gold', resolvedCompanyId: 'liquid-gold', resultsByDriverId: results,
  }).dot, 'green');
});

test('8. start/end shift update propagates (open → none flips green → red)', () => {
  const before = new Map<string, ShiftResolveResult>([[S24, openResult]]);
  assert.equal(shiftDotForDriver({ canonicalDriverId: S24, resultsByDriverId: before }).dot, 'green');
  const after = new Map<string, ShiftResolveResult>([[S24, { state: 'none' }]]);
  assert.equal(shiftDotForDriver({ canonicalDriverId: S24, resultsByDriverId: after }).dot, 'red');
});

test('9. operational name prefers displayName, but never the login (Coverage: Mike ZFold7 Burger, not Mikezfold)', () => {
  // Mike: displayName IS the login → fall to legalName (never "Mikezfold").
  assert.equal(operationalDriverName({ displayName: 'Mikezfold', legalName: 'Mike ZFold7 Burger', loginAlias: 'Mikezfold' }), 'Mike ZFold7 Burger');
  // A genuine distinct displayName wins over legalName (prefer displayName).
  assert.equal(operationalDriverName({ displayName: 'Mikey', legalName: 'Michael Burger', loginAlias: 'mburger' }), 'Mikey');
  // displayName present, no login known, differs from legal → displayName.
  assert.equal(operationalDriverName({ displayName: 'Nickname', legalName: 'Legal Name' }), 'Nickname');
});

test('10. no login-name leakage anywhere in the name resolver', () => {
  assert.equal(operationalDriverName({ displayName: 'MikeS24', legalName: 'Michael S24 Burger', loginAlias: 'MikeS24' }), 'Michael S24 Burger');
  assert.equal(operationalDriverName({ displayName: 'login', legalName: '', loginAlias: 'login' }), 'Driver'); // login-only + no legal → placeholder, never the login
  assert.equal(operationalDriverName(null), 'Driver');
});

// ── Expanded-groups restore race (addendum #1) ───────────────────────────────

test('expanded restore: while loading, stored ids are held verbatim — never pruned or emptied', () => {
  // Initial render: groups empty + loading. Must NOT drop Mike's stored canonical id.
  const r = pruneExpandedGroups([MIKE], new Set<string>(), /*ready*/ false);
  assert.deepEqual(r.next, [MIKE]);
  assert.equal(r.changed, false); // no persist during hydration
});

test('expanded restore: canonical group arrives (ready) → stays expanded, no change', () => {
  const r = pruneExpandedGroups([MIKE], new Set([MIKE, S24]), /*ready*/ true);
  assert.deepEqual(r.next, [MIKE]);
  assert.equal(r.changed, false);
});

test('expanded restore: a genuinely removed group is pruned only AFTER a completed dataset', () => {
  const stillLoading = pruneExpandedGroups([MIKE, 'gone-driver'], new Set([MIKE]), false);
  assert.deepEqual(stillLoading.next, [MIKE, 'gone-driver']); // held while loading
  const loaded = pruneExpandedGroups([MIKE, 'gone-driver'], new Set([MIKE]), true);
  assert.deepEqual(loaded.next, [MIKE]);
  assert.equal(loaded.changed, true); // now safe to persist the prune
});

test('expanded restore: empty-default is never persisted over a saved set during hydration', () => {
  // Live set momentarily empty + not ready → saved set survives, changed=false (no write).
  const r = pruneExpandedGroups([MIKE], [], false);
  assert.deepEqual(r.next, [MIKE]);
  assert.equal(r.changed, false);
});
