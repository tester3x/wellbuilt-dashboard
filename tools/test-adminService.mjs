/**
 * vc51.9A6-B — typed Dashboard admin service matrix.
 *
 * Drives adminContractServiceCore with injected CallFn transports and
 * pins: method→callable-name wiring, payload passthrough, response
 * typing, the full normalized-error taxonomy (distinct unauthenticated /
 * missing_claim / disabled_admin / validation / incompatible_contract /
 * retryable), and the callable-only source property (no
 * firebase/firestore import, no direct write fallback).
 *
 * Run: node --experimental-strip-types tools/test-adminService.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_CALLABLE_NAMES,
  AdminServiceError,
  createAdminContractServiceCore,
  normalizeAdminError,
} from '../src/lib/adminContractServiceCore.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

// ── wiring: every method calls its exact callable with the exact payload ──
{
  const calls = [];
  const svc = createAdminContractServiceCore(async (name, data) => {
    calls.push([name, data]);
    return { echoed: true };
  });
  await svc.createPlan({ planId: 'p', displayName: 'P', capabilities: ['jsa'] });
  await svc.updatePlan({ planId: 'p', displayName: 'Q' });
  await svc.deprecatePlan({ planId: 'p' });
  await svc.assignCompanyPlan({ companyId: 'c', planId: 'p' });
  await svc.addEntitlementOverride({ companyId: 'c', capability: 'dvir', granted: true, reason: 'r' });
  await svc.removeEntitlementOverride({ companyId: 'c', capability: 'dvir', reason: 'r' });
  await svc.setCompanyWorkPeriodConfiguration({ companyId: 'c', configuration: { mode: 'explicit_shift' } });
  await svc.setCompanyAppConfiguration({ companyId: 'c', appConfiguration: {} });
  await svc.setCompanyContractEnforcement({ companyId: 'c', enforced: true });
  await svc.updateCompanySafe({ companyId: 'c', fields: { name: 'N' } });
  await svc.archiveCompany({ companyId: 'c', confirmCompanyId: 'c', reason: 'r' });
  await svc.listPlans();
  await svc.getPlan({ planId: 'p' });
  await svc.getCompanyContractConfiguration({ companyId: 'c' });
  await svc.previewCompanyEffectiveCapabilities({ companyId: 'c' });
  await svc.listAdminAudit({ limit: 5 });

  const expectedNames = Object.values(ADMIN_CALLABLE_NAMES);
  check('every service method maps to its callable, in order',
    calls.length === expectedNames.length && calls.every(([n], i) => n === expectedNames[i]),
    calls.map(([n]) => n).join(','));
  check('payload passthrough is verbatim',
    JSON.stringify(calls[0][1]) === JSON.stringify({ planId: 'p', displayName: 'P', capabilities: ['jsa'] }));
  const listPlansAt = calls.findIndex(([n]) => n === 'adminListPlans');
  check('optional list payload defaults to {}', JSON.stringify(calls[listPlansAt][1]) === '{}');
}

// ── response typing (data returned as-is) ─────────────────────────────────
{
  const svc = createAdminContractServiceCore(async () => ({ planId: 'p', status: 'active' }));
  const r = await svc.createPlan({ planId: 'p', displayName: 'P', capabilities: [] });
  check('typed response returned unwrapped', r.planId === 'p' && r.status === 'active');
}

// ── normalized error taxonomy ─────────────────────────────────────────────
const httpsErr = (code, adminCode) => {
  const e = new Error(adminCode ?? code);
  e.code = `functions/${code}`;
  if (adminCode) e.details = { adminCode };
  return e;
};
const kindOf = async (err) => {
  const svc = createAdminContractServiceCore(async () => { throw err; });
  try { await svc.getPlan({ planId: 'p' }); return 'NO-ERROR'; }
  catch (e) { return e instanceof AdminServiceError ? `${e.kind}:${e.adminCode}` : 'NOT-NORMALIZED'; }
};
check('unauthenticated distinct',
  await kindOf(httpsErr('unauthenticated', 'unauthenticated')) === 'unauthenticated:unauthenticated');
check('missing claim distinct',
  await kindOf(httpsErr('permission-denied', 'missing_admin_claim')) === 'missing_claim:missing_admin_claim');
check('claim_not_true → missing_claim',
  await kindOf(httpsErr('permission-denied', 'claim_not_true')) === 'missing_claim:claim_not_true');
check('disabled admin distinct (record disabled)',
  await kindOf(httpsErr('permission-denied', 'admin_record_disabled')) === 'disabled_admin:admin_record_disabled');
check('disabled admin distinct (no record)',
  await kindOf(httpsErr('permission-denied', 'no_admin_record')) === 'disabled_admin:no_admin_record');
check('disabled admin distinct (policy version)',
  await kindOf(httpsErr('permission-denied', 'unsupported_policy_version')) === 'disabled_admin:unsupported_policy_version');
check('protected-field denial → validation (request problem, not authority)',
  await kindOf(httpsErr('permission-denied', 'protected_field:planId')) === 'validation:protected_field:planId');
check('invalid-argument → validation',
  await kindOf(httpsErr('invalid-argument', 'unknown_fields:x')) === 'validation:unknown_fields:x');
check('plan_deprecated precondition → validation',
  await kindOf(httpsErr('failed-precondition', 'plan_deprecated')) === 'validation:plan_deprecated');
check('incompatible contract distinct (invalid existing)',
  await kindOf(httpsErr('failed-precondition', 'invalid_existing_contract:unsupported_contract_version:99'))
    === 'incompatible_contract:invalid_existing_contract:unsupported_contract_version:99');
check('incompatible contract distinct (not enforceable)',
  await kindOf(httpsErr('failed-precondition', 'not_enforceable:mode_not_entitled'))
    === 'incompatible_contract:not_enforceable:mode_not_entitled');
check('not-found distinct', await kindOf(httpsErr('not-found', 'plan_not_found')) === 'not_found:plan_not_found');
check('already-exists → conflict', await kindOf(httpsErr('already-exists', 'plan_already_exists')) === 'conflict:plan_already_exists');
check('unavailable → retryable', await kindOf(httpsErr('unavailable', null)) === 'retryable:null');
check('internal → retryable', await kindOf(httpsErr('internal', 'internal')) === 'retryable:internal');
check('deadline-exceeded → retryable', await kindOf(httpsErr('deadline-exceeded', null)) === 'retryable:null');
check('unrecognized error → unknown loudly', await kindOf(new Error('boom')) === 'unknown:null');
check('normalizeAdminError is idempotent',
  normalizeAdminError(new AdminServiceError('validation', 'x')).kind === 'validation');

// ── source pins: callable-only, no direct write fallback ──────────────────
for (const file of ['src/lib/adminContractServiceCore.ts', 'src/lib/adminContractService.ts']) {
  const src = readFileSync(join(root, file), 'utf8');
  check(`${file}: no firebase/firestore import`,
    !/^import[^\n]*['"]firebase\/firestore['"]/m.test(src));
  check(`${file}: no direct Firestore write tokens`,
    !/\b(updateDoc|setDoc|deleteDoc|addDoc|writeBatch|runTransaction)\b/.test(src));
}
{
  const core = readFileSync(join(root, 'src/lib/adminContractServiceCore.ts'), 'utf8');
  check('core is dependency-free (no imports)', !/^import /m.test(core));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
