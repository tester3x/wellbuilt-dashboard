/**
 * vc51.9A6-A rules SOURCE pins — pure Node, no emulator:
 *
 *   node firestore-rules-tests/test-rulesSourcePins.mjs
 *
 * The emulator matrix (test-protectedCompanies.mjs) is the BEHAVIORAL
 * proof — a protected write denied under every identity proves no
 * overlapping grant restores it, and because emulators:exec loads rules
 * via firebase.json, it also proves the wired file is the tested file.
 * These pins guard the SOURCE STRUCTURE so a future edit that
 * reintroduces a broad grant, a second companies block, a permissive
 * catch-all, or a drifted protected-key list fails fast even before an
 * emulator run.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTECTED_COMPANY_KEYS } from './protected-company-keys.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const firebaseJson = JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8'));
const rules = readFileSync(join(root, 'firestore.rules'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

/**
 * Extract the full brace-balanced block for a `match` header. The header
 * string MUST end with the block-opening `{` (path variables like {uid}
 * contain braces of their own, so the block brace is identified as the
 * header's final character — never by searching forward).
 */
function blockFromHeader(source, headerStart, header) {
  const open = headerStart + header.length - 1;
  if (source[open] !== '{') throw new Error(`header must end with '{': ${header}`);
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) return source.slice(headerStart, j + 1);
  }
  return null;
}
/** Matches a full match-statement header INCLUDING its block-opening brace. */
const HEADER_RE = /match\s+\/[^\s{]*(?:\{[^}]+\}[^\s{]*)*\s*\{/g;
function matchBlock(source, headerPrefix) {
  HEADER_RE.lastIndex = 0;
  for (let h; (h = HEADER_RE.exec(source)); ) {
    if (h[0].startsWith(headerPrefix)) return blockFromHeader(source, h.index, h[0]);
  }
  return null;
}
/** Strip nested `match` sub-blocks, leaving only the block's own level. */
function ownLevel(block) {
  // interior = between the block-opening brace (end of header) and final }
  HEADER_RE.lastIndex = 0;
  const h = HEADER_RE.exec(block);
  let interior = block.slice(h.index + h[0].length, block.lastIndexOf('}'));
  for (;;) {
    HEADER_RE.lastIndex = 0;
    const nested = HEADER_RE.exec(interior);
    if (!nested) return interior;
    const nestedBlock = blockFromHeader(interior, nested.index, nested[0]);
    if (!nestedBlock) return interior;
    interior = interior.slice(0, nested.index) + interior.slice(nested.index + nestedBlock.length);
  }
}
const stripComments = (t) => t.replace(/\/\/[^\n]*/g, '');

// 1. firebase.json wires exactly the file these pins (and the emulator
//    run) read.
check('firebase.json wires firestore.rules', firebaseJson.firestore?.rules === 'firestore.rules',
  `got ${JSON.stringify(firebaseJson.firestore?.rules)}`);

// 2. Exactly ONE companies match block exists.
const companiesHeaders = rules.match(/match\s+\/companies\/\{[^}]+\}\s*\{/g) || [];
check('exactly one match /companies/{...} block', companiesHeaders.length === 1,
  `found ${companiesHeaders.length}`);

// 3. The companies ROOT level carries no broad write grant.
const companiesBlock = matchBlock(rules, companiesHeaders[0] ?? 'match /companies/');
const companiesRoot = companiesBlock ? stripComments(ownLevel(companiesBlock)) : '';
check('companies root block found', !!companiesBlock);
check('no `allow read, write: if true` at companies root',
  !/allow\s+read\s*,\s*write\s*:\s*if\s+true/.test(companiesRoot));
check('no `allow write: if true` (any spelling) at companies root',
  !/allow\s+[^;]*write[^;]*:\s*if\s+true/.test(companiesRoot));
check('no unconditional create/update/delete at companies root',
  !/allow\s+[^;]*(create|update|delete)[^;]*:\s*if\s+true/.test(companiesRoot));

// 4. The protected-key update guard exists at companies root.
check('update guard uses MapDiff affectedKeys against protectedCompanyKeys()',
  /diff\(resource\.data\)\s*\.?\s*affectedKeys\(\)\.hasAny\(protectedCompanyKeys\(\)\)/.test(
    companiesRoot.replace(/\s+/g, ' ')));
check('create guard denies protected keys',
  /allow\s+create:[^;]*request\.resource\.data\.keys\(\)\.hasAny\(protectedCompanyKeys\(\)\)/.test(
    companiesRoot.replace(/\s+/g, ' ')));
check('delete guard denies protected/configured docs',
  /allow\s+delete:[^;]*resource\.data\.keys\(\)\.hasAny\(protectedCompanyKeys\(\)\)/.test(
    companiesRoot.replace(/\s+/g, ' ')));

// 5. The rules' protected-key list is EXACTLY the canonical list —
//    same names, same count, no drift in either direction.
const fnMatch = stripComments(rules).match(
  /function\s+protectedCompanyKeys\(\)\s*\{\s*return\s*\[([\s\S]*?)\];/);
check('protectedCompanyKeys() function exists', !!fnMatch);
const rulesKeys = fnMatch
  ? [...fnMatch[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  : [];
check('rules protected-key list matches canonical module exactly',
  rulesKeys.length === PROTECTED_COMPANY_KEYS.length &&
  rulesKeys.every((k, idx) => k === PROTECTED_COMPANY_KEYS[idx]),
  `rules=[${rulesKeys.join(',')}] canonical=[${PROTECTED_COMPANY_KEYS.join(',')}]`);

// 6. Admin-side collections are deny-all, with no allow-true anywhere in
//    their blocks (list denial follows from read:false).
for (const col of ['platform_admins', 'plans', 'platform_admin_audit']) {
  const block = matchBlock(rules, `match /${col}/`);
  check(`${col} block exists`, !!block);
  const body = block ? stripComments(block) : '';
  check(`${col} denies all client access`,
    /allow\s+read\s*,\s*write\s*:\s*if\s+false/.test(body) && !/if\s+true/.test(body));
}

// 7. Exactly one catch-all, and it is deny-only — no overlapping
//    catch-all can restore protected writes.
const catchAlls = rules.match(/match\s+\/\{document=\*\*\}\s*\{/g) || [];
check('exactly one /{document=**} catch-all', catchAlls.length === 1, `found ${catchAlls.length}`);
const catchAllBody = stripComments(matchBlock(rules, catchAlls[0] ?? '') || '');
check('catch-all is deny-only',
  /allow\s+read\s*,\s*write\s*:\s*if\s+false/.test(catchAllBody) && !/if\s+true/.test(catchAllBody));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
