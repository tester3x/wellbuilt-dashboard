import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeepLinkStateKey,
  scopeReady,
  serializeState,
  parseState,
  resolveInitialState,
  restorableSelection,
  restorableIdSet,
  isRestorableSlot,
  NON_RESTORABLE_SLOTS,
} from '../deepLinkStateCore.ts';

const mike = { uid: 'uid-mike', companyId: 'liquid-gold', pathname: '/dispatch' };
const other = { uid: 'uid-other', companyId: 'acme', pathname: '/dispatch' };

test('key format is dl:v1:{uid}:{companyId}:{pathname}:{slot} and sanitizes separators', () => {
  assert.equal(buildDeepLinkStateKey(mike, 'activeJobs.expandedDrivers'),
    'dl:v1:uid-mike:liquid-gold:/dispatch:activeJobs.expandedDrivers');
  // whitespace/colon in a segment can't collide across segments
  assert.equal(buildDeepLinkStateKey({ uid: 'a b', companyId: 'c:d', pathname: '/x' }, 's'),
    'dl:v1:a_b:c_d:/x:s');
  // missing uid/companyId use '-' (anonymous/admin scope never collides with a tenant)
  assert.equal(buildDeepLinkStateKey({ uid: null, companyId: null, pathname: '/well' }, 'scroll'),
    'dl:v1:-:-:/well:scroll');
});

test('scope isolation: different user or company yields a different key', () => {
  const a = buildDeepLinkStateKey(mike, 'scroll');
  const b = buildDeepLinkStateKey({ ...mike, uid: 'uid-x' }, 'scroll');
  const c = buildDeepLinkStateKey({ ...mike, companyId: 'acme' }, 'scroll');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('scopeReady requires a pathname and resolved uid + companyId (never -)', () => {
  assert.equal(scopeReady(mike), true);
  assert.equal(scopeReady({ uid: null, companyId: 'liquid-gold', pathname: '/dispatch' }), false);
  assert.equal(scopeReady({ uid: 'uid-mike', companyId: null, pathname: '/dispatch' }), false);
  assert.equal(scopeReady({ uid: '-', companyId: 'liquid-gold', pathname: '/dispatch' }), false);
  assert.equal(scopeReady({ uid: 'uid-mike', companyId: '-', pathname: '/dispatch' }), false);
  assert.equal(scopeReady({ uid: 'u', companyId: 'x', pathname: '' }), false);
});

test('serialize/parse round-trips within the same scope+slot', () => {
  const raw = serializeState(mike, 'activeJobs.expandedDrivers', ['2cad521c'], 1000);
  assert.deepEqual(parseState(raw, mike, 'activeJobs.expandedDrivers'), ['2cad521c']);
});

test('parse REJECTS cross-user / cross-company / cross-route / cross-slot (no leakage)', () => {
  const raw = serializeState(mike, 'scroll', { y: 500 }, 1);
  assert.equal(parseState(raw, other, 'scroll'), null);                     // cross-user + cross-company
  assert.equal(parseState(raw, { ...mike, companyId: 'acme' }, 'scroll'), null); // cross-company
  assert.equal(parseState(raw, { ...mike, pathname: '/well' }, 'scroll'), null); // cross-route
  assert.equal(parseState(raw, mike, 'other-slot'), null);                  // cross-slot
});

test('parse rejects corruption and version drift; null on absent', () => {
  assert.equal(parseState('{not json', mike, 'scroll'), null);
  assert.equal(parseState(JSON.stringify({ v: 'v0', uid: 'uid-mike' }), mike, 'scroll'), null);
  assert.equal(parseState(null, mike, 'scroll'), null);
});

test('precedence: URL wins, then session, then default', () => {
  assert.deepEqual(resolveInitialState({ url: { present: true, value: 'A' }, session: 'B', fallback: 'C' }),
    { value: 'A', source: 'url' });
  assert.deepEqual(resolveInitialState({ url: { present: false, value: 'A' }, session: 'B', fallback: 'C' }),
    { value: 'B', source: 'session' });
  assert.deepEqual(resolveInitialState({ url: { present: false, value: 'A' }, session: null, fallback: 'C' }),
    { value: 'C', source: 'default' });
});

test('restorableSelection drops a deleted/absent selection, keeps a live one', () => {
  assert.equal(restorableSelection('job-1', ['job-1', 'job-2']), 'job-1'); // live → kept
  assert.equal(restorableSelection('job-9', ['job-1', 'job-2']), null);    // deleted → dropped
  assert.equal(restorableSelection('', ['job-1']), null);
  assert.equal(restorableSelection(null, new Set(['job-1'])), null);
});

test('restorableIdSet intersects stored expanded ids with live ids (departed groups drop, no collapse of the rest)', () => {
  assert.deepEqual(restorableIdSet(['d1', 'd2', 'gone'], ['d1', 'd2', 'd3']), ['d1', 'd2']);
  assert.deepEqual(restorableIdSet(['d1', 'd1'], ['d1']), ['d1']); // dedup
  assert.deepEqual(restorableIdSet(null, ['d1']), []);
});

test('destructive / unsaved slots are never restorable', () => {
  assert.equal(isRestorableSlot('activeJobs.expandedDrivers'), true);
  for (const slot of NON_RESTORABLE_SLOTS) assert.equal(isRestorableSlot(slot), false);
});
