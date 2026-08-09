/**
 * vc51.9AD — the effective-policy preview must not invent a timezone.
 *
 * DEFECT, in describeEffectivePreview:
 *
 *   value: explicit
 *     ? `${cfg.timezone ?? 'America/Chicago'} — no derived schedule in explicit mode.`
 *
 * For the locked explicit-shift contract, which stores no timezone, this
 * rendered "America/Chicago — no derived schedule in explicit mode." under
 * a "Timezone / schedule" label. It is self-contradicting: it names a
 * timezone and then says nothing derives from it. It also appears in
 * CompanyContractPanel — the exact Admin → Companies surface used for plan
 * assignment and enforcement.
 *
 * Third instance of one class: the card WROTE a timezone (d3a5826), the
 * card's status line CLAIMED one (f6aa17e), and this preview claims one
 * too. The write path is untouched here and is re-asserted.
 *
 * The wording must not read as "the device has no timezone" — the meaning
 * is that the CONTRACT applies no fixed timezone or derived schedule.
 *
 * Run: node --experimental-strip-types tools/test-effectivePreviewTimezone.mjs
 */
import { describeEffectivePreview, buildWorkPeriodDraft } from '../src/lib/adminUiLogic.ts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const NOW = Date.parse('2026-08-09T14:00:00.000Z');
const caps = (mode) => ({
  ok: true,
  capabilities: {
    contractVersion: 1, companyId: 'liquid-gold', suiteLoginRequired: true,
    workPeriodMode: mode, explicitShiftRequiredBeforeJobs: mode === 'explicit_shift',
    jsaEnabled: true, dvirEnabled: true, customerEditableFields: [],
  },
  planDeprecated: false, overrideAdjusted: [],
});
const contract = (wpc) => ({
  contractVersion: 1, configurationVersion: 3, planId: 'explicit-shift-standard',
  entitlementOverrides: [], contractEnforced: true,
  ...(wpc ? { workPeriodConfiguration: wpc } : {}),
});
const preview = (mode, wpc, state = 'active') =>
  describeEffectivePreview({ state, result: caps(mode), contract: contract(wpc) }, NOW);
const dump = (lines) => JSON.stringify(lines);
const row = (lines, re) => lines.find((l) => re.test(l.label));

// ── 1. explicit shift, no stored timezone — the locked contract ─────────
{
  const lines = preview('explicit_shift', { mode: 'explicit_shift' });
  check('1. no America/Chicago anywhere in the explicit preview',
    !dump(lines).includes('America/Chicago'), dump(lines));
  const r = row(lines, /Timezone|Work-period behavior|behaviour/i);
  check('1. a work-period behaviour row is present', !!r, dump(lines));
  if (r) {
    check('1. it does not imply a derived schedule exists',
      /no .*(fixed )?(timezone|schedule)/i.test(r.value), r.value);
    check('1. it states the explicit lifecycle',
      /explicitly start and close/i.test(r.value), r.value);
    check('1. the label does not promise a timezone value',
      !/^Timezone \/ schedule$/.test(r.label), r.label);
  }
}

// ── 2. explicit shift carrying LEGACY timezone metadata ─────────────────
{
  const lines = preview('explicit_shift', { mode: 'explicit_shift', timezone: 'America/Denver' });
  check('2. a legacy timezone is not presented as operative configuration',
    !dump(lines).includes('America/Denver'), dump(lines));
  check('2. and no default is substituted for it either',
    !dump(lines).includes('America/Chicago'));
}

// ── 3. company-defined period with a real timezone ──────────────────────
{
  const lines = preview('company_defined_period',
    { mode: 'company_defined_period', timezone: 'Europe/Berlin', startLocalTime: '06:00', durationMinutes: 720 });
  const r = row(lines, /Timezone|Work-period behavior|behaviour/i);
  check('3. the real stored timezone is shown', !!r && r.value.includes('Europe/Berlin'), r?.value);
  check('3. the schedule preview is preserved',
    !!r && /06:00/.test(r.value) && /720/.test(r.value), r?.value);
}

// ── 4. company-defined period MISSING its timezone ──────────────────────
{
  const lines = preview('company_defined_period',
    { mode: 'company_defined_period', startLocalTime: '06:00', durationMinutes: 720 });
  check('4. a missing derived timezone is not defaulted to America/Chicago',
    !dump(lines).includes('America/Chicago'), dump(lines));
  const r = row(lines, /Timezone|Work-period behavior|behaviour/i);
  check('4. it is reported as missing, truthfully',
    !!r && /missing/i.test(r.value), r?.value);
}

// ── 5. absent / unconfigured contract ───────────────────────────────────
{
  const legacy = describeEffectivePreview({ state: 'legacy' }, NOW);
  check('5. a legacy company invents no timezone',
    !dump(legacy).includes('America/Chicago'), dump(legacy));
  const noWpc = preview('explicit_shift', null, 'inert');
  check('5. a contract with no workPeriodConfiguration invents no timezone',
    !dump(noWpc).includes('America/Chicago'), dump(noWpc));
  const invalid = describeEffectivePreview({ state: 'invalid', invalidReason: 'bad' }, NOW);
  check('5. an invalid contract invents no timezone',
    !dump(invalid).includes('America/Chicago'));
}

// ── 6. the fallback is gone from every explicit/unconfigured path ───────
{
  const all = [
    preview('explicit_shift', { mode: 'explicit_shift' }),
    preview('explicit_shift', { mode: 'explicit_shift', timezone: 'America/Denver' }),
    preview('explicit_shift', { mode: 'explicit_shift' }, 'inert'),
    preview('explicit_shift', null),
    describeEffectivePreview({ state: 'legacy' }, NOW),
  ].map(dump).join(' ');
  check('6. no America/Chicago fallback survives on any of them',
    !all.includes('America/Chicago'));
}

// ── 7. the write payload is untouched ───────────────────────────────────
{
  const d = buildWorkPeriodDraft({ editMode: 'explicit_shift', tz: 'America/Chicago', start: '06:00', duration: '720' });
  check('7. the explicit payload is still exactly {mode:"explicit_shift"}',
    JSON.stringify(d) === '{"mode":"explicit_shift"}', JSON.stringify(d));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
