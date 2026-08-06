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
import {
  CANONICAL_PROTECTED_ROOT, PROTECTED_COMPANY_KEYS, RESERVED_COMPANY_KEYS,
} from './protected-company-keys.mjs';

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

// 5b. Canonical vs reserved is structurally distinguished: the single
//     active root leads the list; the Part A flattened proposal remains
//     reserved/denied so no second active schema shape can appear.
check('canonical root is wellbuiltContract and leads the rules list',
  CANONICAL_PROTECTED_ROOT === 'wellbuiltContract' && rulesKeys[0] === CANONICAL_PROTECTED_ROOT);
check('all nine reserved Part A keys remain denied',
  RESERVED_COMPANY_KEYS.length === 9 &&
  RESERVED_COMPANY_KEYS.every((k) => rulesKeys.includes(k)));
check('rules comment marks the reserved keys as reserved/deprecated',
  /reserved\/deprecated/.test(fnMatch ? rules.slice(rules.indexOf('function protectedCompanyKeys'), rules.indexOf('function protectedCompanyKeys') + 800) : ''));

// 5c. The Functions-side lists cannot drift from this module.
const handlersSrc = readFileSync(join(root, 'functions/src/admin/adminHandlers.ts'), 'utf8');
const fnReserved = handlersSrc.match(/RESERVED_COMPANY_KEYS[\s\S]*?Object\.freeze\(\[([\s\S]*?)\]\)/);
const fnReservedKeys = fnReserved ? [...fnReserved[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
check('functions RESERVED_COMPANY_KEYS matches canonical reserved list',
  fnReservedKeys.length === RESERVED_COMPANY_KEYS.length &&
  fnReservedKeys.every((k, i) => k === RESERVED_COMPANY_KEYS[i]),
  `functions=[${fnReservedKeys.join(',')}]`);
const contractSrc = readFileSync(join(root, 'functions/src/admin/companyContract.ts'), 'utf8');
check('functions WELLBUILT_CONTRACT_KEY matches canonical root',
  new RegExp(`WELLBUILT_CONTRACT_KEY = '${CANONICAL_PROTECTED_ROOT}'`).test(contractSrc));

// 6. platform_admins + audit are deny-all; plans allows EXACT GET only
//    (vc51.9A6-B mobile read path) with list and writes denied.
for (const col of ['platform_admins', 'platform_admin_audit']) {
  const block = matchBlock(rules, `match /${col}/`);
  check(`${col} block exists`, !!block);
  const body = block ? stripComments(block) : '';
  check(`${col} denies all client access`,
    /allow\s+read\s*,\s*write\s*:\s*if\s+false/.test(body) && !/if\s+true/.test(body));
}
{
  const block = matchBlock(rules, 'match /plans/');
  check('plans block exists', !!block);
  const body = block ? stripComments(block) : '';
  check('plans allows exact get only',
    /allow\s+get\s*:\s*if\s+true/.test(body) &&
    /allow\s+list\s*:\s*if\s+false/.test(body) &&
    /allow\s+write\s*:\s*if\s+false/.test(body) &&
    !/allow\s+(read|create|update|delete)\s*:/.test(body));
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
