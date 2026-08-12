#!/usr/bin/env node
/**
 * vc51.9A9B — deterministic generator/verifier for the Functions
 * contracts deployment mirror.
 *
 *   node tools/mirror-contracts.mjs --verify [--mirror <dir>]
 *   node tools/mirror-contracts.mjs --regenerate --tarball <path>
 *
 * The mirror (functions/contracts-mirror) is GENERATED DEPLOYMENT
 * MATERIAL derived byte-for-byte from the immutable published
 * @tester3x/wellbuilt-contracts@0.2.0 artifact. It exists ONLY so
 * Google's Functions builder can `npm ci` without GitHub Packages
 * authentication. It is NOT a canonical source and must never be
 * edited by hand — regeneration verifies the source tarball's SHA-256
 * AND npm integrity before extracting, refuses any other bytes or
 * version, writes only the bounded allowlist, and records per-file
 * hashes in MIRROR-MANIFEST.json. --verify recomputes everything and
 * fails on any drift, tamper, wrong version, or missing file.
 *
 * A future contract release requires: publish the new immutable
 * version → regenerate with its tarball → separate reviewed commit.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export const EXPECTED = Object.freeze({
  name: '@tester3x/wellbuilt-contracts',
  version: '0.3.0',
  sourceSha256: 'c337f6080a7b8695d5c3f84820e85a99a0c2b0714eb12837d5b6e73f7aa0b8cd',
  sourceIntegrity: 'sha512-Nd84+d1dyQBXPTtpERACvg4LVxQfhJ9w1I/rLXjd30gB0hsKrJI+W9Vfmiv3p84H1VPgpQwgKUCK15rdAYk7Dg==',
});

const FN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MIRROR = join(FN_DIR, 'contracts-mirror');
const GENERATED_FILES = ['MIRROR-MANIFEST.json', 'MIRROR-README.md'];
// 0.2.0 nested the DVIR protocol under dist/dvir/; 0.3.0 adds dist/plan/
// (app entitlement), dist/sso/, and dist/auth/. All are one level deep,
// so this pattern is unchanged. Still bounded: only dist/**, only these
// four extensions, only [\w.-] segments — no traversal, no absolute
// paths, no arbitrary depth, nothing outside the allowlist.
const ALLOWED_RE = /^(package\.json|README\.md|NOTICE|dist\/(?:[\w-]+\/)?[\w.-]+\.(js|d\.ts|js\.map|d\.ts\.map))$/;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fileSha256 = (p) => sha256(readFileSync(p));
const fail = (msg) => { console.error(`MIRROR FAIL: ${msg}`); process.exit(1); };

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

function verifyTarball(tarballPath) {
  const bytes = readFileSync(tarballPath);
  if (sha256(bytes) !== EXPECTED.sourceSha256) fail(`tarball SHA-256 does not match the published ${EXPECTED.version} artifact`);
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  if (integrity !== EXPECTED.sourceIntegrity) fail(`tarball npm integrity does not match the published ${EXPECTED.version} artifact`);
  return bytes;
}

function regenerate(tarballPath, mirrorDir) {
  verifyTarball(tarballPath);
  const stage = join(tmpdir(), `contracts-mirror-stage-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  // Copy the tarball into the stage and extract with a RELATIVE path:
  // Windows drive-letter paths (D:/…) trip GNU tar's remote-host syntax.
  writeFileSync(join(stage, 'source.tgz'), readFileSync(tarballPath));
  execFileSync('tar', ['-xzf', 'source.tgz'], { cwd: stage, stdio: 'pipe' });
  rmSync(join(stage, 'source.tgz'));
  const pkgRoot = join(stage, 'package');
  const files = walk(pkgRoot).sort();
  const stray = files.filter((f) => !ALLOWED_RE.test(f));
  if (stray.length) fail(`published artifact contains unexpected files: ${stray.join(', ')}`);
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  if (pkg.name !== EXPECTED.name || pkg.version !== EXPECTED.version) {
    fail(`artifact is ${pkg.name}@${pkg.version}, expected ${EXPECTED.name}@${EXPECTED.version}`);
  }

  rmSync(mirrorDir, { recursive: true, force: true });
  mkdirSync(join(mirrorDir, 'dist'), { recursive: true });
  const manifestFiles = {};
  for (const f of files) {
    const bytes = readFileSync(join(pkgRoot, f));
    const dest = join(mirrorDir, f);
    // 0.2.0 has nested dist/dvir/ — create each file's parent.
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    manifestFiles[f] = sha256(bytes);
  }
  writeFileSync(join(mirrorDir, 'MIRROR-MANIFEST.json'), JSON.stringify({
    generatedBy: 'functions/tools/mirror-contracts.mjs',
    purpose: 'GENERATED DEPLOYMENT MATERIAL — not a canonical source',
    name: EXPECTED.name,
    version: EXPECTED.version,
    sourceSha256: EXPECTED.sourceSha256,
    sourceIntegrity: EXPECTED.sourceIntegrity,
    files: manifestFiles,
  }, null, 2) + '\n');
  writeFileSync(join(mirrorDir, 'MIRROR-README.md'), `# GENERATED deployment mirror — do not edit

Byte-for-byte extraction of the immutable published
\`${EXPECTED.name}@${EXPECTED.version}\` artifact
(SHA-256 \`${EXPECTED.sourceSha256}\`,
integrity \`${EXPECTED.sourceIntegrity}\`).

Exists ONLY so Google's Functions builder can \`npm ci\` this
dependency without GitHub Packages authentication. The published
package remains the sole canonical source; the Dashboard client,
WB-JSA, and WB-T keep their registry pins.

NEVER edit by hand — \`--verify\` (run by the test suites) fails on any
drift. A future contract release requires publishing the new immutable
version, regenerating with its tarball via
\`node tools/mirror-contracts.mjs --regenerate --tarball <path>\`,
and a separate reviewed commit.
`);
  rmSync(stage, { recursive: true, force: true });
  console.log(`mirror regenerated: ${files.length} files + manifest + readme`);
}

function verify(mirrorDir) {
  if (!existsSync(mirrorDir)) fail('mirror directory missing');
  const manifestPath = join(mirrorDir, 'MIRROR-MANIFEST.json');
  if (!existsSync(manifestPath)) fail('MIRROR-MANIFEST.json missing');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== EXPECTED.name || manifest.version !== EXPECTED.version) {
    fail(`manifest identity ${manifest.name}@${manifest.version} does not match expected ${EXPECTED.name}@${EXPECTED.version}`);
  }
  if (manifest.sourceSha256 !== EXPECTED.sourceSha256 || manifest.sourceIntegrity !== EXPECTED.sourceIntegrity) {
    fail('manifest source hashes do not match the published artifact');
  }
  const actual = walk(mirrorDir).sort().filter((f) => !GENERATED_FILES.includes(f));
  const expectedFiles = Object.keys(manifest.files).sort();
  const missing = expectedFiles.filter((f) => !actual.includes(f));
  const stray = actual.filter((f) => !expectedFiles.includes(f));
  if (missing.length) fail(`missing deployment material: ${missing.join(', ')}`);
  if (stray.length) fail(`unexpected files in mirror: ${stray.join(', ')}`);
  const drift = expectedFiles.filter((f) => fileSha256(join(mirrorDir, f)) !== manifest.files[f]);
  if (drift.length) fail(`drift/tamper detected: ${drift.join(', ')}`);
  const pkg = JSON.parse(readFileSync(join(mirrorDir, 'package.json'), 'utf8'));
  if (pkg.name !== EXPECTED.name || pkg.version !== EXPECTED.version || pkg.license !== 'UNLICENSED') {
    fail('mirror package.json identity/license mismatch');
  }
  console.log(`mirror verified: ${expectedFiles.length} files match the immutable ${EXPECTED.name}@${EXPECTED.version}`);
}

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const mirrorDir = opt('mirror') ?? DEFAULT_MIRROR;
if (args.includes('--regenerate')) {
  const tarball = opt('tarball');
  if (!tarball) fail(`--regenerate requires --tarball <path to the published ${EXPECTED.version} tgz>`);
  regenerate(tarball, mirrorDir);
  verify(mirrorDir);
} else if (args.includes('--verify')) {
  verify(mirrorDir);
} else {
  fail('usage: --verify [--mirror <dir>] | --regenerate --tarball <path>');
}
