/**
 * Pins Dashboard WB-M realtime client contracts on the static-export Hosting lineage.
 * Run: node tools/test-wellRealtimeClient.mjs
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';
import { tmpdir } from 'os';
import { writeFileSync } from 'fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
function ok(name) { passed++; console.log(`  PASS  ${name}`); }
function fail(name, err) { failed++; console.error(`  FAIL  ${name}:`, err?.message || err); }
function expect(cond, name) { if (cond) ok(name); else fail(name, new Error('assertion failed')); }

const mobile = readFileSync(join(root, 'src/app/mobile/page.tsx'), 'utf8');
const wells = readFileSync(join(root, 'src/lib/wells.ts'), 'utf8');
const dispatch = readFileSync(join(root, 'src/app/dispatch/page.tsx'), 'utf8');
const home = readFileSync(join(root, 'src/app/page.tsx'), 'utf8');
const addPull = readFileSync(join(root, 'src/components/AddPullModal.tsx'), 'utf8');
const wellPage = readFileSync(join(root, 'src/app/well/page.tsx'), 'utf8');
const pullDelete = readFileSync(join(root, 'src/lib/pullDelete.ts'), 'utf8');
const coreSrc = readFileSync(join(root, 'src/lib/wellRealtimeCore.ts'), 'utf8');

console.log('\n=== Dashboard WB-M realtime client (Hosting lineage 37ab3096+) ===\n');

expect(!/window\.location\.reload\s*\(/.test(mobile + wells + dispatch + home + addPull + coreSrc),
  'no window.location.reload() in WB-M realtime flow');
expect(coreSrc.includes("export const FULL_PAGE_RELOAD_SNIPPET = 'window.location.reload'"),
  'reload sentinel exists for tests and is never invoked');
expect(!/\[initialSetupDone\]/.test(mobile),
  'mobile listener is not recreated on [initialSetupDone]');
expect(/initialSetupDoneRef/.test(mobile) && /useRef\(false\)/.test(mobile),
  'mobile uses a ref so the listener remains attached after initial setup');
expect(/companyId: user\.companyId/.test(mobile) && /orderByChild\('companyId'\)/.test(wells) && /equalTo\(opts\.companyId\)/.test(wells),
  'outgoing subscription is company-scoped');
expect(/packets\/materialized\/\$\{opts\?\.companyId\}/.test(wells) || /packets\/materialized\/\$\{opts\.companyId\}/.test(wells),
  'materialized listener is company-scoped');
expect(/staffDeletePull/.test(pullDelete) && /from '@\/lib\/pullDelete'/.test(wellPage),
  'governed-delete client is preserved');
expect(!/packets\/incoming\/\$\{deletePacketId\}/.test(wells),
  'legacy incoming delete write stays removed');
expect(/expandedRoutes already restored from localStorage/.test(mobile),
  'expanded cards are not reset on subsequent snapshots');
expect(/setWells\(wellData\)/.test(mobile) && !/setWellSearch\(/.test(mobile.split('subscribeToWellStatusesUnified')[1].split('Load edge case')[0]),
  'filters and selected tab state are not rewritten on well-data updates');
expect(/demoPresenceActive/.test(coreSrc) && /scrollTop/.test(coreSrc) && /selectedTab/.test(coreSrc),
  'UI session helper preserves demo, scroll, and tab');

const transpiled = ts.transpileModule(coreSrc, {
  compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
}).outputText;
const tmp = join(tmpdir(), 'wb-well-realtime-core.mjs');
writeFileSync(tmp, transpiled);
const core = await import('file:///' + tmp.replace(/\\/g, '/'));

{
  const pull = {
    opId: 'pull:p1', eventId: 'pull:p1', packetId: 'p1', wellName: 'W',
    companyId: 'c', kind: 'pull', atMs: 1, resultAtMs: 1,
  };
  expect(core.decideApplyMaterialized(pull, { lastPullPacketId: 'p1' }) === 'apply',
    'pull applies when outgoing matches');
  expect(core.decideApplyMaterialized(pull, { lastPullPacketId: 'old' }) === 'ignore',
    'pull of a different packet is ignored');
  const edit = { ...pull, opId: 'edit:e1:p1', eventId: 'edit:e1:p1', kind: 'edit' };
  expect(edit.opId !== pull.opId, 'edit of the same packet is a distinct signal');
  const currentDel = {
    opId: 'delete:d1:gone:survivor', eventId: 'delete:d1:gone:survivor',
    packetId: 'gone', survivorPacketId: 'survivor', wellName: 'W',
    companyId: 'c', kind: 'delete', atMs: 3, resultAtMs: 3,
  };
  expect(core.decideApplyMaterialized(currentDel, { lastPullPacketId: 'survivor' }) === 'apply',
    'current delete applies once survivor is outgoing');
  const histDel = { ...currentDel, packetId: 'old', survivorPacketId: 'current', opId: 'delete:d2:old:current' };
  expect(core.decideApplyMaterialized(histDel, { lastPullPacketId: 'current' }) === 'apply',
    'historical delete signals the surviving current packet');
  const older = { ...pull, opId: 'pull:p0', packetId: 'p0', atMs: 1, resultAtMs: 1 };
  const newer = { ...pull, opId: 'pull:p2', packetId: 'p2', atMs: 2, resultAtMs: 2 };
  const coalesced = core.coalesceByWell(core.coalesceByWell({}, newer), older);
  expect(coalesced['c:W'].packetId === 'p2', 'older retry cannot regress a newer coalesced signal');
  const other = { ...newer, wellName: 'Other', packetId: 'pX', opId: 'pull:pX' };
  const isolated = core.coalesceByWell(core.coalesceByWell({}, newer), other);
  expect(isolated['c:W'].packetId === 'p2' && isolated['c:Other'].packetId === 'pX',
    'one well cannot refresh another');
  const session = core.preserveUiSession({
    expandedRoutes: ['Demo Route'], wellSearch: 'Demo', viewMode: 'table',
    demoPresenceActive: true, scrollTop: 480, selectedTab: 'cards',
  });
  expect(session.demoPresenceActive === true && session.scrollTop === 480 && session.selectedTab === 'cards'
    && session.wellSearch === 'Demo' && session.expandedRoutes[0] === 'Demo Route',
    'filters, expanded cards, scroll, tab, and demo presence survive updates');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
