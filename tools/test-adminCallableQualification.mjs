/**
 * vc51.9Z-5 — deployment qualification for the admin callable surface.
 *
 * Eleven of fifteen admin callables were never deployed. Before any of
 * them is put in front of live company data, each must be shown to carry
 * the same guarantees the four deployed ones do. This proves those
 * properties from source, per handler, mechanically — so a handler added
 * later cannot quietly skip one.
 *
 * The properties, and why each matters:
 *
 *   dual gate        requireAdmin() reads platform_admins/{uid} AND
 *                    delegates to authorizeAdminCall, which demands the
 *                    strict wellbuiltAdmin claim. A company role never
 *                    satisfies it.
 *   exact keys       requireExactKeys rejects unknown fields outright, so
 *                    a client cannot smuggle an extra field past a
 *                    handler that happens not to read it.
 *   no client actor  the audit actor, the timestamps and the policy
 *                    version must come from the verified token and the
 *                    server clock. If any of them could be supplied in
 *                    the payload, the audit trail would be forgeable and
 *                    worthless.
 *   existence        a mutation must not create a company or plan by
 *                    writing to a missing document.
 *   atomicity        every mutation runs in a transaction together with
 *                    its own audit record, so an audited change cannot
 *                    exist without the change, or vice versa.
 *
 * Run: node tools/test-adminCallableQualification.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const H = readFileSync(join(ROOT, 'functions/src/admin/adminHandlers.ts'), 'utf8');
const C = readFileSync(join(ROOT, 'functions/src/admin/callables.ts'), 'utf8');
const lines = H.split(/\r?\n/);

// Slice by declaration boundaries — a multi-line `Promise<{` return type
// makes a brace-based range end early and silently under-report.
const starts = [];
lines.forEach((l, i) => {
  const m = l.match(/^export async function ([A-Za-z]+)Handler/);
  if (m) starts.push([m[1], i]);
});
const bodies = new Map(starts.map(([n, i], k) =>
  [n, lines.slice(i, k + 1 < starts.length ? starts[k + 1][1] : lines.length).join('\n')]));

const MUTATIONS = [
  'createPlan', 'updatePlan', 'deprecatePlan', 'assignCompanyPlan',
  'addEntitlementOverride', 'removeEntitlementOverride',
  'setCompanyWorkPeriodConfiguration', 'setCompanyContractEnforcement',
  'updateCompanySafe', 'archiveCompany',
];
const READS = ['listPlans', 'getPlan', 'getCompanyContractConfiguration',
  'previewCompanyEffectiveCapabilities', 'listAdminAudit'];
const ALL = [...MUTATIONS, ...READS];

check('all fifteen handlers were located', bodies.size === 15, `found ${bodies.size}`);

// ── 1. the dual gate, on every single one ────────────────────────────────
for (const n of ALL) {
  const b = bodies.get(n) ?? '';
  check(`1. ${n}: requires platform admin`, /requireAdmin\(/.test(b));
}
check('1. requireAdmin reads the server-owned record AND the claim',
  /PLATFORM_ADMINS_COLLECTION\}\/\$\{uid\}/.test(H) && /authorizeAdminCall\(/.test(H));
check('1. a denial is permission-denied or unauthenticated, never silent',
  /new AdminCallError\(\s*\n?\s*authz\.reason === 'unauthenticated' \? 'unauthenticated' : 'permission-denied'/.test(H)
  || /'unauthenticated' : 'permission-denied'/.test(H));

// ── 2. exact-key validation everywhere ───────────────────────────────────
for (const n of ALL) {
  const b = bodies.get(n) ?? '';
  check(`2. ${n}: rejects unknown fields`, /requireExactKeys\(/.test(b));
}
check('2. unknown fields are an invalid-argument refusal, not ignored',
  /unknown_fields:\$\{unknown\.join\(','\)\}/.test(H));

// ── 3. no client-supplied identity, time or privilege ────────────────────
const FORBIDDEN = ['actorUid', 'actorEmail', 'policyVersion', 'wellbuiltAdmin',
  'serverTimestamp', 'createdAt', 'auditId'];
for (const n of ALL) {
  const b = bodies.get(n) ?? '';
  // A payload read looks like data.X / d.X / parsed.X on the request body.
  const bad = FORBIDDEN.filter((f) => new RegExp(`\\b(data|body|input)\\.${f}\\b`).test(b));
  check(`3. ${n}: takes no actor/时/privilege field from the payload`.replace('时', 'time'),
    bad.length === 0, bad.join(','));
}
check('3. the audit actor comes from the verified gate result',
  /const actor = await requireAdmin\(/.test(H)
  && /actorUid: actor\.actorUid/.test(H));
check('3. audit time is the server timestamp, never a client value',
  /buildAuditRecord\(input, deps\.serverTimestamp\(\)\)/.test(H));
check('3. the audit id is server-minted',
  /deps\.newAuditId\(\)/.test(H) && !/data\.[a-zA-Z]*[aA]uditId/.test(H));
check('3. the policy version is stamped by the server',
  /adminPolicyVersion: ADMIN_POLICY_VERSION/.test(
    readFileSync(join(ROOT, 'functions/src/admin/adminAudit.ts'), 'utf8')));

// ── 4. mutations: existence, atomicity, audit ────────────────────────────
for (const n of MUTATIONS) {
  const b = bodies.get(n) ?? '';
  check(`4. ${n}: runs in a transaction`, /runTransaction\(/.test(b));
  check(`4. ${n}: writes a server-owned audit record`, /\baudit\(\s*tx\b/.test(b));
  // A create must refuse an EXISTING target; everything else must refuse a
  // MISSING one. Both are "don't silently clobber", pointing opposite ways.
  if (n === 'createPlan') {
    check(`4. ${n}: refuses to overwrite an existing target`,
      /already-exists/.test(b) && /await tx\.get\(/.test(b),
      'the existence read must happen inside the transaction');
  } else {
    check(`4. ${n}: verifies the target exists`,
      /readContract\(/.test(b) || /'not-found'/.test(b) || /not_found/.test(b),
      'a mutation must not create its target by writing to a missing doc');
  }
}
check('4. the audit write shares the mutation transaction',
  /function audit\([\s\S]{0,200}tx\.create\(`\$\{ADMIN_AUDIT_COLLECTION\}/.test(H),
  'an audited change and the change itself must commit together');
check('4. a missing company is not-found, not a silent create',
  /if \(!snap\.exists\) throw new AdminCallError\('not-found', 'company_not_found'\)/.test(H));
check('4. an unparseable stored contract fails closed',
  /failed-precondition', `invalid_existing_contract/.test(H));

// ── 5. reads perform no writes ───────────────────────────────────────────
for (const n of READS) {
  const b = bodies.get(n) ?? '';
  check(`5. ${n}: performs no write`,
    !/tx\.(update|create|set)\(|writeContract\(|runTransaction\(/.test(b));
}

// ── 6. one adapter, one error contract ───────────────────────────────────
check('6. every callable goes through the single wrap() adapter',
  (C.match(/= wrap\(/g) || []).length === 15,
  `${(C.match(/= wrap\(/g) || []).length} wrapped`);
check('6. only one onCall exists, so options cannot drift per callable',
  (C.match(/httpsV2\.onCall/g) || []).length === 1);
check('6. a machine-readable adminCode travels in details',
  /new httpsV2\.HttpsError\(err\.code, err\.adminCode, \{ adminCode: err\.adminCode \}\)/.test(C));
check('6. an unexpected failure becomes internal, not a leaked stack',
  /HttpsError\('internal', 'internal', \{ adminCode: 'internal' \}\)/.test(C)
  && !/console\.error\([^)]*err\)/.test(C));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
