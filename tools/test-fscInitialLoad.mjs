/**
 * FSC initial-load rendering + governed Backfill client wiring.
 * Run: node --experimental-strip-types tools/test-fscInitialLoad.mjs
 *
 * getFuelSurchargeRate lives in src/lib/billing.ts, which transitively imports
 * ./firebase and so cannot be imported under node --strip-types. We instead (a)
 * assert billing.ts is byte-unchanged from the deployed lineage (calc preserved
 * exactly) and (b) verify the pinned rate-band examples against a faithful
 * transcription of its flat_doe formula. Everything else is source wiring.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(join(root, rel), 'utf8');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

// ── Rate-band calc preserved exactly ─────────────────────────────────────────
// billing.ts (where getFuelSurchargeRate lives) must be untouched by this change.
let billingUnchanged = false;
try {
  const out = execSync('git diff --stat 3ea36d84 -- src/lib/billing.ts', { cwd: root }).toString().trim();
  billingUnchanged = out === '';
} catch { /* if git unavailable, fall through to formula check only */ }
check('src/lib/billing.ts unchanged vs deployed lineage (calc preserved)', billingUnchanged);

// Faithful transcription of getFuelSurchargeRate flat_doe (billing.ts:177-190).
const flatDoe = (diesel, { baseline = 3.25, multiplier = 8, step = 0.10, floor, ceiling } = {}) => {
  const stepped = Math.floor(diesel / step) * step;
  const diff = stepped - baseline;
  if (diff <= 0) return floor || 0;
  let perHour = Math.round(multiplier * diff * 100) / 100;
  if (floor && perHour < floor) perHour = floor;
  if (ceiling && perHour > ceiling) perHour = ceiling;
  return perHour;
};
const disp = (p) => `$${flatDoe(p).toFixed(2)}/hr`;
check('pin $5.57 → $18.00/hr', disp(5.57) === '$18.00/hr', disp(5.57));
check('pin $5.64 → $18.80/hr', disp(5.64) === '$18.80/hr', disp(5.64));
check('pin $5.43 → $17.20/hr', disp(5.43) === '$17.20/hr', disp(5.43));
// the transcription matches the shipped source formula verbatim
const billing = src('src/lib/billing.ts');
check('shipped flat_doe formula present verbatim', /const stepped = Math\.floor\(diesel \/ step\) \* step;/.test(billing) && /Math\.round\(multiplier \* diff \* 100\) \/ 100/.test(billing));

// ── Initial-load rendering (source wiring) ───────────────────────────────────
const page = src('src/app/billing/page.tsx');
check('companiesLoaded state exists', /const \[companiesLoaded, setCompaniesLoaded\] = useState\(false\)/.test(page));
check('companiesLoaded set true after loadAllCompanies resolves', /setCompanies\(map\);[\s\S]{0,400}setCompaniesLoaded\(true\)/.test(page));
check('companiesLoaded set true on failure too (no hang on loading)', (page.match(/setCompaniesLoaded\(true\)/g) || []).length >= 2);
check('Price History shows a loading state while config unresolved', /!companiesLoaded \?[\s\S]{0,500}Loading billing configuration/.test(page));
check('FSC Rate header gates on resolved historyFscConfig', /\{historyFscConfig && <th[^>]*>FSC Rate<\/th>\}/.test(page));
check('FSC cell still uses getFuelSurchargeRate (calc unchanged)', /getFuelSurchargeRate\(historyFscConfig, entry\.price\)/.test(page));

// ── Governed Backfill wiring (no direct write) ───────────────────────────────
check('Backfill calls the governed callable', /const res = await backfillDieselPrices\(12\)/.test(page));
check('Backfill handler no longer loops saveDieselPrice', !/for \(const r of results\.reverse\(\)\)[\s\S]{0,200}saveDieselPrice/.test(page));
check('Backfill duplicate-submit guarded', /if \(!effectiveCompanyId \|\| fetchingEia\) return;/.test(page));
check('Backfill button disabled while running', /onClick=\{handleBackfillHistory\}[\s\S]{0,80}disabled=\{fetchingEia \|\| !effectiveCompanyId\}/.test(page));
check('imports the governed backfill client', /import \{ backfillDieselPrices, describeBackfillError \} from '@\/lib\/dieselBackfill'/.test(page));

// ── Sanitized error mapping (no raw transport text) ──────────────────────────
const lib = src('src/lib/dieselBackfill.ts');
check('maps permission-denied → friendly', /permission-denied':\s*\n?\s*return 'You do not have permission/.test(lib) || /case 'permission-denied':[\s\S]{0,80}do not have permission/.test(lib));
check('maps no_region → friendly', /no_region':[\s\S]{0,80}DOE fuel region/.test(lib));
check('has a generic default (no raw leak)', /Could not backfill diesel prices\. Please try again\./.test(lib));
check('never returns raw err.message', !/return .*\berr\b.*message/.test(lib));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
