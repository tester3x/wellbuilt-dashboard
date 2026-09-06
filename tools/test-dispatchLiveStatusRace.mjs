/**
 * Dispatch well-queue live-status attach race.
 * Run: node --experimental-strip-types tools/test-dispatchLiveStatusRace.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canListenPacketsOutgoingParent,
  nextWellsErrorAfterEvent,
  wellQueueLiveGate,
  wellQueueLiveGenerationApplies,
} from '../src/lib/dispatchWellQueueLive.ts';
import { mergeWellPool } from '../src/lib/wellPoolMerge.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(join(root, rel), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

check('wait while auth loading', wellQueueLiveGate({ loading: true, uid: 'u1' }) === 'wait');
check('wait while uid missing', wellQueueLiveGate({ loading: false, uid: null }) === 'wait');
check('skip scoped other company', wellQueueLiveGate({ loading: false, uid: 'u1', companyId: 'home-hauling' }) === 'skip');
check('subscribe unscoped owner', wellQueueLiveGate({ loading: false, uid: 'u1' }) === 'subscribe');
check('subscribe liquid-gold', wellQueueLiveGate({ loading: false, uid: 'u1', companyId: 'liquid-gold' }) === 'subscribe');

check('generation 0 never applies', wellQueueLiveGenerationApplies(0, 0) === false);
check('stale gen ignored', wellQueueLiveGenerationApplies(1, 2) === false);
check('matching gen applies', wellQueueLiveGenerationApplies(3, 3) === true);

check('stale error does not clobber success',
  nextWellsErrorAfterEvent({ eventGen: 1, activeGen: 2, event: 'error', previous: undefined, nextError: 'denied' }) === undefined);
check('success clears same-gen error',
  nextWellsErrorAfterEvent({ eventGen: 2, activeGen: 2, event: 'success', previous: 'denied' }) === undefined);
check('same-gen error is kept',
  nextWellsErrorAfterEvent({ eventGen: 2, activeGen: 2, event: 'error', previous: undefined, nextError: 'denied' }) === 'denied');
check('stale success does not clear newer error',
  nextWellsErrorAfterEvent({ eventGen: 1, activeGen: 2, event: 'success', previous: 'denied' }) === 'denied');

const page = src('src/app/dispatch/page.tsx');
const wells = src('src/lib/wells.ts');
check('platform admin claims may listen outgoing parent',
  canListenPacketsOutgoingParent({ wellbuiltAdmin: true, platformAdminEnabled: true }) === true);
check('admin claim without platformAdminEnabled cannot listen outgoing',
  canListenPacketsOutgoingParent({ wellbuiltAdmin: true }) === false);
check('empty claims cannot listen outgoing', canListenPacketsOutgoingParent({}) === false);
check('dispatch waits for loading+uid gate', page.includes('wellQueueLiveGate') && page.includes('authStateReady') && page.includes('getIdTokenResult'));
check('dispatch effect keys uid not whole user object', page.includes('[loading, user?.uid, user?.companyId]'));
check('dispatch does not parent-listen well_config',
  !page.includes("subscribeToWellStatusesUnified") && !page.includes("'well_config'"));
check('dispatch uses authorized catalog for well_config', page.includes('adminGetDashboardCatalog'));
check('dispatch outgoing listen is claim-gated',
  page.includes('canListenPacketsOutgoingParent') && page.includes('subscribePacketsOutgoing'));
check('no getIdToken(true) force refresh',
  !page.includes('getIdToken(true)'));
check('packets/outgoing helper exists',
  wells.includes("ref(getFirebaseDatabase(), 'packets/outgoing')"));
check('wb admin without platformAdminEnabled is catalog-only',
  canListenPacketsOutgoingParent({ wellbuiltAdmin: true, platformAdminEnabled: false }) === false);
check('live-status deny is only from outgoing error callback',
  (page.match(/classifiedReadFailure\('well queue live status'/g) || []).length === 1
  && page.includes("classifiedReadFailure('well queue live status', err)"));
check('outgoing listener detaches if effect cancelled during attach',
  /if \(cancelled\) \{\s*unsubscribe\(\);\s*unsubscribe = undefined;/s.test(page));
check('dispatch merges catalog wellStatus onto wellConfig',
  page.includes('mergeWellPool') && page.includes('catalog.wellStatus'));

const configOnly = mergeWellPool(
  { 'Gabriel 1': { route: 'Gabriels' } },
  {},
);
check('config-only catalog row has no live data',
  configOnly[0].currentLevel === '--' && !configOnly[0].nextPullTimeUTC);

const merged = mergeWellPool(
  { 'Gabriel 1': { route: 'Gabriels' } },
  { 'Gabriel 1': { currentLevel: '5\'0"', nextPullTimeUTC: '2026-09-06T12:00:00Z', timeTillPull: '2h' } },
);
check('catalog wellStatus fills queue live fields',
  merged[0].currentLevel === '5\'0"'
  && merged[0].nextPullTimeUTC === '2026-09-06T12:00:00Z'
  && merged[0].timeTillPull === '2h'
  && merged[0].route === 'Gabriels');
check('space-stripped wellStatus still merges',
  mergeWellPool(
    { 'Gabriel 1': { route: 'Gabriels' } },
    { Gabriel1: { currentLevel: '4\'0"', nextPullTimeUTC: '2026-09-06T13:00:00Z' } },
  )[0].currentLevel === '4\'0"');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
