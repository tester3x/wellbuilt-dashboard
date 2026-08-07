/**
 * vc51.9D Part 3 — CANONICAL SCHEMA ADEQUACY GATE (demonstration only).
 *
 * This test does NOT implement the DVIR protocol. It proves, against the
 * installed immutable @tester3x/wellbuilt-contracts@0.1.0, that the
 * package supplies shift-scoped BINDING but not the authenticated
 * request/completion WIRE PROTOCOL that WB-S, eQuipment, and Functions
 * would all have to agree on — which is why vc51.9D stops before
 * writing production protocol code.
 *
 * Run: node tools/test-dvirProtocolSchemaGap.mjs
 */
import * as contracts from '@tester3x/wellbuilt-contracts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const exported = Object.keys(contracts).sort();

// ── What 0.1.0 DOES provide (and must keep providing) ────────────────────
check('provides canonical period resolution', typeof contracts.resolveWorkPeriod === 'function');
check('provides typed open/bindable predicates',
  typeof contracts.isOperationallyOpen === 'function' && typeof contracts.mayBindRequestEvidence === 'function');
check('provides the equipment_dvir action semantics', typeof contracts.requiresWorkPeriod === 'function');
check('provides shift-scoped binding primitives',
  typeof contracts.bindShiftScopedRecord === 'function' && typeof contracts.verifyShiftScopedBinding === 'function');
check('provides the version handshake', typeof contracts.assertContractCompatible === 'function');
{
  // The DVIR record kinds exist — binding is expressible today.
  const bound = contracts.bindShiftScopedRecord(
    'dvir_pre_trip',
    {
      outcome: 'ACTIVE_EXPLICIT_SHIFT', contractVersion: 1, companyId: 'c', driverId: 'd',
      mode: 'explicit_shift', periodId: '2026-08-06_060000', startIso: null, endIso: null,
      timezone: null, source: 'authoritative_today', verifiedAtIso: 'now',
    },
    { companyId: 'c', driverId: 'd' },
    Date.parse('2026-08-06T15:00:00.000Z'),
  );
  check('dvir_pre_trip / dvir_post_trip / equipment_return_receipt kinds bind today',
    bound.ok === true && bound.binding.kind === 'dvir_pre_trip');
  const boundKeys = Object.keys(bound.binding).sort().join(',');
  check('ShiftScopedBinding is period identity ONLY (no request/status/protocol fields)',
    boundKeys === 'boundAtIso,companyId,contractVersion,driverId,kind,mode,periodId,source',
    boundKeys);
}

// ── What 0.1.0 DOES NOT provide — the gap ────────────────────────────────
const missing = [
  'DvirRequest', 'DvirRequestStatus', 'DvirCompletion', 'DvirCompletionRecord',
  'DVIR_PROTOCOL_VERSION', 'SUPPORTED_DVIR_PROTOCOL_VERSIONS',
  'buildDvirRequest', 'validateDvirCompletionSubmission', 'DVIR_REQUEST_KEYS',
  'DVIR_COMPLETION_KEYS', 'isDvirProtocolDowngrade',
];
for (const name of missing) {
  check(`0.1.0 does NOT export ${name} (gap)`, !(name in contracts));
}
// 11 RUNTIME values (the package's other 7 exports are types, erased at
// runtime) — all period resolution / binding / handshake, no protocol.
check('0.1.0 exports exactly the 11 runtime period/binding values (no protocol surface)',
  exported.length === 11, `${exported.length}: ${exported.join(' ')}`);

// ── Why that matters: each consumer would define its own copy ────────────
// A wire protocol needs, at minimum, agreement on ALL of these. None are
// expressible from 0.1.0 exports, so WB-S, eQuipment, and Functions would
// each declare them independently — exactly the drift the package exists
// to prevent (and exactly what happened to the JSA receipt v1/v2 key sets,
// which are now duplicated across three repositories).
const requiredAgreements = [
  'request status enum (open | consumed | cancelled | expired)',
  'protocol version constant + supported-version set',
  'exact request key set (field smuggling denial)',
  'exact completion key set',
  'downgrade rule (a v1 completion answering a v2 request)',
  'completion-submission validator',
  'server-vs-client timestamp field naming',
];
// NOTE: `mayBindRequestEvidence` contains "Request" but is a period
// PREDICATE ("may this resolution back request-bound evidence?"), not a
// request schema — so it is excluded explicitly rather than by accident.
check('a shared wire protocol needs agreements 0.1.0 cannot express',
  requiredAgreements.length === 7
  && !exported.filter((e) => e !== 'mayBindRequestEvidence')
    .some((e) => /Request|Completion|Protocol|Status/.test(e)));

console.log(`\n${pass} passed, ${fail} failed`);
console.log('\nCONCLUSION: 0.1.0 = period resolution + shift-scoped binding.');
console.log('It does NOT describe the authenticated server request/completion protocol.');
console.log('Implementing it now would duplicate canonical literals in 3 repositories.');
console.log('→ vc51.9D stops at the Part 3 gate; see docs/DVIR-PROTOCOL-0.2.0-PROPOSAL.md');
process.exit(fail ? 1 : 0);
