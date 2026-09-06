/**
 * Dispatch well-queue live-status attach race.
 * Run: node --experimental-strip-types tools/test-dispatchLiveStatusRace.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  nextWellsErrorAfterEvent,
  wellQueueLiveGate,
  wellQueueLiveGenerationApplies,
} from '../src/lib/dispatchWellQueueLive.ts';

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
check('dispatch waits for loading+uid gate', page.includes('wellQueueLiveGate') && page.includes('authStateReady') && page.includes('getIdToken'));
check('dispatch effect keys uid not whole user object', page.includes('[loading, user?.uid, user?.companyId]'));
check('dispatch live subscribe disables inner catalog success callback',
  page.includes('catalogFallback: false'));
check('dispatch well-queue effect is not keyed on whole user object',
  page.includes('[loading, user?.uid, user?.companyId]') &&
  !/subscribeToWellStatusesUnified[\s\S]{0,900}\}, \[user\]\);/.test(page));
check('unified subscriber honors catalogFallback false',
  wells.includes('catalogFallback') && wells.includes('if (!catalogFallback) return;'));
check('unified subscriber ignores merges after failure',
  wells.includes('if (!active || failed) return;'));
check('paths remain well_config and packets/outgoing',
  wells.includes("ref(db, 'well_config')") && wells.includes("ref(db, 'packets/outgoing')"));
check('no getIdToken(true) force refresh',
  !page.includes('getIdToken(true)') && !src('src/lib/dispatchWellQueueLive.ts').includes('getIdToken(true)'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
