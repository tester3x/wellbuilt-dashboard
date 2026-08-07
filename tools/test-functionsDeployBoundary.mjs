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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FN = join(root, 'functions');
const MIRROR = join(FN, 'contracts-mirror');
const EXPECTED_SHA256 = 'aa99296cdd71d94322a1e36862177de427a32301d034aacbdc1b03010e8c171f';
const EXPECTED_INTEGRITY = 'sha512-uf6QuaWGloxvsnphgOM8SVINNLkv6scBLvdfRf9LCz+iBSwMxw3A2/4CQSyQMI5cfK6YhaZr9HCNYE8StjJtoQ==';

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
  check('functions depends on the local deployment mirror',
    dep === 'file:contracts-mirror', `dep=${dep}`);
}

// ── 2. The functions build boundary must not need ${NODE_AUTH_TOKEN}.
check('functions/.npmrc absent (no env token needed inside the boundary)',
  !existsSync(join(FN, '.npmrc')));
check('Dashboard root .npmrc still serves the registry consumer',
  readFileSync(join(root, '.npmrc'), 'utf8').includes('${NODE_AUTH_TOKEN}'));
{
  const rootLock = readFileSync(join(root, 'package-lock.json'), 'utf8');
  check('Dashboard CLIENT still resolves the registry package normally',
    rootLock.includes('npm.pkg.github.com/download/@tester3x/wellbuilt-contracts/0.2.0'));
}

