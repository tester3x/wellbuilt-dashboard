/**
 * vc51.9A6-A protected contract/admin rules matrix — runs INSIDE the
 * Firestore emulator via:
 *
 *   npx firebase emulators:exec --only firestore --project wellbuilt-sync \
 *     "node firestore-rules-tests/test-protectedCompanies.mjs"
 *
 * (Windows loopback note: same JAVA_TOOL_OPTIONS workaround as
 * test-jsaReadReceipts.mjs if the emulator dies on startup.)
 *
 * Plain REST, no SDK deps. Because emulators:exec loads rules through
 * firebase.json, every behavioral assertion here also proves the WIRED
 * rules file is the tested file.
 *
 * IDENTITIES (the emulator decodes unsigned alg:none JWTs; Admin SDK
 * fixture writes use the magic `Bearer owner` which bypasses rules):
 *   UNAUTH — no Authorization header (what all installed suite apps are)
 *   USER   — ordinary authenticated Dashboard-style user, no claims
 *   FAKE   — authenticated user whose PROFILE data claims admin
 *            (viewAdmin/role claims + an enabled platform_admins record
 *            exists for the uid) but NO wellbuiltAdmin custom claim
 *   CLAIM  — authenticated user CARRYING wellbuiltAdmin:true. Still a
 *            direct client: rules must deny protected/admin access —
 *            only Admin SDK callables act on these, and Admin SDK
 *            bypasses rules entirely.
 */

import { PROTECTED_COMPANY_KEYS } from './protected-company-keys.mjs';

const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PID = 'wellbuilt-sync';
const BASE = `http://${host}/v1/projects/${PID}/databases/(default)/documents`;

// ── unsigned JWT (what @firebase/rules-unit-testing builds) ───────────────
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(uid, claims = {}) {
  const header = { alg: 'none', typ: 'JWT' };
  const iat = 1754400000; // fixed epoch seconds — emulator doesn't verify
  const payload = {
    iss: `https://securetoken.google.com/${PID}`,
    aud: PID,
    iat,
    exp: iat + 3600,
    auth_time: iat,
    sub: uid,
    user_id: uid,
    firebase: { sign_in_provider: 'password', identities: {} },
    ...claims,
  };
  return `${b64url(header)}.${b64url(payload)}.`;
}
const UNAUTH = null;
const OWNER = 'Bearer owner';
const USER = `Bearer ${token('ordinary-user-1')}`;
const FAKE = `Bearer ${token('fake-admin-1', { viewAdmin: true, role: 'admin' })}`;
const CLAIM = `Bearer ${token('claim-admin-1', { wellbuiltAdmin: true })}`;

// ── REST helpers ──────────────────────────────────────────────────────────
const hdrs = (auth) => ({
  'Content-Type': 'application/json',
  ...(auth ? { Authorization: auth } : {}),
});
const s = (v) => ({ stringValue: v });
const i = (v) => ({ integerValue: String(v) });
const b = (v) => ({ booleanValue: v });
const nul = () => ({ nullValue: null });
const m = (fields) => ({ mapValue: { fields } });

/** PATCH a document. mask: array of fieldPaths → field-merge (updateDoc
 *  semantics; a masked path absent from fields is a DELETE of that
 *  field). mask: null → maskless PATCH = whole-document replacement on
 *  an existing doc, create on a missing one. */
async function patchDoc(auth, path, fields, mask = null) {
  const qs = mask ? '?' + mask.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&') : '';
  const r = await fetch(`${BASE}/${path}${qs}`, {
    method: 'PATCH', headers: hdrs(auth), body: JSON.stringify({ fields }),
  });
  return r.status;
}
const getDoc = async (auth, path) => (await fetch(`${BASE}/${path}`, { headers: hdrs(auth) })).status;
const listCol = async (auth, col) => (await fetch(`${BASE}/${col}`, { headers: hdrs(auth) })).status;
const delDoc = async (auth, path) => (await fetch(`${BASE}/${path}`, { method: 'DELETE', headers: hdrs(auth) })).status;
async function runQuery(auth, collectionId) {
  const r = await fetch(`${BASE.replace(/\/documents$/, '/documents')}:runQuery`, {
    method: 'POST', headers: hdrs(auth),
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }] } }),
  });
  return r.status;
}

