/**
 * vc51.9A7 — admin UI source pins (Part 14): the protected surfaces are
 * callable-only, claim-gated, and free of bypasses — proven on the
 * actual component sources, not just documented.
 *
 * Run: node tools/test-adminUiPins.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};
const noFirestoreImport = (text) => !/^import[^\n]*['"]firebase\/firestore['"]/m.test(text);

// Protected admin components are callable-only.
for (const file of [
  'src/components/admin/PlansTab.tsx',
  'src/components/admin/CompanyContractPanel.tsx',
  'src/components/admin/AdminAuditTab.tsx',
  'src/components/admin/VerifiedAdminGate.tsx',
  'src/components/settings/WorkPeriodCard.tsx',
  'src/lib/useVerifiedAdmin.ts',
  'src/lib/adminUiLogic.ts',
]) {
  const text = src(file);
  check(`${file}: no firebase/firestore import`, noFirestoreImport(text));
  check(`${file}: no direct Firestore write tokens`,
    !/\b(updateDoc|setDoc|deleteDoc|addDoc|writeBatch|runTransaction)\b/.test(text));
}
for (const file of [
  'src/components/admin/PlansTab.tsx',
  'src/components/admin/CompanyContractPanel.tsx',
  'src/components/admin/AdminAuditTab.tsx',
  'src/components/settings/WorkPeriodCard.tsx',
]) {
  check(`${file}: uses the typed callable service`,
    src(file).includes("createAdminContractService"));
}

// PlansTab: no hard delete anywhere; deprecate is the only removal verb.
{
  const t = src('src/components/admin/PlansTab.tsx');
  check('PlansTab has no delete operation (no delete call exists)',
    !/service\.\w*[dD]elete|deleteDoc|deletePlan/.test(t));
  check('PlansTab edit never submits planId as a mutable field',
    t.includes('planId: editing.planId') && t.includes('permanent'));
}

// Admin page: protected tabs gated by the verified session, not viewAdmin.
{
  const t = src('src/app/admin/page.tsx');
  check('admin page uses useVerifiedAdmin session', t.includes('useVerifiedAdmin'));
  check('Plans/Audit buttons render only for verified session',
    /adminSession\.status === 'verified'[\s\S]*?setActiveTab\('plans'\)/.test(t));
  check('direct-route manipulation bounced when not verified',
    /activeTab === 'plans' \|\| activeTab === 'adminaudit'[\s\S]*?setActiveTab\('companies'\)/.test(t));
  check('protected tab content wrapped in VerifiedAdminGate',
    (t.match(/VerifiedAdminGate session={adminSession}/g) || []).length === 2);
  check('viewAdmin does not gate the protected tabs',
    !/viewAdmin[\s\S]{0,80}setActiveTab\('plans'\)/.test(t));
  check('protected tabs lazy-load via next/dynamic', t.includes("dynamic(() => import('@/components/admin/PlansTab')"));
}

// CompaniesTab: safe-mutation migration.
{
  const t = src('src/components/admin/CompaniesTab.tsx');
  check('WB-admin edit routes through adminUpdateCompanySafe',
    t.includes('adminService.updateCompanySafe'));
  check('configured-company removal routes through archiveCompany',
    t.includes('adminService.archiveCompany') && t.includes('confirmCompanyId: company.id'));
  check('archive requires typed exact-id confirmation and a reason',
    /Type the company id[\s\S]*?to archive/.test(t) && t.includes('Archive reason (required, audited)'));
  check('legacy client delete is labeled with the orphan warning and routed by contract state',
    t.includes('companyMutationRoute') && t.includes('LEGACY DELETE') && t.includes('orphaned'));
  check('create can never overwrite an existing company (maskless-replace hazard closed)',
    /getDoc\(doc\(firestore, 'companies', id\)\)/.test(t) && t.includes('already exists'));
  check('legacy tier labeled display-only/non-authoritative',
    t.includes('display only, NOT authoritative'));
  check('contract panel embedded for WB admins',
    t.includes('<CompanyContractPanel companyId={company.id} />'));
}

// Overrides never mix with employee roles; no client actor fields.
{
  const t = src('src/components/admin/CompanyContractPanel.tsx');
  check('override copy separates entitlement from employee roles',
    t.includes('never change employee roles'));
  check('roleCapabilities never used as code in contract panel (comment-only)',
    !/roleCapabilities\s*[:.=[\]]/.test(t));
  check('no client-supplied actor fields in override calls',
    !/grantedBy|actorUid/.test(t));
  check('override removal requires confirmation + audited reason',
    /window\.confirm\(`Remove all/.test(t) && t.includes('Removal reason (required, audited)'));
  check('assignment copy states it never enforces',
    t.includes('assignment alone never enforces'));
  check('enforcement requires typed company-id confirmation',
    /Type the company id[\s\S]*?to confirm/.test(t));
  check('disable path present and described as rollback containment',
    t.includes('Disable enforcement (rollback)'));
}

// WorkPeriodCard: separate from JsaCard, read-only for non-verified.
{
  const t = src('src/components/settings/WorkPeriodCard.tsx');
  check('WorkPeriodCard does not import JsaCard', !/import[^\n]*JsaCard/.test(t));
  check('WorkPeriodCard shows the login-vs-shift distinction', t.includes('LOGIN_VS_SHIFT_COPY'));
  check('company admins read-only until verified customer-admin authority',
    t.includes('Read-only') && t.includes('customer-admin authority'));
  check('derived example uses the canonical resolver helper', t.includes('derivedScheduleExample'));
  check('invalid schedules cannot submit', t.includes('!draftValid') && t.includes('Invalid schedules cannot be submitted'));
  const settings = src('src/app/settings/page.tsx');
  check('WorkPeriodCard wired into settings separately from JsaCard',
    settings.includes('<WorkPeriodCard company={company}'));
}

// Audit view: callable pagination only.
{
  const t = src('src/components/admin/AdminAuditTab.tsx');
  check('audit view reads via listAdminAudit callable', t.includes('service.listAdminAudit'));
  check('audit view paginates with cursor', t.includes('nextCursor'));
}

// Accessibility spot pins (labels, dialog/status roles, fieldsets).
{
  const plans = src('src/components/admin/PlansTab.tsx');
  check('plan form inputs have associated labels',
    plans.includes('htmlFor="plan-id"') && plans.includes('htmlFor="plan-name"') && plans.includes('<fieldset>'));
  const wp = src('src/components/settings/WorkPeriodCard.tsx');
  check('work-period mode uses radiogroup semantics', wp.includes('role="radiogroup"') && wp.includes('type="radio"'));
  const gate = src('src/components/admin/VerifiedAdminGate.tsx');
  check('gate announces state accessibly and focus-styles the refresh control',
    gate.includes('role="status"') && gate.includes('focus:ring'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
