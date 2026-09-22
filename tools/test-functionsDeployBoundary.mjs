/**
 * vc51.9A9B — Functions deployment boundary: credential-free proof.
 *
 * RED-FIRST: against the pre-correction boundary this suite FAILS —
 * the Functions lockfile resolved @tester3x/wellbuilt-contracts from
 * npm.pkg.github.com and functions/.npmrc referenced ${NODE_AUTH_TOKEN},
 * so Google's builder (no GitHub token, no user .npmrc) could not
 * install. The correction makes functions/ self-contained via the
 * generated immutable contracts mirror.
 *
 * The scratch proof copies ONLY the functions deployment inputs to a
 * clean directory and runs `npm ci` with a FRESH empty npm cache and
 * every token variable absent — an authenticated cache can never fake
 * this pass.
 *
 * Run: node tools/test-functionsDeployBoundary.mjs   (slow: real npm ci)
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FN = join(root, 'functions');
const VENDOR_TARBALL = join(FN, 'vendor', 'tester3x-wellbuilt-contracts-0.7.0.tgz');
const EXPECTED_SHA256 = '84ac379ffb121cb1ba151ca0b950ba07c30bbcf5881fb92775b5c43ea0348de3';
const EXPECTED_INTEGRITY = 'sha512-SigPNgHMJ9XSWUkdqIbkPgki7rqodYv6dn3N/VJ9I8NGHNA4nBn/cizYoq+vJGX+2p/BFQ0tKEoL2Vl0UgFKiw==';
const EXPECTED_SIZE = 163734;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ── 1. The functions dependency tree must not reference the private registry.
{
  const lock = readFileSync(join(FN, 'package-lock.json'), 'utf8');
  check('functions lockfile has zero npm.pkg.github.com references',
    !lock.includes('npm.pkg.github.com'));
  const pkg = JSON.parse(readFileSync(join(FN, 'package.json'), 'utf8'));
  const dep = pkg.dependencies?.['@tester3x/wellbuilt-contracts'];
  check('functions depends on the vendored contracts tarball',
    dep === 'file:vendor/tester3x-wellbuilt-contracts-0.7.0.tgz', `dep=${dep}`);
}

// ── 2. The functions build boundary must not need ${NODE_AUTH_TOKEN}.
check('functions/.npmrc absent (no env token needed inside the boundary)',
  !existsSync(join(FN, '.npmrc')));
check('Dashboard root .npmrc still serves the registry consumer',
  readFileSync(join(root, '.npmrc'), 'utf8').includes('${NODE_AUTH_TOKEN}'));
{
  const rootLock = readFileSync(join(root, 'package-lock.json'), 'utf8');
  check('Dashboard CLIENT still resolves the registry package normally',
    rootLock.includes('npm.pkg.github.com/download/@tester3x/wellbuilt-contracts/'));
}

// ── 3. Vendored tarball integrity: authentic Contracts 0.7.0 artifact.
{
  check('vendored tarball exists inside functions/vendor', existsSync(VENDOR_TARBALL));
  if (existsSync(VENDOR_TARBALL)) {
    const actualHash = sha256(VENDOR_TARBALL);
    check('tarball matches pinned sha256', actualHash === EXPECTED_SHA256, actualHash);
    const { size } = statSync(VENDOR_TARBALL);
    check('tarball matches pinned size (163,734 bytes)', size === EXPECTED_SIZE, `size=${size}`);
    const fnLock = JSON.parse(readFileSync(join(FN, 'package-lock.json'), 'utf8'));
    const entry = fnLock.packages?.['vendor/tester3x-wellbuilt-contracts-0.7.0.tgz']
      || fnLock.packages?.['node_modules/@tester3x/wellbuilt-contracts'];
    check('lockfile records authentic integrity for the tarball',
      entry?.integrity === EXPECTED_INTEGRITY, entry?.integrity);
    check('lockfile records version 0.7.0 for the tarball', entry?.version === '0.7.0', entry?.version);
  }
}

// ── 4. Verifier tool guards: mirror is absent, g018 integrity suite is present.
{
  const tool = join(FN, 'tools', 'mirror-contracts.mjs');
  const mirrorDir = join(FN, 'contracts-mirror');
  const integritySuite = join(FN, 'src', 'security', '__tests__', 'g018ContractsBundleIntegrity.test.ts');
  check('stale mirror verifier tool is absent', !existsSync(tool));
  check('stale contracts-mirror directory is absent', !existsSync(mirrorDir));
  check('g018 contracts bundle integrity suite is present', existsSync(integritySuite));
}

// ── 5. THE PROOF: clean scratch install with no tokens, fresh cache.
{
  const scratch = process.env.FN_BOUNDARY_SCRATCH
    ?? join(tmpdir(), `fn-boundary-${Date.now()}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, 'cache'), { recursive: true });
  for (const item of ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'vendor']) {
    const from = join(FN, item);
    if (existsSync(from)) cpSync(from, join(scratch, item), { recursive: true });
  }
  // Empty userconfig so no ambient .npmrc can leak credentials into the proof.
  writeFileSync(join(scratch, 'empty-npmrc'), '');
  const env = { ...process.env };
  for (const k of ['NODE_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'NPM_AUTH_TOKEN']) delete env[k];
  env.npm_config_cache = join(scratch, 'cache');
  env.npm_config_userconfig = join(scratch, 'empty-npmrc');
  let installed = false, detail = '';
  try {
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: scratch, env, stdio: 'pipe', shell: true, timeout: 540_000 });
    installed = true;
  } catch (e) {
    detail = String(e.stderr ?? e.message).slice(-300);
  }
  check('clean token-free scratch npm ci succeeds (fresh cache — Google-builder equivalent)', installed, detail);
  if (installed) {
    const resolvedPkg = join(scratch, 'node_modules', '@tester3x', 'wellbuilt-contracts');
    check('scratch resolves the contracts package locally', existsSync(join(resolvedPkg, 'dist', 'index.js')));
    const resolvedPkgJson = JSON.parse(readFileSync(join(resolvedPkg, 'package.json'), 'utf8'));
    check('scratch-resolved package is 0.7.0', resolvedPkgJson.version === '0.7.0');
    let built = false;
    try {
      execFileSync('npx', ['tsc'], { cwd: scratch, env, stdio: 'pipe', shell: true, timeout: 300_000 });
      built = true;
    } catch (e) { detail = String(e.stdout ?? e.message).slice(-300); }
    check('functions build+typecheck succeeds in the token-free scratch', built, detail);
    // Behavior identity through the scratch-resolved copy.
    const probe = `
      const m = require('@tester3x/wellbuilt-contracts');
      const t = require('@tester3x/wellbuilt-contracts/transport');
      if (typeof t.resolveExecutionBinding !== 'function') throw new Error('missing resolveExecutionBinding');
      console.log('contracts-ok', Object.keys(m).length, Object.keys(t).length);
    `;
    let conf = '';
    try {
      conf = execFileSync(process.execPath, ['-e', probe], { cwd: scratch, env, encoding: 'utf8' }).trim();
    } catch (e) { conf = String(e.message); }
    check('contracts runtime + transport exports resolve cleanly in scratch',
      conf.startsWith('contracts-ok'), conf);
  }
  rmSync(scratch, { recursive: true, force: true });
}

// ── 6. vc51.9I-SEC: credential-bearing deployment inventories cannot ship.
// `firebase functions:list --json` / `gcloud functions list` embed each
// function's environmentVariables verbatim. One such dump sat untracked
// inside functions/ carrying live provider API keys, deployable because
// firebase.json declared no ignore list. Prove all three layers, not just
// .gitignore — git cannot stop an upload, and .gitignore is not consulted
// by the Firebase packager at all.
{
  const INVENTORY_NAMES = [
    '_phase1-deployed.json', '_phase2-deployed.json',
    'prod-deployed.json', 'deployment-inventory.json', 'functions-list.json',
  ];
  const REQUIRED_IN_UPLOAD = [
    'package.json', 'package-lock.json', 'tsconfig.json',
    'src/index.ts', 'vendor/tester3x-wellbuilt-contracts-0.7.0.tgz',
  ];

  // (a) The real file is gone.
  check('the exposed deployment inventory is absent from the working tree',
    !existsSync(join(FN, '_phase1-deployed.json')));

  // (b) No inventory is tracked anywhere in the repo.
  const trackedInv = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' })
    .trim().split('\n')
    .filter((f) => !f.includes('__tests__') && /(^|\/)(_[^/]*|.*-deployed|deployment-inventory|functions-list)\.json$/.test(f));
  check('no credential-bearing deployment inventory is tracked', trackedInv.length === 0, trackedInv.join(','));

  // (c) Git layer — synthetic artifacts are ignored.
  const gitIgnored = INVENTORY_NAMES.filter((n) => {
    const p = join(FN, n);
    writeFileSync(p, '{"synthetic":"not-a-real-inventory"}');
    let ok = false;
    try { execFileSync('git', ['-C', root, 'check-ignore', '-q', p], { stdio: 'pipe' }); ok = true; } catch { ok = false; }
    rmSync(p, { force: true });
    return ok;
  });
  check('git ignores every deployment-inventory shape',
    gitIgnored.length === INVENTORY_NAMES.length,
    `${gitIgnored.length}/${INVENTORY_NAMES.length}`);

  // (d) Firebase packager layer. firebase.json ignore entries are resolved
  // RELATIVE TO functions.source, so they are bare ("_*.json"), not
  // "functions/_*.json". Setting `ignore` also REPLACES the CLI defaults,
  // so the defaults must be restated or node_modules would start uploading.
  const fb = JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8'));
  const ignore = fb.functions?.ignore ?? [];
  check('firebase.json declares a functions ignore list', ignore.length > 0);
  check('firebase ignore patterns are source-relative (not prefixed with "functions/")',
    ignore.every((p) => !p.startsWith('functions/')), ignore.filter((p) => p.startsWith('functions/')).join(','));
  for (const d of ['node_modules', '.git', 'firebase-debug.log']) {
    check(`firebase ignore restates CLI default "${d}" (ignore replaces defaults)`, ignore.includes(d));
  }
  const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
  const fbExcluded = (rel) => ignore.some((g) => globToRe(g).test(rel) || rel.split('/')[0] === g);
  check('firebase ignore excludes every deployment-inventory shape',
    INVENTORY_NAMES.every(fbExcluded),
    INVENTORY_NAMES.filter((n) => !fbExcluded(n)).join(','));
  check('firebase ignore excludes credential-bearing config (.npmrc/.env/serviceAccountKey)',
    ['.npmrc', '.env', 'serviceAccountKey.json'].every(fbExcluded));
  check('firebase ignore keeps every required deployment input',
    REQUIRED_IN_UPLOAD.every((f) => !fbExcluded(f)),
    REQUIRED_IN_UPLOAD.filter(fbExcluded).join(','));
  // lib/ is gitignored but IS the compiled entry point — it must upload.
  check('firebase ignore does not exclude the compiled entry point (lib/)', !fbExcluded('lib/index.js'));
  check('firebase ignore does not exclude the vendored contracts tarball', !fbExcluded('vendor/tester3x-wellbuilt-contracts-0.7.0.tgz'));

  // (e) gcloud layer — documentary/supplementary packaging path.
  const gcPath = join(FN, '.gcloudignore');
  check('functions/.gcloudignore exists (documentary/supplementary)', existsSync(gcPath));
  if (existsSync(gcPath)) {
    const gc = readFileSync(gcPath, 'utf8');
    const lines = gc.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const gcExcluded = (rel) => lines.some((g) => globToRe(g).test(rel) || rel.split('/')[0] === g);
    check('.gcloudignore excludes every deployment-inventory shape',
      INVENTORY_NAMES.every(gcExcluded),
      INVENTORY_NAMES.filter((n) => !gcExcluded(n)).join(','));
    check('.gcloudignore excludes credential-bearing config',
      ['.npmrc', '.env', 'serviceAccountKey.json'].every(gcExcluded));
    check('.gcloudignore keeps every required deployment input',
      REQUIRED_IN_UPLOAD.every((f) => !gcExcluded(f)),
      REQUIRED_IN_UPLOAD.filter(gcExcluded).join(','));
    check('.gcloudignore does not exclude lib/ or the vendor tarball',
      !gcExcluded('lib/index.js') && !gcExcluded('vendor/tester3x-wellbuilt-contracts-0.7.0.tgz'));
    // `#!include:.gitignore` would pull in .gitignore and drop lib/. It is a
    // directive only at the start of a line, so match that shape rather than
    // any mention — the file explains in prose why it avoids the directive.
    check('.gcloudignore does not delegate to .gitignore',
      !gc.split('\n').some((l) => l.trim().startsWith('#!include')));
  }

  // (f) Simulated source archive: nothing credential-bearing survives.
  const archive = execFileSync('git', ['-C', root, 'ls-files', 'functions'], { encoding: 'utf8' })
    .trim().split('\n')
    .filter((f) => { const rel = f.replace(/^functions\//, ''); return !fbExcluded(rel); });
  check('simulated deployment source set contains no inventory/credential file',
    !archive.some((f) => /(-deployed|deployment-inventory|functions-list)\.json$|(^|\/)_[^/]*\.json$|(^|\/)\.npmrc$|(^|\/)\.env/.test(f)));
  check('simulated deployment source set still contains the vendored contracts tarball',
    archive.some((f) => f === 'functions/vendor/tester3x-wellbuilt-contracts-0.7.0.tgz'));
  check('simulated deployment source set still contains Functions source',
    archive.some((f) => f === 'functions/src/index.ts'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
