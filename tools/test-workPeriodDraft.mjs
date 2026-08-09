/**
 * vc51.9AB — the explicit-shift payload must carry no derived-period field.
 *
 * DEFECT. WorkPeriodCard built its submission inline:
 *
 *   const draft = editMode === 'explicit_shift'
 *     ? { mode: 'explicit_shift', timezone: tz }        // <- always included
 *     : { mode: 'company_defined_period', timezone: tz, ... };
 *
 * `tz` defaults to 'America/Chicago' and the timezone input is rendered in
 * BOTH modes, so choosing explicit shift still submitted a timezone. The
 * server accepts it — parseStoredWorkPeriodConfiguration returns ok and
 * stores {mode:'explicit_shift', timezone:'America/Chicago'} — so nothing
 * rejects it. It is silently the wrong contract, not a failed write.
 *
 * The canonical package documents timezone / startLocalTime /
 * durationMinutes as DERIVED-MODE fields; explicit shift is complete
 * without any of them, and its customerEditableFields is []. Storing a
 * timezone there is meaningless state that no reader consults.
 *
 * The builder is extracted so the emitted payload is asserted directly
 * rather than inferred from the component's JSX.
 *
 * Run: node --experimental-strip-types tools/test-workPeriodDraft.mjs
 */
import { buildWorkPeriodDraft } from '../src/lib/adminUiLogic.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};
const keys = (o) => JSON.stringify(Object.keys(o).sort());

// ── THE defect: explicit shift emits mode and nothing else ───────────────
{
  const d = buildWorkPeriodDraft({ editMode: 'explicit_shift', tz: 'America/Chicago', start: '06:00', duration: '720' });
  check('1. default explicit-shift selection emits exactly {mode}',
    JSON.stringify(d) === '{"mode":"explicit_shift"}', JSON.stringify(d));
  check('1. no timezone key at all', !('timezone' in d));
  check('1. no startLocalTime key', !('startLocalTime' in d));
  check('1. no durationMinutes key', !('durationMinutes' in d));
  check('1. no extra keys beyond mode', keys(d) === '["mode"]', keys(d));
}

// ── 3. derived → explicit must not leak stale values ─────────────────────
{
  const d = buildWorkPeriodDraft({ editMode: 'explicit_shift', tz: 'Europe/Berlin', start: '23:15', duration: '415' });
  check('3. a mode switch leaks no stale derived values',
    JSON.stringify(d) === '{"mode":"explicit_shift"}', JSON.stringify(d));
}

// ── 5. an existing explicit config carrying legacy timezone ──────────────
// Reading such a config seeds `tz`; saving must still emit no timezone.
{
  const d = buildWorkPeriodDraft({ editMode: 'explicit_shift', tz: 'America/Denver', start: '06:00', duration: '720' });
  check('5. a legacy stored timezone is not resubmitted',
    !('timezone' in d) && d.mode === 'explicit_shift', JSON.stringify(d));
}

// ── 2/4. derived mode is preserved exactly ───────────────────────────────
{
  const d = buildWorkPeriodDraft({ editMode: 'company_defined_period', tz: 'America/Chicago', start: '06:00', duration: '720' });
  check('2. derived mode still emits all four fields',
    JSON.stringify(d) === JSON.stringify({ mode: 'company_defined_period', timezone: 'America/Chicago', startLocalTime: '06:00', durationMinutes: 720 }),
    JSON.stringify(d));
  check('2. durationMinutes is a number, not the raw input string',
    typeof d.durationMinutes === 'number');
  check('4. explicit → derived restores the derived fields rather than omitting them',
    'timezone' in d && 'startLocalTime' in d && 'durationMinutes' in d);
}
{
  // A non-numeric duration must surface as NaN for the existing validator
  // to reject, never be silently coerced to 0 or dropped.
  const d = buildWorkPeriodDraft({ editMode: 'company_defined_period', tz: 'America/Chicago', start: '06:00', duration: 'abc' });
  check('4. an invalid duration is not silently coerced to a valid number',
    Number.isNaN(d.durationMinutes), String(d.durationMinutes));
}

// ── the server's own validator agrees ────────────────────────────────────
{
  const CC = await import('../functions/lib/admin/companyContract.js');
  const d = buildWorkPeriodDraft({ editMode: 'explicit_shift', tz: 'America/Chicago', start: '06:00', duration: '720' });
  const r = CC.parseStoredWorkPeriodConfiguration(d);
  check('the emitted explicit payload is accepted and stored verbatim',
    r.ok && JSON.stringify(r.config) === '{"mode":"explicit_shift"}',
    r.ok ? JSON.stringify(r.config) : r.reason);
  check('and it is complete without any derived field',
    CC.isWorkPeriodConfigurationComplete(d).complete === true);
}

// ── the component wiring ─────────────────────────────────────────────────
{
  const raw = readFileSync(join(ROOT, 'src/components/settings/WorkPeriodCard.tsx'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the card builds its payload with the shared builder',
    /buildWorkPeriodDraft\(/.test(code));
  check('the inline timezone-always draft is gone',
    !/mode: 'explicit_shift', timezone: tz/.test(code));
  check('the callable still receives companyId separately from configuration',
    /setCompanyWorkPeriodConfiguration\(\{ companyId: company\.id, configuration: draft \}\)/.test(code));
  check('UI: derived controls are hidden while explicit shift is selected',
    /editMode === 'company_defined_period' && \(\s*<>[\s\S]{0,200}wp-tz-/.test(code)
    || /editMode === 'company_defined_period'[\s\S]{0,120}wp-tz-/.test(code),
    'the timezone input must not render in explicit-shift mode');
  check('UI: the explicit-shift explanation is present',
    /Drivers explicitly start and close each work period\. No fixed schedule or duration is applied\./.test(code));
  check('no maximum-duration or long-shift warning was introduced',
    !/max(imum)? duration|long shift|too long/i.test(code));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
