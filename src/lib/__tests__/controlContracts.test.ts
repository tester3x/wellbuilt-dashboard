/**
 * Dashboard control-contract tests.
 *
 * A rendered button is not "working" merely because a callable is deployed —
 * the chain control→handler→callable→payload→capability→response/error UI must
 * hold. These tests mechanically catch the failure classes called out in the
 * button-recovery packet: missing/wrong callable names, legacy rules-denied
 * direct writes, dead/no-op buttons, and regressions of the governed baseline.
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/controlContracts.test.ts
 *
 * Pure static analysis over source + a committed snapshot of the deployed
 * callable inventory. No Firebase, no network, no production calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../', import.meta.url)); // .../src/
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const DEPLOYED: { names: string[] } = JSON.parse(read('./deployedCallables.json'));
const deployedSet = new Set(DEPLOYED.names);

/**
 * Callables the Dashboard invokes that are NOT deployed. Each is BLOCKED on a
 * backend/security dependency owned outside the Dashboard lane. When a backend
 * deploys one, this list must shrink (a test below enforces that).
 */
const KNOWN_BLOCKED_MISSING: Record<string, string> = {
  updateSpillNotificationPolicy: 'BLOCKED: deploy the spill-notification-policy callable (no deployed target).',
  staffBackfillDieselPrices: 'BLOCKED: deploy a governed diesel-backfill callable (only triggerDieselFetch/weeklyDieselPriceFetch exist).',
  staffRetireLegacyDriverLogin: 'BLOCKED: driver-identity lane (Laptop ChatGPT) — deploy retire-legacy-login callable.',
  staffHydrateCanonicalIdentity: 'BLOCKED: driver-identity lane (Laptop ChatGPT) — deploy hydrate-canonical-identity callable.',
};

/** Callable names reached via a constant/adapter, not a string literal in the httpsCallable call. */
const KNOWN_INDIRECT_CALLABLES = ['adminSubmitPullEdit'];

/**
 * Callables AUTHORED in this branch (functions/src) that are not yet in the
 * deployed snapshot — code-path verified + emulator-tested here, pending a
 * backend deploy (lineage reconciliation). Distinct from BLOCKED-missing.
 */
const KNOWN_NEW_PENDING_DEPLOY: Record<string, string> = {
  staffSubmitManualPull: 'NEW (Priority 1): governed dispatcher/admin manual-pull callable authored + emulator-tested; pending backend deploy.',
};

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true, recursive: true }) as Array<{ name: string; parentPath?: string; path?: string; isFile(): boolean }>) {
    if (!ent.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(ent.name)) continue;
    if (ent.name.endsWith('.test.ts') || ent.name.endsWith('.test.tsx')) continue;
    const base = (ent.parentPath ?? ent.path ?? dir);
    out.push(`${base}/${ent.name}`);
  }
  return out;
}

function scanCallableLiterals(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const re = /httpsCallable\s*(?:<[^>]*>)?\s*\(\s*[^,]+,\s*'([^']+)'\s*\)/g;
  for (const file of walkTsx(SRC)) {
    const body = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const name = m[1];
      if (!found.has(name)) found.set(name, []);
      found.get(name)!.push(file.replace(SRC, 'src/'));
    }
  }
  return found;
}

test('every httpsCallable name is DEPLOYED or explicitly BLOCKED (catches missing/wrong names)', () => {
  const called = scanCallableLiterals();
  const unknown: string[] = [];
  for (const name of called.keys()) {
    if (deployedSet.has(name)) continue;
    if (name in KNOWN_BLOCKED_MISSING) continue;
    if (name in KNOWN_NEW_PENDING_DEPLOY) continue;
    unknown.push(name);
  }
  assert.deepEqual(unknown, [], `Callable(s) neither deployed nor documented-blocked: ${unknown.join(', ')}`);
});

test('indirect (adapter/constant) callables are deployed', () => {
  for (const name of KNOWN_INDIRECT_CALLABLES) {
    assert.ok(deployedSet.has(name), `${name} must be in the deployed inventory`);
  }
});

