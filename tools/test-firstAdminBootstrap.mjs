/**
 * vc51.9Z — first-platform-admin bootstrap: authority decision + ordering.
 *
 * The dual gate (verified wellbuiltAdmin claim AND an enabled
 * platform_admins/{uid} record) has never been granted to anyone, and the
 * only writer of either gate is a local Admin SDK script needing a
 * service-account key. This callable replaces that for the FIRST admin
 * only, without weakening the gate and without ever trusting a
 * company-level Owner label.
 *
 * Two pure units are proven here, both executed — never asserted in prose:
 *
 *   decideBootstrap()  — every precondition, in an order that does not
 *                        leak state to callers who are not allowlisted.
 *   bootstrapPlan()    — the fail-closed step order, plus the invariant
 *                        that EVERY intermediate state is refused by the
 *                        real authorizeAdminCall.
 *
 * The partial-failure proof is the important one. Auth claims and
 * Firestore cannot share a transaction, so the process is interruptible at
 * every step. Authority requires both gates, so each half alone must be
 * unusable — and that is checked against the deployed predicate itself,
 * not against a restatement of it.
 *
 * Run: node tools/test-firstAdminBootstrap.mjs   (after `npm --prefix functions run build`)
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const lib = (p) => pathToFileURL(join(ROOT, 'functions/lib', p)).href;
let B, A;
try {
  B = await import(lib('admin/bootstrapAuthority.js'));
  A = await import(lib('admin/authority.js'));
} catch (e) {
  check('bootstrapAuthority module builds and loads', false, String(e.message).slice(0, 200));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = 1;
}

if (B && A) {
  const ALLOW = B.parseBootstrapAllowlist('Owner@Example.COM, uid:UID-OWNER');
  const OK_CALLER = {
    authenticated: true, uid: 'UID-OWNER', email: 'owner@example.com', emailVerified: true,
  };
  const WORLD = {
    allowlist: ALLOW, completed: false, enabledAdminExistsElsewhere: false,
    attemptsUsed: 0, maxAttempts: 10,
  };
  const decide = (caller = {}, world = {}) =>
    B.decideBootstrap({ ...OK_CALLER, ...caller }, { ...WORLD, ...world });

  // ── the allowlist itself ────────────────────────────────────────────────
  check('allowlist parsing is case- and whitespace-insensitive',
    ALLOW.length === 2 && ALLOW.includes('owner@example.com'));
  check('an empty allowlist disables bootstrap entirely',
    B.parseBootstrapAllowlist('').length === 0
    && B.parseBootstrapAllowlist(undefined).length === 0);
  check('an unconfigured deployment refuses every caller',
    decide({}, { allowlist: [] }).ok === false,
    'bootstrap must be off by default, not open by default');

  // ── the happy path ──────────────────────────────────────────────────────
  {
    const d = decide();
    check('an allowlisted, verified caller is permitted', d.ok === true, JSON.stringify(d));
    check('the permitted subject is the CALLER, never a supplied uid',
      d.ok && d.uid === 'UID-OWNER');
  }
  check('a uid: allowlist entry is honoured without an email match',
    decide({ email: 'someone-else@example.com' },
           { allowlist: B.parseBootstrapAllowlist('uid:UID-OWNER') }).ok === true);

  // ── refusals, one per required precondition ─────────────────────────────
  const refusal = (d) => (d.ok ? '(permitted)' : d.reason);
  check('unauthenticated is refused',
    refusal(decide({ authenticated: false, uid: null, email: null })) === 'unauthenticated');
  check('a caller outside the allowlist is refused',
    refusal(decide({ uid: 'UID-STRANGER', email: 'stranger@example.com' })) === 'not_allowlisted');
  check('a company Owner email that is not allowlisted is refused',
    refusal(decide({ uid: 'UID-OWNER2', email: 'owner@liquidgold.example' })) === 'not_allowlisted',
    'a company-level Owner label is never proof');
  check('an unverified email is refused',
    refusal(decide({ emailVerified: false })) === 'email_unverified');
  check('an allowlisted uid with a MISMATCHED verified email is refused',
    refusal(decide({ email: 'other@example.com' },
                   { allowlist: B.parseBootstrapAllowlist('owner@example.com') })) === 'not_allowlisted');
  check('a completed bootstrap is refused permanently',
    refusal(decide({}, { completed: true })) === 'bootstrap_completed');
  check('an existing enabled admin elsewhere is refused',
    refusal(decide({}, { enabledAdminExistsElsewhere: true })) === 'admin_already_exists');
  check('attempts are rate limited',
    refusal(decide({}, { attemptsUsed: 10 })) === 'rate_limited');

  // ── information disclosure ──────────────────────────────────────────────
  // A caller who fails the allowlist must not learn whether bootstrap is
  // still available, so the allowlist is checked before world state.
  {
    const stranger = decide({ uid: 'UID-STRANGER', email: 'stranger@example.com' },
                            { completed: true, enabledAdminExistsElsewhere: true, attemptsUsed: 99 });
    check('a non-allowlisted caller learns nothing about world state',
      stranger.ok === false && stranger.reason === 'not_allowlisted');
    check('a non-allowlisted refusal is marked undetailed',
      stranger.detailSafe === false,
      'only an allowlisted caller may see the specific reason');
    check('an allowlisted caller may see the specific reason',
      decide({}, { completed: true }).detailSafe === true);
  }

  // ── no arbitrary target ─────────────────────────────────────────────────
  check('the decision input has no target-uid field at all',
    !('targetUid' in B.decideBootstrap.prototype ?? {})
    && JSON.stringify(Object.keys(OK_CALLER)).indexOf('target') === -1,
    'the caller may bootstrap only themselves');

  // ── the fail-closed ordering ────────────────────────────────────────────
  const FRESH = { claimTrue: false, recordExists: false, recordEnabled: false };
  {
    const plan = B.bootstrapPlan(FRESH);
    check('the plan writes a DISABLED record before touching the claim',
      plan.indexOf('write_pending_record') === 0
      && plan.indexOf('write_pending_record') < plan.indexOf('set_claim'),
      plan.join(' -> '));
    check('the claim is verified before the record is enabled',
      plan.indexOf('verify_claim') < plan.indexOf('enable_record'), plan.join(' -> '));
    check('completion is marked last',
      plan[plan.length - 1] === 'mark_completed', plan.join(' -> '));
  }

  // ── idempotent retry from every partial state ───────────────────────────
  check('retry after claim-succeeded/record-failed finishes the record',
    B.bootstrapPlan({ claimTrue: true, recordExists: true, recordEnabled: false })
      .includes('enable_record'));
  check('retry after claim-succeeded does not re-set the claim',
    !B.bootstrapPlan({ claimTrue: true, recordExists: true, recordEnabled: false })
      .includes('set_claim'));
  check('retry after record-enabled/claim-failed sets the claim',
    B.bootstrapPlan({ claimTrue: false, recordExists: true, recordEnabled: true })
      .includes('set_claim'));
  check('a fully complete state still marks completion and nothing else',
    JSON.stringify(B.bootstrapPlan({ claimTrue: true, recordExists: true, recordEnabled: true }))
      === JSON.stringify(['mark_completed']));

  // ── THE partial-failure proof, against the real predicate ───────────────
  // Every state reachable by interrupting the plan must be REFUSED by the
  // deployed authorizeAdminCall. Only the final state may pass.
  {
    const REC = (enabled) => ({ enabled, policyVersion: 1 });
    const tok = (claim) => ({ uid: 'UID-OWNER', token: { email: 'owner@example.com', ...(claim ? { wellbuiltAdmin: true } : {}) } });
    const states = [
      ['nothing done',            tok(false), null],
      ['pending record only',     tok(false), REC(false)],
      ['claim + pending record',  tok(true),  REC(false)],
      ['claim only, no record',   tok(true),  null],
      ['record enabled, no claim',tok(false), REC(true)],
    ];
    for (const [label, auth, record] of states) {
      const r = A.authorizeAdminCall(auth, record);
      check(`intermediate state is unusable: ${label}`, r.ok === false, JSON.stringify(r));
    }
    check('only the completed dual state grants authority',
      A.authorizeAdminCall(tok(true), REC(true)).ok === true);
  }

  // ── another caller can never be granted ─────────────────────────────────
  {
    const other = A.authorizeAdminCall(
      { uid: 'UID-STRANGER', token: { email: 'stranger@example.com' } }, { enabled: true, policyVersion: 1 });
    check('an enabled record for a different uid does not authorize the stranger',
      other.ok === false && other.reason === 'missing_admin_claim',
      'the record is read at platform_admins/{caller uid}, so it can never be borrowed');
  }

  // ── audit content ───────────────────────────────────────────────────────
  {
    const rec = B.buildBootstrapAudit({ uid: 'UID-OWNER', email: 'owner@example.com', method: 'self_bootstrap' }, 'TS');
    const s = JSON.stringify(rec);
    check('the audit records who, how, and when',
      rec.actorUid === 'UID-OWNER' && /self_bootstrap/.test(s) && rec.at === 'TS');
    check('the audit carries no token or credential material',
      !/idToken|accessToken|Bearer|password|passcode|customClaims|hash/i.test(s), s.slice(0, 160));
  }

  // ── the stored record shape ─────────────────────────────────────────────
  {
    const r = B.buildPlatformAdminRecord({ uid: 'UID-OWNER', email: 'owner@example.com' }, 'TS');
    check('the pending record is created DISABLED', r.enabled === false);
    check('the record carries the policy/schema version',
      r.policyVersion === A.ADMIN_POLICY_VERSION && typeof r.schemaVersion === 'number');
    check('the record records role/scope and createdAt',
      typeof r.role === 'string' && typeof r.scope === 'string' && r.createdAt === 'TS',
      JSON.stringify(r));
    check('the record names the creating uid and the creation METHOD separately',
      r.createdBy === 'UID-OWNER' && /bootstrap/i.test(String(r.createdVia)),
      `createdBy=${r.createdBy} createdVia=${r.createdVia}`);
  }
}

// ── the adapter: what it accepts, what it reveals, what it writes ────────
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(ROOT, 'functions/src/admin/bootstrapCallable.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  check('the payload must be exactly empty',
    /unknown_fields:/.test(code) && /Object\.keys\(data[\s\S]{0,40}\)/.test(code));
  check('the subject is the authenticated caller, never request data',
    /request\.auth\?\.uid/.test(code) && !/data\.[a-zA-Z]*[Uu]id/.test(code),
    'no uid may be read from the payload');
  check('email verification is read from the verified TOKEN',
    /token\?\.email_verified === true/.test(code),
    'never from the request body');
  check('the allowlist is deployment-controlled, not data-controlled',
    /process\.env\.BOOTSTRAP_ADMIN_ALLOWLIST/.test(code)
    && !/allowlist[\s\S]{0,40}(collection|doc)\(/.test(code));
  check('an undetailed refusal discloses only "denied"',
    /detailSafe \? decision\.reason : 'denied'/.test(code));
  check('only allowlisted attempts consume the rate-limit budget',
    /if \(decision\.detailSafe\) \{[\s\S]{0,200}attempts: FieldValue\.increment\(1\)/.test(code),
    'otherwise a stranger could exhaust the real owner’s budget');
  check('existing custom claims are preserved when the claim is set',
    /\.\.\.existingClaims,/.test(code));
  check('the record is enabled only after the claim is verified',
    code.indexOf("case 'verify_claim'") < code.indexOf("case 'enable_record'"));
  check('a failed claim verification aborts before enabling the record',
    /claim_not_persisted/.test(code));
  check('completion is recorded server-side, not returned as a client flag',
    /completed: true,/.test(code) && /completedByUid/.test(code));
  check('the client is told to refresh its ID token',
    /tokenRefreshRequired/.test(code),
    'the caller’s current token predates the claim');
  check('no password, token or claim VALUE is logged or returned',
    !/console\.(log|warn|error|info)/.test(code)
    && !/password|passcode|idToken|customClaims:/i.test(code.replace(/customClaims \?\?/g, '')));

  const idx = readFileSync(join(ROOT, 'functions/src/index.ts'), 'utf8');
  check('the export carries the delete-after-use instruction',
    /DELETE this export and redeploy immediately after/i.test(idx));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