// ── 3. Mirror integrity: generated from the immutable published bytes.
{
  check('mirror exists inside the functions deployment boundary', existsSync(MIRROR));
  const manifestPath = join(MIRROR, 'MIRROR-MANIFEST.json');
  check('mirror manifest present', existsSync(manifestPath));
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    check('manifest pins the published source sha256', manifest.sourceSha256 === EXPECTED_SHA256);
    check('manifest pins the published npm integrity', manifest.sourceIntegrity === EXPECTED_INTEGRITY);
    check('manifest pins name and version',
      manifest.name === '@tester3x/wellbuilt-contracts' && manifest.version === '0.2.0');
    const drift = Object.entries(manifest.files).filter(([f, h]) => {
      const p = join(MIRROR, f);
      return !existsSync(p) || sha256(p) !== h;
    });
    check('every mirror file matches its manifest hash (no drift, no tamper)',
      drift.length === 0, drift.map(([f]) => f).join(','));
    const pkg = JSON.parse(readFileSync(join(MIRROR, 'package.json'), 'utf8'));
    check('mirror package identity/license/repository retained',
      pkg.name === '@tester3x/wellbuilt-contracts' && pkg.version === '0.2.0'
      && pkg.license === 'UNLICENSED' && pkg.repository?.url?.includes('tester3x/wellbuilt-contracts'));
    const everything = execFileSync('git', ['-C', root, 'ls-files', 'functions/contracts-mirror'], { encoding: 'utf8' })
      .trim().split('\n');
    const allowed = ['MIRROR-MANIFEST.json', 'MIRROR-README.md', 'NOTICE', 'README.md', 'package.json'];
    const stray = everything.map((f) => f.replace('functions/contracts-mirror/', ''))
      // Mirrors the generator's ALLOWED_RE: 0.2.0 nests the DVIR
      // protocol under dist/dvir/, so one subdirectory level is allowed.
      .filter((f) => !allowed.includes(f)
        && !/^dist\/(?:[\w-]+\/)?[\w.-]+\.(js|d\.ts|js\.map|d\.ts\.map)$/.test(f));
    check('mirror contains ONLY the allowlisted deployment files', stray.length === 0, stray.join(','));
  }
  // No token/credential strings anywhere in the mirror.
  if (existsSync(MIRROR)) {
    // The published README's `_authToken=${NODE_AUTH_TOKEN}` placeholder
    // is inert documentation inside byte-exact published content; only
    // LITERAL credential values are forbidden.
    let grep = '';
    try {
      grep = execFileSync('git', ['-C', root, 'grep', '-l', '-iE',
        'ghp_[A-Za-z0-9]|gho_[A-Za-z0-9]|_authToken=[^$]|private[_ ]key|BEGIN [A-Z ]*PRIVATE', '--', 'functions/contracts-mirror'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { /* git grep exits 1 when nothing matches — the clean case */ }
    check('no literal token or credential value in the mirror', grep === '', grep);
  }
}

// ── 4. Verifier tool guards: tamper / wrong version / missing file fail.
{
  const tool = join(FN, 'tools', 'mirror-contracts.mjs');
  check('mirror verifier tool exists', existsSync(tool));
  if (existsSync(tool)) {
    const run = (dir) => {
      try {
        execFileSync(process.execPath, [tool, '--verify', '--mirror', dir], { stdio: 'pipe' });
        return true;
      } catch { return false; }
    };
    check('verifier passes on the committed mirror', run(MIRROR));
    const tmp = join(tmpdir(), `mirror-guard-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    cpSync(MIRROR, tmp, { recursive: true });
    writeFileSync(join(tmp, 'dist', 'index.js'), '// tampered\n', { flag: 'a' });
    check('tampered bytes fail verification', !run(tmp));
    rmSync(tmp, { recursive: true, force: true });
    cpSync(MIRROR, tmp, { recursive: true });
    const m = JSON.parse(readFileSync(join(tmp, 'MIRROR-MANIFEST.json'), 'utf8'));
    // Must be a version the mirror will never legitimately hold — 0.2.0
    // is now the expected version, so it would no longer be "wrong".
    m.version = '9.9.9';
    writeFileSync(join(tmp, 'MIRROR-MANIFEST.json'), JSON.stringify(m));
    check('wrong package version fails verification', !run(tmp));
    rmSync(tmp, { recursive: true, force: true });
    cpSync(MIRROR, tmp, { recursive: true });
    rmSync(join(tmp, 'dist', 'resolver.js'));
    check('missing deployment material fails verification', !run(tmp));
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 5. THE PROOF: clean scratch install with no tokens, fresh cache.
{
  const scratch = process.env.FN_BOUNDARY_SCRATCH
    ?? join(tmpdir(), `fn-boundary-${Date.now()}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, 'cache'), { recursive: true });
  for (const item of ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'contracts-mirror']) {
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
    const manifest = JSON.parse(readFileSync(join(MIRROR, 'MIRROR-MANIFEST.json'), 'utf8'));
    const distDrift = Object.keys(manifest.files).filter((f) => f.startsWith('dist/'))
      .filter((f) => sha256(join(resolvedPkg, f)) !== manifest.files[f]);
    check('scratch-resolved bytes ARE the immutable 0.2.0 bytes', distDrift.length === 0, distDrift.join(','));
    let built = false;
    try {
      execFileSync('npx', ['tsc'], { cwd: scratch, env, stdio: 'pipe', shell: true, timeout: 300_000 });
      built = true;
    } catch (e) { detail = String(e.stdout ?? e.message).slice(-300); }
    check('functions build+typecheck succeeds in the token-free scratch', built, detail);
    // Behavior identity through the scratch-resolved copy.
    const probe = `
      const m = require('@tester3x/wellbuilt-contracts');
      const c = require('@tester3x/wellbuilt-contracts/conformance');
      let n = 0;
      for (const t of [...c.CONFORMANCE_CASES, ...c.MIXED_WORKFLOW_CASES]) {
        const r = m.resolveWorkPeriod(t.input);
        if (r.outcome !== t.expect.outcome) throw new Error(t.name);
        n++;
      }
      try { m.assertContractCompatible(99, 'probe'); throw new Error('accepted'); }
      catch (e) { if (!String(e.message).includes('cannot consume')) throw e; }
      console.log('conformance', n);
    `;
    let conf = '';
    try {
      conf = execFileSync(process.execPath, ['-e', probe], { cwd: scratch, env, encoding: 'utf8' }).trim();
    } catch (e) { conf = String(e.message); }
    check('conformance behavior identical + unknown versions fail closed (scratch copy)',
      conf === 'conformance 24', conf);
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
    'src/index.ts', 'contracts-mirror/package.json',
    'contracts-mirror/dist/index.js', 'contracts-mirror/dist/dvir/protocol.js',
    'contracts-mirror/MIRROR-MANIFEST.json',
  ];

  // (a) The real file is gone.
  check('the exposed deployment inventory is absent from the working tree',
    !existsSync(join(FN, '_phase1-deployed.json')));

  // (b) No inventory is tracked anywhere in the repo.
  const trackedInv = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' })
    .trim().split('\n')
    .filter((f) => /(^|\/)(_.*|.*-deployed|.*deployment-inventory.*|functions-list.*)\.json$/.test(f));
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

  // (e) gcloud layer — an independent packaging path.
  const gcPath = join(FN, '.gcloudignore');
  check('functions/.gcloudignore exists (gcloud packages independently)', existsSync(gcPath));
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
    check('.gcloudignore does not exclude lib/ or the contracts mirror',
      !gcExcluded('lib/index.js') && !gcExcluded('contracts-mirror/dist/index.js'));
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
  check('simulated deployment source set still contains the contracts mirror',
    archive.some((f) => f.startsWith('functions/contracts-mirror/dist/')));
  check('simulated deployment source set still contains Functions source',
    archive.some((f) => f === 'functions/src/index.ts'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
