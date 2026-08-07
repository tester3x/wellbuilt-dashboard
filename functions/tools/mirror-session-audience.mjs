#!/usr/bin/env node
/**
 * vc51.9J — generator/verifier for the session audience contract source mirror.
 *
 *   node tools/mirror-session-audience.mjs --regenerate [--canonical <path>]
 *   node tools/mirror-session-audience.mjs --verify
 *
 * WHY THIS EXISTS, AND WHY IT IS TEMPORARY
 * The Functions contracts mirror (contracts-mirror/) is SHA-pinned to the
 * immutable PUBLISHED @tester3x/wellbuilt-contracts@0.2.0 artifact. The
 * session audience contract lives in canonical contracts 0.3.0-dev.0, which is
 * deliberately unpublished, so the package mirror cannot carry it.
 *
 * Rather than hand-copy constants — which is exactly the JSA receipt
 * v1/v2 drift this ecosystem already paid for once — this copies the
 * canonical source file VERBATIM and verifies it byte-for-byte. No
 * validator logic is re-implemented, so no logic can diverge.
 *
 * The canonical file is self-contained: zero imports, zero platform APIs.
 * That is asserted here, because it is what makes a verbatim copy safe.
 *
 * DELETE THIS when contracts publishes a version containing the SSO
 * protocol: replace the generated module with a package import and drop
 * both this tool and its test.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CANONICAL = join(FN_DIR, '..', '..', 'wellbuilt-contracts', 'src', 'auth', 'sessionAudience.ts');
const GENERATED = join(FN_DIR, 'src', 'security', 'sessionAudience.generated.ts');
const MANIFEST = join(FN_DIR, 'src', 'security', 'AUDIENCE-MIRROR-MANIFEST.json');

export const EXPECTED_CANONICAL_VERSION = '0.3.0-dev.0';

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Verbatim copy of the canonical session audience contract from
 * @tester3x/wellbuilt-contracts src/auth/sessionAudience.ts at version
 * ${EXPECTED_CANONICAL_VERSION} (UNPUBLISHED).
 *
 * Regenerate:  node tools/mirror-session-audience.mjs --regenerate
 * Verify:      node tools/mirror-session-audience.mjs --verify
 *
 * This exists only because the contracts package mirror is SHA-pinned to
 * the published 0.2.0 artifact and cannot carry an unpublished bump.
 * When the session audience contract is published, delete this file and import from
 * the package instead.
 */
// @generated from wellbuilt-contracts/src/auth/sessionAudience.ts
`;

function readCanonical(path) {
  if (!existsSync(path)) {
    throw new Error(`canonical session audience contract not found at ${path}`);
  }
  const src = readFileSync(path, 'utf8');
  // A verbatim copy is only safe if the source pulls in nothing.
  const importLine = src.split('\n').find((l) => /^\s*import\s/.test(l));
  if (importLine) {
    throw new Error(`canonical protocol must have no imports; found: ${importLine.trim()}`);
  }
  if (/require\(|process\.|globalThis|Math\.random|Date\.now/.test(src)) {
    throw new Error('canonical protocol must be pure: no platform, clock, or randomness');
  }
  return src;
}

function bodyOf(generated) {
  const marker = '// @generated from wellbuilt-contracts/src/auth/sessionAudience.ts\n';
  const at = generated.indexOf(marker);
  if (at < 0) throw new Error('generated file is missing its provenance marker');
  return generated.slice(at + marker.length);
}

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

const mode = process.argv.includes('--regenerate')
  ? 'regenerate'
  : process.argv.includes('--verify')
    ? 'verify'
    : null;
const canonicalIdx = process.argv.indexOf('--canonical');
const canonicalPath = canonicalIdx > -1 ? process.argv[canonicalIdx + 1] : DEFAULT_CANONICAL;

if (!mode) {
  console.error('usage: mirror-session-audience.mjs --regenerate | --verify');
  process.exit(2);
}

if (mode === 'regenerate') {
  const canonical = readCanonical(canonicalPath);
  mkdirSync(dirname(GENERATED), { recursive: true });
  writeFileSync(GENERATED, HEADER + canonical, 'utf8');
  writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        canonicalVersion: EXPECTED_CANONICAL_VERSION,
        canonicalPath: 'wellbuilt-contracts/src/auth/sessionAudience.ts',
        bodySha256: sha256(canonical),
        published: false,
        note: 'Unpublished. Replace with a package import once contracts publishes the session audience contract.',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log(`regenerated ${GENERATED}`);
  console.log(`body sha256 ${sha256(canonical)}`);
} else {
  let failed = 0;
  const fail = (m) => {
    failed++;
    console.log(`FAIL ${m}`);
  };
  const ok = (m) => console.log(`PASS ${m}`);

  if (!existsSync(GENERATED)) fail('generated mirror exists');
  else {
    const generated = readFileSync(GENERATED, 'utf8');
    const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null;
    if (!manifest) fail('manifest exists');
    else {
      const body = bodyOf(generated);
      const bodyHash = sha256(body);
      if (bodyHash !== manifest.bodySha256) fail(`mirror matches its manifest hash (${bodyHash})`);
      else ok('mirror matches its manifest hash');

      if (manifest.canonicalVersion !== EXPECTED_CANONICAL_VERSION) {
        fail('manifest records the expected canonical version');
      } else ok('manifest records the expected canonical version');

      if (manifest.published !== false) fail('manifest records the source as unpublished');
      else ok('manifest records the source as unpublished');

      if (existsSync(canonicalPath)) {
        const canonical = readCanonical(canonicalPath);
        if (canonical !== body) fail('mirror is byte-identical to the canonical source');
        else ok('mirror is byte-identical to the canonical source');
      } else {
        ok('canonical source unavailable here — hash check stands alone');
      }

      if (!/DO NOT EDIT/.test(generated)) fail('mirror carries a do-not-edit header');
      else ok('mirror carries a do-not-edit header');
    }
  }
  console.log(failed ? `\n${failed} failed` : '\nsession audience contract mirror verified');
  if (failed) process.exitCode = 1;
}
