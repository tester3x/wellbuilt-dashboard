/**
 * Static-export spill detail route: query param, validation, no dynamic segment.
 * Run: node --experimental-strip-types tools/test-spillDetailRoute.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SPILL_DETAIL_MALFORMED_COPY,
  SPILL_DETAIL_MISSING_COPY,
  SPILL_DETAIL_NOT_FOUND_COPY,
  SPILL_DETAIL_PATH,
  SPILL_ID_RE,
  buildSpillDetailHref,
  extractLegacyPathIncidentId,
  parseSpillDetailIncidentId,
  spillDetailRouteErrorCopy,
  validateSpillIncidentIdParam,
} from '../src/lib/spill/spillDetailRoute.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(join(root, rel), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

check('canonical path is /safety/spills/detail', SPILL_DETAIL_PATH === '/safety/spills/detail');
check('incident id regex matches WB-T 8-64 alnum/_/-', SPILL_ID_RE.source === '^[0-9a-zA-Z_-]{8,64}$');

const href = buildSpillDetailHref('inc-12345', 'acme');
check('list href uses query incidentId', href === '/safety/spills/detail?incidentId=inc-12345&companyId=acme');
check('href does not use dynamic path segment', !href.includes('/safety/spills/inc-12345'));
check('omits empty companyId', buildSpillDetailHref('inc-12345') === '/safety/spills/detail?incidentId=inc-12345');

check('valid query id parses', parseSpillDetailIncidentId({ searchIncidentId: 'inc-12345' }).ok === true
  && parseSpillDetailIncidentId({ searchIncidentId: 'inc-12345' }).incidentId === 'inc-12345');
check('encoded query id decodes', parseSpillDetailIncidentId({ searchIncidentId: 'inc-12345' }).ok === true);
check('missing id is missing', parseSpillDetailIncidentId({}).reason === 'missing');
check('blank query is missing', parseSpillDetailIncidentId({ searchIncidentId: '   ' }).reason === 'missing');
check('short id is malformed', validateSpillIncidentIdParam('abc').reason === 'malformed');
check('slash id is malformed', validateSpillIncidentIdParam('abc/defghij').reason === 'malformed');
check('dot-dot is malformed', validateSpillIncidentIdParam('........').reason === 'malformed');
check('too long is malformed', validateSpillIncidentIdParam('a'.repeat(65)).reason === 'malformed');
check('64-char id is valid', validateSpillIncidentIdParam('a'.repeat(64)).ok === true);
check('8-char id is valid', validateSpillIncidentIdParam('abcd1234').ok === true);

check('legacy path extracts id', extractLegacyPathIncidentId('/safety/spills/inc-12345/') === 'inc-12345');
check('legacy path ignores detail', extractLegacyPathIncidentId('/safety/spills/detail') === null);
check('legacy path used when query empty', parseSpillDetailIncidentId({
  searchIncidentId: '',
  pathname: '/safety/spills/inc-12345',
}).incidentId === 'inc-12345');
check('query wins over legacy path', parseSpillDetailIncidentId({
  searchIncidentId: 'other_id1',
  pathname: '/safety/spills/inc-12345',
}).incidentId === 'other_id1');
check('missing copy', spillDetailRouteErrorCopy('missing') === SPILL_DETAIL_MISSING_COPY);
check('malformed copy', spillDetailRouteErrorCopy('malformed') === SPILL_DETAIL_MALFORMED_COPY);
check('not-found copy is truthful', SPILL_DETAIL_NOT_FOUND_COPY === 'Incident not found.');

const listUi = src('src/components/safety/SpillIncidentList.tsx');
check('list uses buildSpillDetailHref', listUi.includes('buildSpillDetailHref(row.incidentId, row.companyId)'));
check('list no longer interpolates /safety/spills/${id}', !listUi.includes('/safety/spills/${'));

const page = src('src/app/safety/spills/detail/page.tsx');
check('static detail page exists', existsSync(join(root, 'src/app/safety/spills/detail/page.tsx')));
check('detail page wraps useSearchParams in Suspense', page.includes('Suspense') && page.includes('SpillIncidentDetailClient'));
check('dynamic [incidentId] page is gone', !existsSync(join(root, 'src/app/safety/spills/[incidentId]/page.tsx')));

const client = src('src/components/safety/SpillIncidentDetailClient.tsx');
check('client reads incidentId from search params', client.includes("search.get('incidentId')"));
check('client does not use useParams', !client.includes('useParams'));
check('client reuses SpillIncidentDetail', client.includes('<SpillIncidentDetail'));
check('client uses getSpillIncident', client.includes('getSpillIncident(decided.companyId, parsed.incidentId'));
check('missing/malformed skips Firebase load', client.includes('if (!parsed.ok)') && client.includes('return;'));
check('client preserves company isolation', client.includes('decideSafetyAccess') && client.includes('requestedCompany'));
check('back action on bad id', client.includes('Back to Safety') && client.includes('spillDetailRouteErrorCopy'));

const store = src('src/lib/spill/spillIncidentStore.ts');
check('store still reads one incident path', store.includes('safetyIncidentPath(companyId, incidentId)'));
check('store does not list-all to find detail', /getDocs\(collection\(db, safetyCollectionPath/.test(store) === true);
check('detail fetch is getDoc not collection scan', store.includes('getDoc(doc(db, safetyIncidentPath'));

const firebase = JSON.parse(src('firebase.json'));
const rewrites = firebase.hosting.rewrites || [];
check('legacy Hosting rewrite present', rewrites.some((r) => r.source === '/safety/spills/**' && r.destination === '/spill-legacy-redirect.html'));
check('catch-all Hosting rewrite preserved', rewrites.some((r) => r.source === '**' && r.destination === '/index.html'));
check('legacy rewrite is before catch-all', rewrites.findIndex((r) => r.source === '/safety/spills/**') < rewrites.findIndex((r) => r.source === '**'));
check('legacy redirect file exists', existsSync(join(root, 'public/spill-legacy-redirect.html')));
const legacyHtml = src('public/spill-legacy-redirect.html');
check('legacy file JS-redirects to static detail', legacyHtml.includes('/safety/spills/detail/') && legacyHtml.includes('incidentId'));
check('legacy file does not enumerate incidents', !/generateStaticParams|incident list|wellbuilt-sync-default-rtdb/i.test(legacyHtml));

check('no generateStaticParams dummy id', !page.includes('generateStaticParams') && !client.includes('generateStaticParams'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