// ── result accounting ─────────────────────────────────────────────────────
let pass = 0, fail = 0, allowedTotal = 0, deniedTotal = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (ok) pass++; else fail++;
  if (expected === 200) allowedTotal++; else if (expected === 403) deniedTotal++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (got ${actual}, want ${expected})`);
};

// ── fixtures (Admin/owner — bypasses rules; proves the Admin SDK path) ────
const legacyFields = {
  name: s('Legacy Water Co'), invoicePrefix: s('LW'), liveDispatchSync: b(true),
  payConfig: m({ basis: s('percent'), payrollTemplate: m({ columns: s('v1') }) }),
  rateSheets: m({ default: m({ hourly: i(120) }) }),
};
// vc51.9A6-B canonical nested schema — the ONE active shape.
const wellbuiltContract = () => m({
  contractVersion: i(1),
  configurationVersion: i(1),
  planId: s('plan-field'),
  entitlementOverrides: { arrayValue: { values: [] } },
  workPeriodConfiguration: m({ mode: s('explicit_shift') }),
  contractEnforced: b(false),
});
const configuredFields = {
  name: s('Configured Co'),
  wellbuiltContract: wellbuiltContract(),
};
check('ADMIN fixture: legacy-co created (owner bypasses rules)',
  await patchDoc(OWNER, 'companies/legacy-co', legacyFields), 200);
check('ADMIN fixture: legacy-two created',
  await patchDoc(OWNER, 'companies/legacy-two', { name: s('Legacy Two'), notes: s('n') }), 200);
check('ADMIN fixture: deletable-co created',
  await patchDoc(OWNER, 'companies/deletable-co', { name: s('Deletable') }), 200);
check('ADMIN fixture: configured-co created WITH protected fields',
  await patchDoc(OWNER, 'companies/configured-co', configuredFields), 200);
check('ADMIN fixture: replace-co created WITH protected fields',
  await patchDoc(OWNER, 'companies/replace-co', { ...configuredFields, name: s('Replace Co') }), 200);
check('ADMIN fixture: flat-reserved-co created (reserved Part A key present)',
  await patchDoc(OWNER, 'companies/flat-reserved-co', { name: s('Flat Reserved'), planId: s('plan-field') }), 200);
check('ADMIN fixture: platform_admins/fake-admin-1 (enabled) created',
  await patchDoc(OWNER, 'platform_admins/fake-admin-1', { enabled: b(true), policyVersion: i(1) }), 200);
check('ADMIN fixture: plans/plan-field created',
  await patchDoc(OWNER, 'plans/plan-field', { planId: s('plan-field'), displayName: s('Field'), status: s('active') }), 200);
check('ADMIN fixture: platform_admin_audit/audit-1 created',
  await patchDoc(OWNER, 'platform_admin_audit/audit-1', { action: s('plan.create'), actorUid: s('x') }), 200);

// ══ REQUIRED DENIALS ══════════════════════════════════════════════════════

// platform_admins — every op, every identity (incl. FAKE's OWN record).
check('platform_admins get UNAUTH denied', await getDoc(UNAUTH, 'platform_admins/fake-admin-1'), 403);
check('platform_admins get USER denied', await getDoc(USER, 'platform_admins/fake-admin-1'), 403);
check('platform_admins get FAKE (own enabled record) denied', await getDoc(FAKE, 'platform_admins/fake-admin-1'), 403);
check('platform_admins get CLAIM denied', await getDoc(CLAIM, 'platform_admins/fake-admin-1'), 403);
check('platform_admins list UNAUTH denied', await listCol(UNAUTH, 'platform_admins'), 403);
check('platform_admins list CLAIM denied', await listCol(CLAIM, 'platform_admins'), 403);
check('platform_admins create CLAIM denied',
  await patchDoc(CLAIM, 'platform_admins/claim-admin-1', { enabled: b(true), policyVersion: i(1) }), 403);
check('platform_admins create UNAUTH denied',
  await patchDoc(UNAUTH, 'platform_admins/intruder-1', { enabled: b(true) }), 403);
check('platform_admins update CLAIM denied',
  await patchDoc(CLAIM, 'platform_admins/fake-admin-1', { enabled: b(false) }, ['enabled']), 403);
check('platform_admins update USER denied',
  await patchDoc(USER, 'platform_admins/fake-admin-1', { enabled: b(false) }, ['enabled']), 403);
check('platform_admins delete CLAIM denied', await delDoc(CLAIM, 'platform_admins/fake-admin-1'), 403);

// plans — create/update/delete/list denied; direct get also denied
// pending Part B callables (no installed app reads plans).
check('plans create CLAIM denied',
  await patchDoc(CLAIM, 'plans/plan-new', { planId: s('plan-new'), status: s('active') }), 403);
check('plans update CLAIM denied',
  await patchDoc(CLAIM, 'plans/plan-field', { status: s('deprecated') }, ['status']), 403);
check('plans update USER denied',
  await patchDoc(USER, 'plans/plan-field', { status: s('deprecated') }, ['status']), 403);
check('plans delete CLAIM denied', await delDoc(CLAIM, 'plans/plan-field'), 403);
check('plans list UNAUTH denied', await listCol(UNAUTH, 'plans'), 403);
check('plans list CLAIM denied', await listCol(CLAIM, 'plans'), 403);
check('plans unfiltered query denied', await runQuery(CLAIM, 'plans'), 403);
{
  // Every query SHAPE is a list operation — filtered and limited forms
  // must be denied exactly like the plain list (vc51.9A6-B pin).
  const q = async (body) => (await fetch(`${BASE.replace(/\/documents$/, '/documents')}:runQuery`, {
    method: 'POST', headers: hdrs(UNAUTH), body: JSON.stringify(body),
  })).status;
  check('plans query filtered by status denied', await q({
    structuredQuery: {
      from: [{ collectionId: 'plans' }],
      where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'active' } } },
    },
  }), 403);
  check('plans limit-1 query denied', await q({
    structuredQuery: { from: [{ collectionId: 'plans' }], limit: 1 },
  }), 403);
}
// vc51.9A6-B mobile read path: EXACT plan get is open (plan docs carry
// product capability configuration, not secrets).
check('plans exact get UNAUTH allowed (mobile read path)',
  await getDoc(UNAUTH, 'plans/plan-field'), 200);
check('plans exact get CLAIM allowed', await getDoc(CLAIM, 'plans/plan-field'), 200);
check('plans unknown id → ordinary 404 (no discovery signal)',
  await getDoc(UNAUTH, 'plans/plan-nonexistent'), 404);

// admin audit — direct read/write denied for every identity.
check('audit get CLAIM denied', await getDoc(CLAIM, 'platform_admin_audit/audit-1'), 403);
check('audit list CLAIM denied', await listCol(CLAIM, 'platform_admin_audit'), 403);
check('audit create CLAIM denied',
  await patchDoc(CLAIM, 'platform_admin_audit/audit-2', { action: s('x') }), 403);
check('audit create UNAUTH denied',
  await patchDoc(UNAUTH, 'platform_admin_audit/audit-3', { action: s('x') }), 403);
check('audit update CLAIM denied',
  await patchDoc(CLAIM, 'platform_admin_audit/audit-1', { action: s('tampered') }, ['action']), 403);
check('audit delete CLAIM denied', await delDoc(CLAIM, 'platform_admin_audit/audit-1'), 403);

// companies — auth gate (UNAUTH writes die regardless of fields).
check('company create UNAUTH (clean fields) denied',
  await patchDoc(UNAUTH, 'companies/unauth-co', { name: s('Nope') }), 403);
check('company update UNAUTH (unrelated field) denied',
  await patchDoc(UNAUTH, 'companies/legacy-co', { name: s('Renamed') }, ['name']), 403);
check('company delete UNAUTH denied', await delDoc(UNAUTH, 'companies/deletable-co'), 403);

// companies — the CANONICAL nested object (vc51.9A6-B).
check('create containing wellbuiltContract denied (USER)',
  await patchDoc(USER, 'companies/new-co-w', { name: s('W'), wellbuiltContract: wellbuiltContract() }), 403);
check('add wellbuiltContract to legacy doc denied (USER)',
  await patchDoc(USER, 'companies/legacy-co', { wellbuiltContract: wellbuiltContract() }, ['wellbuiltContract']), 403);
check('modify wellbuiltContract denied (USER)',
  await patchDoc(USER, 'companies/configured-co',
    { wellbuiltContract: m({ contractEnforced: b(true) }) }, ['wellbuiltContract']), 403);
check('remove wellbuiltContract denied (USER — masked path absent from body)',
  await patchDoc(USER, 'companies/configured-co', {}, ['wellbuiltContract']), 403);
check('set wellbuiltContract null denied (USER)',
  await patchDoc(USER, 'companies/configured-co', { wellbuiltContract: nul() }, ['wellbuiltContract']), 403);
check('add wellbuiltContract denied even for CLAIM bearer',
  await patchDoc(CLAIM, 'companies/legacy-co', { wellbuiltContract: wellbuiltContract() }, ['wellbuiltContract']), 403);

// companies — reserved Part A flat keys stay permanently denied.
check('company create containing planId denied (USER)',
  await patchDoc(USER, 'companies/new-co-a', { name: s('A'), planId: s('plan-field') }), 403);
check('company create containing entitlement map denied (USER)',
  await patchDoc(USER, 'companies/new-co-b', { name: s('B'), entitlement: m({ planId: s('x') }) }), 403);
check('company create with protected key = null denied (USER)',
  await patchDoc(USER, 'companies/new-co-c', { name: s('C'), planId: nul() }), 403);
check('company create with protected key wrong-typed denied (USER)',
  await patchDoc(USER, 'companies/new-co-d', { name: s('D'), workPeriodConfiguration: s('bogus-string') }), 403);
check('company create containing planId denied (CLAIM — claim grants nothing directly)',
  await patchDoc(CLAIM, 'companies/new-co-e', { name: s('E'), planId: s('plan-field') }), 403);

// companies — protected-field updates (add / modify / remove / null / mixed).
check('add protected field to legacy doc denied (USER)',
  await patchDoc(USER, 'companies/legacy-co', { planId: s('plan-field') }, ['planId']), 403);
check('add protected field to legacy doc denied (CLAIM)',
  await patchDoc(CLAIM, 'companies/legacy-co', { contractEnforced: b(true) }, ['contractEnforced']), 403);
check('modify protected field denied (USER)',
  await patchDoc(USER, 'companies/configured-co', { planId: s('plan-god') }, ['planId']), 403);
check('modify nested protected map denied (USER)',
  await patchDoc(USER, 'companies/configured-co',
    { workPeriodConfiguration: m({ mode: s('company_defined_period') }) }, ['workPeriodConfiguration']), 403);
check('remove reserved flat key denied (USER — masked path absent from body)',
  await patchDoc(USER, 'companies/flat-reserved-co', {}, ['planId']), 403);
check('set protected field null denied (USER)',
  await patchDoc(USER, 'companies/configured-co', { planId: nul() }, ['planId']), 403);
check('mixed permitted+protected update denied entirely (USER)',
  await patchDoc(USER, 'companies/configured-co',
    { name: s('Sneaky Rename'), planId: s('plan-god') }, ['name', 'planId']), 403);
check('whole-document replacement erasing protected fields denied (USER, maskless PATCH)',
  await patchDoc(USER, 'companies/replace-co', { name: s('Wiped Co') }), 403);
check('whole-document replacement erasing protected fields denied (CLAIM)',
  await patchDoc(CLAIM, 'companies/replace-co', { name: s('Wiped Co') }), 403);

// companies — delete of a configured/protected company.
check('delete configured company denied (USER)', await delDoc(USER, 'companies/configured-co'), 403);
check('delete configured company denied (CLAIM)', await delDoc(CLAIM, 'companies/configured-co'), 403);

// alternate/catch-all-path bypass attempts.
check('catch-all: write to arbitrary collection denied (USER)',
  await patchDoc(USER, 'company_settings_backdoor/x', { planId: s('plan-field') }), 403);
check('catch-all: write to unknown company subcollection denied (USER)',
  await patchDoc(USER, 'companies/legacy-co/contract_backdoor/x', { planId: s('plan-field') }), 403);
check('catch-all: write to unknown company subcollection denied (UNAUTH)',
  await patchDoc(UNAUTH, 'companies/legacy-co/contract_backdoor/y', { planId: s('plan-field') }), 403);

// ══ REQUIRED COMPATIBILITY ════════════════════════════════════════════════

// Reads under the current intended exposure (installed unauth apps).
check('company exact get UNAUTH allowed (WB-T/JSA/Suite/WB-M config reads)',
  await getDoc(UNAUTH, 'companies/legacy-co'), 200);
check('company collection list UNAUTH allowed (WB-T getAllCompanies)',
  await listCol(UNAUTH, 'companies'), 200);
check('company query UNAUTH allowed', await runQuery(UNAUTH, 'companies'), 200);
check('configured company get UNAUTH allowed (protected fields readable — honest exposure)',
  await getDoc(UNAUTH, 'companies/configured-co'), 200);

// Established unrelated updates (the census'd Dashboard writer shapes).
check('update single unrelated field allowed (USER — updateCompanyFields shape)',
  await patchDoc(USER, 'companies/legacy-co', { name: s('Legacy Water Co LLC') }, ['name']), 200);
check('update multiple unrelated fields allowed (USER)',
  await patchDoc(USER, 'companies/legacy-co',
    { address: s('1 Main'), city: s('Williston'), phone: s('701-555-0100') },
    ['address', 'city', 'phone']), 200);
check('dotted-path unrelated update allowed (USER — payConfig.payrollTemplate)',
  await patchDoc(USER, 'companies/legacy-co',
    { payConfig: m({ payrollTemplate: m({ columns: s('v2') }) }) }, ['payConfig.payrollTemplate']), 200);
check('deleteField() of unrelated key allowed (USER — liveDispatchSync)',
  await patchDoc(USER, 'companies/legacy-co', {}, ['liveDispatchSync']), 200);
check('unrelated update on a CONFIGURED company allowed (USER — legacy writers stay compatible)',
  await patchDoc(USER, 'companies/configured-co', { name: s('Configured Co LLC') }, ['name']), 200);
check('unrelated update allowed for FAKE profile-admin (authenticated like any user)',
  await patchDoc(FAKE, 'companies/legacy-co', { notes: s('fake-admin note') }, ['notes']), 200);
check('unrelated update allowed for CLAIM bearer (deny is key-based, not identity-based)',
  await patchDoc(CLAIM, 'companies/legacy-co', { notes: s('claim note') }, ['notes']), 200);

// Legacy company lifecycle without protected fields.
check('clean company create allowed (USER — CompaniesTab flow)',
  await patchDoc(USER, 'companies/created-co', { name: s('Created Co'), status: s('active') }), 200);
check('whole-document replacement of an UNCONFIGURED company allowed (USER — legacy setDoc-no-merge behavior preserved)',
  await patchDoc(USER, 'companies/legacy-two', { name: s('Legacy Two Rewritten') }), 200);
check('delete unconfigured company allowed (USER — deleteCompany flow)',
  await delDoc(USER, 'companies/deletable-co'), 200);

// Subcollections behave per their existing separate rules (unchanged).
check('swd_directory write UNAUTH still allowed (existing rule)',
  await patchDoc(UNAUTH, 'companies/legacy-co/swd_directory/entry-1', { displayName: s('SWD 1'), isCustom: b(true) }), 200);
check('counters write UNAUTH still allowed (existing rule)',
  await patchDoc(UNAUTH, 'companies/legacy-co/counters/invoice', { counter: i(7) }), 200);
check('equipment_specs write UNAUTH still allowed (existing rule)',
  await patchDoc(UNAUTH, 'companies/legacy-co/equipment_specs/truck_12', { tareWeight: i(32000) }), 200);
check('equipment write still denied (existing rule)',
  await patchDoc(USER, 'companies/legacy-co/equipment/eq-1', { unitNumber: s('12') }), 403);
check('assignments write still denied (existing rule)',
  await patchDoc(USER, 'companies/legacy-co/assignments/as-1', { active: b(true) }), 403);
check('dvir_inspections read still denied (existing rule)',
  await getDoc(USER, 'companies/legacy-co/dvir_inspections/insp-1'), 403);

// Admin SDK remains unconstrained: owner can write protected fields.
check('ADMIN (owner) writes a protected field — succeeds outside client rules',
  await patchDoc(OWNER, 'companies/legacy-two', { planId: s('plan-field') }, ['planId']), 200);
check('after Admin configures it, client replacement is now denied (erase-protection engages)',
  await patchDoc(USER, 'companies/legacy-two', { name: s('Wipe Attempt') }), 403);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`expected-ALLOWED cases: ${allowedTotal}; expected-DENIED cases: ${deniedTotal}`);
console.log(`protected key set (${PROTECTED_COMPANY_KEYS.length}): ${PROTECTED_COMPANY_KEYS.join(', ')}`);
process.exit(fail ? 1 : 0);
