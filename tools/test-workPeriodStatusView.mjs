/**
 * vc51.9AC — the Work Period status line must describe what is STORED.
 *
 * DEFECT. The card rendered:
 *
 *   {' · '}Timezone: <span>{wpc?.timezone ?? 'America/Chicago'}</span>
 *
 * unconditionally. For the locked explicit-shift contract — which
 * deliberately stores no timezone — that presented `America/Chicago` as
 * though it were configuration. It is not stored, not read by any
 * consumer, and not settable: explicit_shift exposes
 * customerEditableFields: []. The same fallback also misreported an
 * unconfigured company and a derived company whose timezone is genuinely
 * missing.
 *
 * This is the display counterpart of d3a5826. That commit stopped the card
 * WRITING a timezone in explicit mode; this stops it CLAIMING one.
 *
 * The view is extracted so the rendered values are asserted directly
 * rather than inferred from JSX. `timezone: null` is the contract for
 * "render no timezone segment at all" — deliberately not an empty string,
 * so a caller cannot render an empty label by accident.
 *
 * Run: node --experimental-strip-types tools/test-workPeriodStatusView.mjs
 */
import { workPeriodStatusView, buildWorkPeriodDraft } from '../src/lib/adminUiLogic.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

// ── 1. explicit shift, no stored timezone — the locked contract ──────────
{
  const v = workPeriodStatusView({ mode: 'explicit_shift' });
  check('1. explicit shift presents NO timezone', v.timezone === null, String(v.timezone));
  check('1. it states the lifecycle instead',
    v.lifecycle === 'Drivers explicitly start and close each work period.', String(v.lifecycle));
  check('1. the mode is still named', /explicit shift/i.test(v.modeLabel), v.modeLabel);
  check('1. nothing implies a default schedule or timezone',
    !/America\/Chicago|default|schedule/i.test(JSON.stringify(v)), JSON.stringify(v));
}

// ── 2. explicit shift carrying LEGACY timezone metadata ─────────────────
// A contract written before d3a5826 can hold a stray timezone. It is not
// lifecycle configuration and must not be presented as such.
{
  const v = workPeriodStatusView({ mode: 'explicit_shift', timezone: 'America/Denver' });
  check('2. a legacy stored timezone is not presented in explicit mode',
    v.timezone === null, String(v.timezone));
  check('2. and the stray value never reaches the view at all',
    !JSON.stringify(v).includes('America/Denver'), JSON.stringify(v));
}

// ── 3. company-defined mode keeps its real timezone ─────────────────────
{
  const v = workPeriodStatusView({ mode: 'company_defined_period', timezone: 'Europe/Berlin', startLocalTime: '06:00', durationMinutes: 720 });
  check('3. derived mode shows its actual stored timezone',
    v.timezone === 'Europe/Berlin', String(v.timezone));
  check('3. derived mode shows no explicit-lifecycle copy', v.lifecycle === null);
  check('3. the mode is named', /company-defined/i.test(v.modeLabel), v.modeLabel);
}

// ── 3b. derived mode with genuinely missing timezone (legacy) ───────────
{
  const v = workPeriodStatusView({ mode: 'company_defined_period' });
  check('3b. incomplete derived data is reported truthfully, not defaulted',
    v.timezone === 'not set', String(v.timezone));
  check('3b. and America/Chicago is never substituted',
    !JSON.stringify(v).includes('America/Chicago'));
}

// ── 4. absent / legacy configuration ────────────────────────────────────
for (const [label, input] of [['null', null], ['undefined', undefined]]) {
  const v = workPeriodStatusView(input);
  check(`4. an absent configuration (${label}) claims no stored timezone`,
    v.timezone === null, String(v.timezone));
  check(`4. and reports it is not configured (${label})`,
    /not configured/i.test(v.modeLabel), v.modeLabel);
}

// ── 5. the payload correction is untouched ──────────────────────────────
{
  const d = buildWorkPeriodDraft({ editMode: 'explicit_shift', tz: 'America/Chicago', start: '06:00', duration: '720' });
  check('5. the explicit payload is still exactly {mode:"explicit_shift"}',
    JSON.stringify(d) === '{"mode":"explicit_shift"}', JSON.stringify(d));
}

// ── the component uses it ───────────────────────────────────────────────
{
  const raw = readFileSync(join(ROOT, 'src/components/settings/WorkPeriodCard.tsx'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the false timezone fallback is gone from the card',
    !/wpc\?\.timezone \?\? 'America\/Chicago'/.test(code),
    'the unconditional America/Chicago fallback must not remain');
  check('the card renders the shared status view', /workPeriodStatusView\(/.test(code));
  check('the timezone segment is conditional on there being one',
    /status\.timezone && \(/.test(code) || /\{status\.timezone !== null/.test(code));
  check('start time and duration are not in the status line',
    !/Start:|Duration:/.test(code.slice(code.indexOf('Mode:'), code.indexOf('Mode:') + 600)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
