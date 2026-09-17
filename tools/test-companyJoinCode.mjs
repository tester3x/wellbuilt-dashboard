/**
 * Company Join Code card — source-contract test.
 *
 * The card obtains a company's employee-onboarding join code through the deployed
 * governed getCompanyJoinCode callable (retrieve-or-allocate; NEVER rotate). This
 * harness is static + logic-only: it invokes NO Firebase and never fetches or
 * consumes a live code (zero production invocation). It proves the client gates the
 * control to manage-drivers/platform admins, is company-isolated (a tenant admin can
 * never target another company), never sends a rotate flag, fetches only on an
 * explicit action (never on mount), clears the plaintext on unmount, copies without
 * leaking, shows branded failure copy, and is mounted in BOTH surfaces.
 *
 * Run: node tools/test-companyJoinCode.mjs
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

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const card = strip(readFileSync(join(ROOT, 'src/components/admin/CompanyJoinCodeCard.tsx'), 'utf8'));
const model = strip(readFileSync(join(ROOT, 'src/lib/joinCodeCardModel.ts'), 'utf8'));
const svc = strip(readFileSync(join(ROOT, 'src/lib/secureDriverAdmin.ts'), 'utf8'));
const tab = strip(readFileSync(join(ROOT, 'src/components/admin/CompaniesTab.tsx'), 'utf8'));
const settings = strip(readFileSync(join(ROOT, 'src/app/settings/page.tsx'), 'utf8'));

// ── wiring: shared callable + BOTH surfaces ─────────────────────────────────
check('service wrapper targets the deployed getCompanyJoinCode callable (never shortCode)',
  /httpsCallable\(getFirebaseFunctions\(\), 'getCompanyJoinCode'\)/.test(svc) && !/shortCode/.test(svc));
check('SURFACE 1 — mounted in the platform-admin CompaniesTab',
  /<CompanyJoinCodeCard companyId=\{company\.id\}\s*\/>/.test(tab) && /from '\.\/CompanyJoinCodeCard'/.test(tab));
check('SURFACE 2 — mounted in the customer Settings page',
  /<CompanyJoinCodeCard companyId=\{company\.id\}\s*\/>/.test(settings)
  && /from '@\/components\/admin\/CompanyJoinCodeCard'/.test(settings));
check('the card never references companies.shortCode',
  !/shortCode/.test(card) && !/shortCode/.test(model));

// ── authorization / capability gating ───────────────────────────────────────
check('the card renders nothing for unauthorized users',
  /if \(!canManageJoinCode\(user, userCompany\)\) return null;/.test(card));
check('gating is the capability model, not an ad-hoc role check',
  /canManageJoinCode/.test(card) && !/user\.role\s*===\s*'/.test(card));
check('model: canManageJoinCode = platform admin OR the manageDrivers capability',
  /return isPlatformAdmin\(user\) \|\| hasCapability\(user, 'manageDrivers', companyConfig\);/.test(model));

// ── company isolation (tenant must not supply an id; platform may target) ───
check('model: a tenant admin sends NO companyId; only a platform admin targets by id',
  /return platformAdmin && companyId \? \{ companyId \} : \{\};/.test(model));
check('card computes platform vs tenant and passes the isolation-safe args',
  /const platform = isPlatformAdmin\(user\);/.test(card)
  && /adminGetCompanyJoinCode\(joinCodeCallArgs\(platform, companyId\)\)/.test(card));

// ── explicit invocation only (NEVER on page load) ───────────────────────────
check('the callable is invoked exactly once, inside the explicit load() action',
  (card.match(/adminGetCompanyJoinCode\(/g) || []).length === 1 && /const load = async/.test(card));
check('no effect fetches on mount — no useEffect body calls load()/adminGetCompanyJoinCode',
  (() => {
    // Scan each useEffect(...) block up to its dependency-array close and ensure
    // none invokes the fetch (fetch happens only from the explicit button onClick).
    const blocks = [];
    let i = 0;
    while ((i = card.indexOf('useEffect(', i)) !== -1) {
      const end = card.indexOf('}, [', i);
      blocks.push(card.slice(i, end === -1 ? i + 400 : end + 8));
      i += 10;
    }
    return blocks.length > 0 && blocks.every((b) => !/load\(\)/.test(b) && !/adminGetCompanyJoinCode/.test(b));
  })());
check('initial state is idle (nothing fetched until the user acts)',
  /useState<JoinCodeState>\(\{ phase: 'idle' \}\)/.test(card));
check('the fetch control label is the explicit "Show or create join code"',
  /return 'Show or create join code';/.test(model));

// ── no rotation until the backend supports it ───────────────────────────────
check('the client never sends a rotate/regenerate/replace/force flag',
  !/\b(rotate|regenerate|replace|force|reset|renew)\b/i.test(card));
check('once a code is shown the fetch button is gone (no silent re-request/replace)',
  /state\.phase !== 'ready' &&[\s\S]*?joinCodeActionLabel\(state\)/.test(card));

// ── clears plaintext on unmount / leaving ───────────────────────────────────
check('an unmount effect clears the displayed code',
  /useEffect\(\(\) => \{\s*return \(\) => \{\s*setState\(\{ phase: 'idle' \}\);/.test(card));
check('changing company also clears the displayed code',
  /useEffect\(\(\) => \{\s*setState\(\{ phase: 'idle' \}\);\s*setCopied\(false\);\s*\}, \[companyId\]\);/.test(card));

// ── copy ────────────────────────────────────────────────────────────────────
check('copy uses the clipboard on the code held in transient state',
  /navigator\.clipboard\.writeText\(state\.joinCode\)/.test(card));
check('copy shows a transient confirmation', /'✓ Copied!'/.test(card));

// ── no leakage of the plaintext code ────────────────────────────────────────
check('the code is never logged (card or wrapper)',
  !/console\.\w+\([^)]*joinCode/.test(card) && !/console\.\w+\([^)]*joinCode/.test(svc));
check('the code is never placed in browser storage',
  !/localStorage|sessionStorage/.test(card));
check('the code is never placed in the URL or an analytics call',
  !/location\.(href|search)|URLSearchParams|history\.(push|replace)|track\(|analytics/i.test(card));

// ── failure copy (branded, non-leaking) ─────────────────────────────────────
check('the error phase renders branded copy, never the raw error',
  /friendlyJoinCodeError\(err\)/.test(card) && !/message: String\(err/.test(card));
check('model: friendlyJoinCodeError maps codes to branded copy and never echoes the raw error',
  /permission-denied/.test(model) && /invalid-argument/.test(model) && /unavailable/.test(model)
  && !/\$\{.*err.*\}/.test(model));

// ── zero production invocation by this harness ──────────────────────────────
check('this harness imports no Firebase and makes no live callable call',
  (() => {
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    return !/from ['"]firebase|require\(['"]firebase/.test(self) && !/getFirebaseFunctions\(\)/.test(self);
  })());

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
