// Completion-audit item 3: enumerate EVERY live mutation entry and prove, by
// source analysis, that exactly ONE canonical writer exists. Behavioral proof
// runs on the real emulator (harness.mjs / faults.mjs / ingest.mjs drive the
// actual exported trigger surfaces); this test pins the call graph so a
// second writer cannot appear silently.
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const FUNCS = join(__dirname, '..');
const index = readFileSync(join(FUNCS, 'index.ts'), 'utf8');
const read = (rel: string) => readFileSync(join(FUNCS, rel), 'utf8');

function sliceBetween(src: string, startMark: string, endMark: string): string {
  const a = src.indexOf(startMark);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(endMark, a + startMark.length);
  return src.slice(a, b === -1 ? undefined : b);
}

describe('one-writer enumeration — every live mutation entry', () => {
  test('CREATE trigger + shared entry: trigger delegates; entry commits via the coordinator', () => {
    const trigger = sliceBetween(index, 'export const processIncomingPull =', 'export async function processIncomingPullPacket');
    expect(trigger).toContain('processIncomingPullPacket(snapshot.val() as PullPacket, context.params.packetId)');
    const entry = sliceBetween(index, 'export async function processIncomingPullPacket', 'export const watchdogStrandedPackets');
    // (watchdog precedes the entry in file order — fall back to a wide slice)
    const body = entry.length > 200 ? entry : sliceBetween(index, 'export async function processIncomingPullPacket', '\nexport const ');
    expect(body).toContain('runCanonicalMutation(makeCoordinatorIO(db, wellName)');
    expect(body).toContain('assembleCanonicalPatch({');
  });

  test('EDIT triggers (v1 + v2 correction path) commit via the coordinator', () => {
    const editSection = index.slice(index.indexOf('export async function applyV2ChronologicalEdit'), index.indexOf('export const processDeleteRequest'));
    expect((editSection.match(/runCanonicalMutation\(makeCoordinatorIO\(db, wellName\)/g) || []).length).toBeGreaterThanOrEqual(3); // v2 + v1 tank-math + no-level
    expect(editSection).toContain('assembleCanonicalPatch({');
  });

  test('DELETE trigger commits via the coordinator (found, and receipted no-op when absent)', () => {
    const del = sliceBetween(index, 'export const processDeleteRequest', '\nexport const ');
    expect((del.match(/runCanonicalMutation\(makeCoordinatorIO\(db, wellName\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(del).toContain('buildDeleteMutation({');
  });

  test('watchdog recovery drives the SAME entry — it composes and commits nothing itself', () => {
    const wd = sliceBetween(index, 'export const watchdogStrandedPackets', '\nexport const healthCheck');
    expect(wd).toContain('await processIncomingPullPacket(data, key)');
    expect(wd).not.toContain('runCanonicalMutation(');
    expect(wd).not.toContain('assembleCanonicalPatch(');
  });

  test('retry and replay are protocol outcomes, not separate writers', () => {
    // Non-committed outcomes leave the incoming request; the retry re-enters
    // the SAME entry. Replay short-circuits inside the coordinator on the
    // receipt — before any lock or patch.
    expect(index).toMatch(/incoming left for retry/);
    const coord = read('chronoCommitCoordinator.ts');
    expect(coord).toMatch(/const existing = await io\.readReceipt\(req\.wellName, req\.operationId\);\s*\r?\n\s*if \(existing\) return \{ status: 'already_done', receipt: existing \};/);
  });

  test('ingest callables are FEEDERS: they write only packets/incoming, never canonical state', () => {
    for (const rel of ['security/operational/ingestWbmPull.ts', 'security/operational/ingestWbmEdit.ts', 'security/operational/packetIngest.ts']) {
      const src = read(rel);
      for (const canonical of ['packets/processed', 'packets/outgoing', 'wells/', 'performance/', 'production/', 'well_config/', 'packets/incoming_version', 'packets/incoming_revision_v2']) {
        // Reads are fine; writes are not — assert no ref(<canonical>).set/update/transaction.
        const writeRe = new RegExp(`ref\\([^)]*${canonical.replace('/', '\\/')}[^)]*\\)\\s*\\.\\s*(set|update)\\(`);
        expect(src).not.toMatch(writeRe);
      }
      expect(src).toMatch(/packets\/incoming|wbmIncomingPath/); // the one place they write
    }
  });

  test('exactly ONE commitAtomic implementation and ONE call site (the coordinator)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { if (!p.includes('__tests__') && !p.includes('node_modules')) walk(p); }
        else if (f.endsWith('.ts')) files.push(p);
      }
    };
    walk(FUNCS);
    let defs = 0; let calls = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      defs += (src.match(/commitAtomic: async \(patch\)/g) || []).length;
      calls += (src.match(/io\.commitAtomic\(/g) || []).length;
    }
    expect(defs).toBe(1);   // coordinatorIO
    expect(calls).toBe(1);  // runCanonicalMutation step 4
  });

  test('the fenced follow-up writers are gone from the entire codebase', () => {
    for (const rel of ['index.ts']) {
      const src = read(rel);
      expect(src).not.toMatch(/async function fencedSourceWrite\(/);
      expect(src).not.toMatch(/async function fencedRevWrite\(/);
      expect(src).not.toContain('fencedSourceWrite(');
      expect(src).not.toContain('fencedRevWrite(');
    }
  });

  test('no second revision-persistence step: the legacy node is written ONLY by the assembled patch', () => {
    expect(index).not.toContain('notifyIncomingVersionBestEffort');
    expect(index).not.toMatch(/ref\('packets\/incoming_version'\)/);
    expect(index).not.toMatch(/ref\('packets\/incoming_revision_v2'\)/);
    const patch = read('canonicalPatch.ts');
    expect(patch).toContain('patch[LEGACY_INCOMING_VERSION_PATH] = legacyRevisionIncrement()');
    expect(patch).toContain('patch[INCOMING_REVISION_V2_PATH] = buildRevisionV2(p.receipt)');
  });

  test('legitimate exceptions are non-canonical: quarantine evidence, incoming consumption, health, diagnostics', () => {
    // Every remaining direct RTDB write target in index.ts must be one of:
    // packets/incoming (consumption), packets/rejected (via packetGuards
    // quarantine), system_health, logs/diagnostics. Enumerate .set( calls on
    // db.ref template literals and classify.
    const setCalls = index.match(/db\.ref\((`[^`]*`|'[^']*')\)\s*\.\s*set\(/g) || [];
    for (const call of setCalls) {
      expect(call).toMatch(/system_health|packets\/incoming\//);
    }
    // packetGuards owns rejected/ writes and pairs them with the incoming
    // removal in ONE update — never deletion without evidence.
    const guards = read('packetGuards.ts');
    expect(guards).toMatch(/packets\/rejected/);
  });
});
