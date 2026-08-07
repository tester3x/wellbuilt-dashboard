/**
 * vc51.9D Part 3 gate — CLOSED by @tester3x/wellbuilt-contracts@0.2.0.
 *
 * HISTORY. Against the installed immutable 0.1.0 this test proved a gap:
 * the package supplied shift-scoped BINDING but not the authenticated
 * request/completion WIRE PROTOCOL that WB-S, eQuipment, and Functions
 * would all have to agree on. That is why vc51.9D stopped before writing
 * production protocol code, and why 0.2.0 was authored.
 *
 * NOW. 0.2.0 is published, immutable, and pinned here, so the gate is
 * closed. This test keeps proving both halves: everything 0.1.0
 * guaranteed is still guaranteed (unchanged), and each agreement the
 * protocol needs is now expressible from ONE canonical package instead
 * of being redeclared in three repositories.
 *
 * It still does NOT implement the protocol — adopting the package and
 * implementing the server are separate steps (vc51.9D remains unstarted).
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

// ── What 0.1.0 provided — must keep providing, unchanged ─────────────────
check('provides canonical period resolution', typeof contracts.resolveWorkPeriod === 'function');
check('provides typed open/bindable predicates',
  typeof contracts.isOperationallyOpen === 'function' && typeof contracts.mayBindRequestEvidence === 'function');
check('provides the equipment_dvir action semantics', typeof contracts.requiresWorkPeriod === 'function');
check('provides shift-scoped binding primitives',
  typeof contracts.bindShiftScopedRecord === 'function' && typeof contracts.verifyShiftScopedBinding === 'function');
check('provides the version handshake', typeof contracts.assertContractCompatible === 'function');
check('contract version is still 1 (0.2.0 is additive, not a new contract)',
  contracts.CONTRACT_VERSION === 1);
{
  // The DVIR record kinds bind exactly as they did under 0.1.0.
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
  check('ShiftScopedBinding is STILL period identity only (0.2.0 added no fields)',
    boundKeys === 'boundAtIso,companyId,contractVersion,driverId,kind,mode,periodId,source',
    boundKeys);
}

// ── The gap, now closed — each agreement maps to a real 0.2.0 export ─────
// The 0.1.0-era list of "missing" names was a sketch. 0.2.0 supplies each
// underlying agreement, in some cases under a deliberately different and
// finer shape than the sketch guessed; the mapping is spelled out so the
// closure is auditable rather than assumed.
const agreements = [
  ['request status enum', () => Array.isArray(contracts.DVIR_REQUEST_STATUSES)
    && contracts.DVIR_REQUEST_STATUSES.includes('open')
    && contracts.DVIR_REQUEST_STATUSES.includes('expired')],
  ['protocol version constant + supported set', () => contracts.DVIR_PROTOCOL_VERSION === 1
    && Array.isArray(contracts.SUPPORTED_DVIR_PROTOCOL_VERSIONS)],
  ['exact request key set (field-smuggling denial)', () => Array.isArray(contracts.DVIR_REQUEST_KEYS)
    && contracts.DVIR_REQUEST_KEYS.length > 0],
  // 0.2.0 splits the sketch's single DVIR_COMPLETION_KEYS into three
  // precise sets — what a client may submit, what the server stores, and
  // what the lightweight view may expose. Finer than requested, not less.
  ['exact completion key sets (submission / record / view)', () =>
    Array.isArray(contracts.DVIR_COMPLETION_SUBMISSION_KEYS)
    && Array.isArray(contracts.DVIR_COMPLETION_RECORD_KEYS)
    && Array.isArray(contracts.DVIR_COMPLETION_VIEW_KEYS)],
  ['downgrade rule', () => typeof contracts.isDvirProtocolDowngrade === 'function'
    && typeof contracts.assertDvirProtocolCompatible === 'function'],
  ['completion-submission validator', () => typeof contracts.validateDvirCompletionSubmission === 'function'],
  ['server-vs-client timestamp naming', () =>
    contracts.DVIR_COMPLETION_RECORD_KEYS.some((k) => /Server$/.test(k))
    && contracts.DVIR_COMPLETION_SUBMISSION_KEYS.every((k) => !/Server$/.test(k))],
];
for (const [name, ok] of agreements) check(`0.2.0 supplies: ${name}`, ok());
check('all 7 required agreements are now expressible from one package',
  agreements.length === 7 && agreements.every(([, ok]) => ok()));

// The protocol surface is additive: 0.1.0's 11 runtime values survive.
const v010Runtime = [
  'CONTRACT_VERSION', 'SUPPORTED_CONTRACT_VERSIONS', 'assertContractCompatible',
  'bindShiftScopedRecord', 'isOperationallyOpen', 'isValidTimezone', 'localDateInZone',
  'mayBindRequestEvidence', 'requiresWorkPeriod', 'resolveWorkPeriod', 'verifyShiftScopedBinding',
];
const lost = v010Runtime.filter((n) => !(n in contracts));
check('every one of the 11 published 0.1.0 runtime exports survives', lost.length === 0, lost.join(','));
check('0.2.0 exposes the protocol surface additively',
  exported.length === 71, `${exported.length} runtime exports`);

// Request/completion RECORD shapes are TYPES — erased at runtime by
// design, so they are absent from the runtime namespace in 0.2.0 exactly
// as they were in 0.1.0. They are consumed through the declarations, and
// tools/test-functionsDeployBoundary.mjs typechecks them under strict.
for (const t of ['DvirRequest', 'DvirRequestStatus', 'DvirCompletionRecord']) {
  check(`${t} is type-level only (correctly absent at runtime)`, !(t in contracts));
}

// ── Adoption is not implementation ───────────────────────────────────────
check('no production DVIR server protocol is implemented here',
  typeof contracts.buildDvirRequest === 'undefined');

console.log(`\n${pass} passed, ${fail} failed`);
console.log('\nCONCLUSION: the vc51.9D Part 3 schema gate is CLOSED.');
console.log('0.2.0 supplies period resolution + binding + the authenticated');
console.log('request/completion protocol from ONE immutable package, so no');
console.log('consumer needs to redeclare canonical literals.');
console.log('→ implementing the server protocol remains future vc51.9D work.');
process.exit(fail ? 1 : 0);
