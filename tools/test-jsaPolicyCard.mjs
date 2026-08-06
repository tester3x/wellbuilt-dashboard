/**
 * vc51.4 — Dashboard three-state per-job policy control.
 *
 * RED-FIRST: fails before the change — no jsaPolicy lib existed, JsaCard
 * had no per-job requirement radio, the Allow Acknowledge checkbox
 * governed per-job behavior, the section intro contradicted the option
 * copy (start-time vs close-time), and legacy modes were never
 * normalized on save.
 *
 * Run: node --experimental-strip-types tools/test-jsaPolicyCard.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  canonicalizeJsaMode,
  canonicalizeJsaJobPolicy,
  isLegacyJsaMode,
  JSA_JOB_POLICIES,
} from '../src/lib/jsaPolicy.ts';

function expect(cond, msg) { if (!cond) throw new Error(msg); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const card = readFileSync(join(root, 'src/components/settings/JsaCard.tsx'), 'utf8');
const settings = readFileSync(join(root, 'src/lib/companySettings.ts'), 'utf8');

// ── Policy mapping — byte-identical contract with the apps ──────────────────
for (const p of ['acknowledge', 'read', 'read_and_acknowledge']) {
  expect(canonicalizeJsaJobPolicy(p, false) === p && canonicalizeJsaJobPolicy(p, true) === p,
    `explicit '${p}' wins over the legacy toggle`);
}
for (const bad of [undefined, null, '', 'both', 'ACK', 42, {}]) {
  expect(canonicalizeJsaJobPolicy(bad, true) === 'acknowledge'
    && canonicalizeJsaJobPolicy(bad, undefined) === 'acknowledge',
    `legacy fallback (allowAck !== false) → acknowledge for ${JSON.stringify(bad)}`);
  expect(canonicalizeJsaJobPolicy(bad, false) === 'read',
    `legacy fallback (allowAck === false) → read for ${JSON.stringify(bad)}`);
}
// Modes: off / per_shift / per_job unchanged; legacy aliases detected.
expect(canonicalizeJsaMode('off') === 'off' && canonicalizeJsaMode('per_shift') === 'per_shift'
  && canonicalizeJsaMode('per_job') === 'per_job'
  && canonicalizeJsaMode('per_load') === 'per_job' && canonicalizeJsaMode('per_location') === 'per_job'
  && canonicalizeJsaMode('junk') === 'off',
  'mode canonicalization matrix');
expect(isLegacyJsaMode('per_load') && isLegacyJsaMode('per_location')
  && !isLegacyJsaMode('per_job') && !isLegacyJsaMode(undefined),
  'legacy-alias detection drives deliberate-save normalization');

// ── Approved customer-facing copy (no over-claims) ──────────────────────────
{
  const byValue = Object.fromEntries(JSA_JOB_POLICIES.map((p) => [p.value, p]));
  expect(byValue.acknowledge.desc.includes('confirms it with Start Job')
    && byValue.acknowledge.desc.includes('Completing the full JSA also satisfies'),
    'acknowledge copy approved');
  expect(byValue.read.desc.includes('No acknowledgement shortcut'),
    'read copy approved');
  expect(byValue.read_and_acknowledge.desc.includes('then reviews what that specific job adds'),
    'read_and_acknowledge copy approved');
  const all = JSA_JOB_POLICIES.map((p) => p.label + p.desc).join(' ');
  expect(!/cryptograph|comprehension|tamper|guarantee/i.test(all),
    'no over-claims in customer copy');
}

// ── JsaCard wiring pins ─────────────────────────────────────────────────────
// The card consumes the ONE shared lib (no local duplicate mapping).
expect(card.includes("from '@/lib/jsaPolicy'") && !card.includes('function canonicalizeMode('),
  'JsaCard uses the shared canonicalizers');
// Per-job requirement radio exists, gated to Per Job, writes jsaJobPolicy.
expect(card.includes("currentMode === 'per_job'") && card.includes('Per-job requirement'),
  'per-job requirement radio renders only under Per Job');
expect(card.includes('{ jsaJobPolicy: policy }'),
  'selecting a policy writes jsaJobPolicy');
// The Allow Acknowledge checkbox survives ONLY in the per-shift context —
// no second control can contradict the per-job policy.
{
  const ackIdx = card.indexOf('Allow Acknowledge shortcut');
  expect(ackIdx > 0, 'per-shift shortcut checkbox still exists');
  const before = card.slice(0, ackIdx);
  const gate = before.lastIndexOf("currentMode === 'per_shift'");
  const jobGate = before.lastIndexOf("currentMode !== 'off'");
  expect(gate > 0 && gate > jobGate,
    'the checkbox is gated to per_shift only (never shown for per_job)');
}
// Copy correction: start-time enforcement + close as safety net; the old
// contradictory intro is gone.
expect(card.includes('before starting applicable job work')
  && card.includes('safety net'),
  'section intro states start-time enforcement with close as safety net');
expect(!card.includes('driver acknowledges (or reads) at every job close'),
  'the old close-time per-job description is gone');
// Deliberate-save normalization: clicking a mode writes when the stored
// value is a legacy alias, even if the canonical mode is unchanged.
expect(card.includes('isLegacyJsaMode(company.jsaMode)'),
  'deliberate save normalizes legacy per_load/per_location to per_job');

// ── Stored-field contract ───────────────────────────────────────────────────
expect(settings.includes("jsaJobPolicy?: 'acknowledge' | 'read' | 'read_and_acknowledge'"),
  'companySettings declares the optional jsaJobPolicy field');

console.log('jsaPolicyCard tests passed');