test('BLOCKED-missing callables are genuinely absent from the deployed inventory (shrink list when backend ships)', () => {
  for (const name of Object.keys(KNOWN_BLOCKED_MISSING)) {
    assert.ok(!deployedSet.has(name), `${name} is now deployed — remove it from KNOWN_BLOCKED_MISSING and wire/verify the control.`);
  }
});

// ── governed baseline must not regress (live 2b52c0cc) ───────────────────────

test('BASELINE: governed pull edit wired to adminSubmitPullEdit; no client packets/incoming write', () => {
  const core = read('../pullEditCore.ts');
  const wrap = read('../pullEdit.ts');
  assert.match(core, /ADMIN_PULL_EDIT_CALLABLE\s*=\s*'adminSubmitPullEdit'/);
  assert.ok(!/set\s*\(\s*ref\s*\(/.test(wrap) && !/packets\/incoming\/\$\{/.test(wrap), 'pullEdit must not direct-write packets/incoming');
});

test('BASELINE: governed pull delete wired to staffDeletePull', () => {
  assert.match(read('../pullDelete.ts'), /httpsCallable\([^,]+,\s*'staffDeletePull'\)/);
});

test('BASELINE: Photo Review approve wired to reviewDispatchPhoto; tab present', () => {
  assert.match(read('../../app/photo-review/page.tsx'), /reviewDispatchPhoto/);
  assert.match(read('../tabs.ts'), /id:\s*'photo-review'/);
});

// ── Add Well: governed, payload-compatible, NO direct-write fallback ─────────

test('Add Well: staffCreateWellConfig sends the exact create-only contract {op:create,wellName,config}', () => {
  const adapter = read('../staffWriteWellConfig.ts');
  // create adapter → op:'create'
  const createBlock = adapter.slice(adapter.indexOf('staffCreateWellConfig'), adapter.indexOf('staffUpdateWellConfig'));
  assert.match(createBlock, /httpsCallable\([^,]+,\s*'staffWriteWellConfig'\)/);
  assert.match(createBlock, /op:\s*'create'/);
  assert.match(createBlock, /wellName:/);
  assert.match(createBlock, /config:/);
});

test('Add Well: handler has NO direct-write fallback to well_config', () => {
  const admin = read('../../app/admin/page.tsx');
  const start = admin.indexOf('const handleAddWell');
  const body = admin.slice(start, admin.indexOf('const handleUpdateWell', start));
  assert.ok(start >= 0 && body.length > 0, 'handleAddWell must exist');
  assert.ok(!/set\s*\(\s*ref\s*\(\s*db\s*,\s*`?well_config/.test(body), 'handleAddWell must not direct-write well_config');
  assert.match(body, /staffCreateWellConfig\(/);
});

// ── Save Changes: CONTRACT-BLOCKED (op:update vs create-only server) ─────────

test('CONTRACT GAP: Save Changes sends op:update but deployed staffWriteWellConfig is create-only (BLOCKED)', () => {
  const adapter = read('../staffWriteWellConfig.ts');
  const updateBlock = adapter.slice(adapter.indexOf('staffUpdateWellConfig'));
  assert.match(updateBlock, /op:\s*'update'/, 'update adapter sends op:update');
  assert.ok(deployedSet.has('staffWriteWellConfig'), 'target callable is deployed (but create-only)');
  // Documented dependency: backend must add op:update support (or a staffUpdateWellConfig callable).
  // When that ships, add an emulator/contract verification and reclassify Save Changes to WORKING.
});

// ── +Add Pull: rules-denied direct write, no governed dashboard target (BLOCKED) ─

test('+Add Pull is now GOVERNED: no direct packets/incoming write; routes through submitManualPull', () => {
  const modal = read('../../components/AddPullModal.tsx');
  // The legacy rules-denied direct write is gone.
  assert.ok(!/set\s*\(\s*ref\s*\([^)]*packets\/incoming/.test(modal), 'AddPullModal must not direct-write packets/incoming');
  // The pull now goes through the governed manual-pull adapter.
  assert.match(modal, /submitManualPull\(/, 'AddPullModal must submit via submitManualPull');
  // Adapter targets the new callable; core carries no commercial projection.
  const adapter = read('../staffSubmitManualPull.ts');
  assert.match(adapter, /MANUAL_PULL_CALLABLE\s*=\s*'staffSubmitManualPull'/);
});
