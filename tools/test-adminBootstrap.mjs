/**
 * vc51.9A6-C — dual-gate bootstrap fail-closed lifecycle matrix.
 *
 * Drives tools/lib/adminBootstrapCore.mjs with fake injected deps (op
 * log + fault injection), judges every intermediate state with the REAL
 * authorizeAdminCall, exercises the executable's refusal paths by
 * spawning it, and pins that the executable actually invokes the tested
 * core rather than merely documenting it.
 *
 * Run: node --experimental-strip-types tools/test-adminBootstrap.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorizeAdminCall } from '../functions/src/admin/authority.ts';
import { CLAIM, POLICY_VERSION, runDisable, runEnable } from './lib/adminBootstrapCore.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};
const UID = 'uid-bootstrap-test';

function makeFake({ claims = {}, record = null, failSetClaims = false, silentClaimWrite = false, failEnableRecord = false } = {}) {
  const state = { claims: { ...claims }, record: record ? { ...record } : null };
  const ops = [];
  const deps = {
    async getClaims() { ops.push('getClaims'); return { ...state.claims }; },
    async setClaims(_u, c) {
      ops.push('setClaims');
      if (failSetClaims) throw new Error('auth-write-denied');
      if (!silentClaimWrite) state.claims = { ...c };
    },
    async getRecord() { ops.push('getRecord'); return state.record ? { ...state.record } : null; },
    async setRecord(_u, fields) {
      ops.push(`setRecord:${String(fields.enabled)}`);
      if (failEnableRecord && fields.enabled === true) throw new Error('firestore-write-denied');
      state.record = { ...(state.record ?? {}), ...fields };
    },
    async revokeTokens() { ops.push('revokeTokens'); },
    serverTimestamp: () => '<ts>',
    authorize: authorizeAdminCall,
    log: () => {},
  };
  return { deps, state, ops };
}
const writes = (ops) => ops.filter((o) => o.startsWith('setRecord') || o === 'setClaims' || o === 'revokeTokens');
const decide = (state) => authorizeAdminCall({ uid: UID, token: state.claims }, state.record);

// ── dry-run performs ZERO writes ──────────────────────────────────────────
{
  const { deps, ops } = makeFake();
  const r = await runEnable(deps, UID, { confirm: false });
  check('enable dry-run performs zero writes', r.state === 'dry-run' && writes(ops).length === 0);
}
{
  const { deps, ops } = makeFake({ claims: { [CLAIM]: true }, record: { enabled: true, policyVersion: 1 } });
  const r = await runDisable(deps, UID, { confirm: false });
  check('disable dry-run performs zero writes', r.state === 'dry-run' && writes(ops).length === 0);
}

// ── executable refusal paths (spawned; no credentials in env) ─────────────
const runScript = (argv, env = {}) => {
  try {
    execFileSync(process.execPath, ['tools/bootstrap-admin-claim.mjs', ...argv], {
      cwd: root, env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: '', ...env }, stdio: 'pipe',
    });
    return { code: 0, err: '' };
  } catch (e) {
    return { code: e.status, err: String(e.stderr) };
  }
};
{
  const r = runScript(['--uid', 'mike@wellbuilt.app', '--confirm']);
  check('email rejected', r.code === 1 && r.err.includes('email'));
}
{
  const r = runScript(['--uid', 'uid-1,uid-2', '--confirm']);
  check('batch rejected', r.code === 1 && r.err.includes('batch/wildcard'));
}
{
  const r = runScript(['--uid', 'uid-*', '--confirm']);
  check('wildcard rejected', r.code === 1 && r.err.includes('batch/wildcard'));
}
{
  const r = runScript(['--uid', 'uid-valid-1', '--confirm']);
  check('missing credentials rejected before any mutation',
    r.code === 1 && r.err.includes('GOOGLE_APPLICATION_CREDENTIALS'));
}
{
  const r = runScript(['--uid', 'uid-valid-1', '--revoke-tokens', '--confirm']);
  check('--revoke-tokens without --disable rejected', r.code === 1 && r.err.includes('revoke-tokens'));
}

// ── intermediate states always deny (real authority decision) ─────────────
check('pending record alone denies',
  !authorizeAdminCall({ uid: UID, token: {} }, { enabled: false, policyVersion: 1 }).ok);
check('claim alone denies',
  !authorizeAdminCall({ uid: UID, token: { [CLAIM]: true } }, null).ok);
check('pending record + claim still denies',
  !authorizeAdminCall({ uid: UID, token: { [CLAIM]: true } }, { enabled: false, policyVersion: 1 }).ok);

// ── full enable succeeds, ordered, both gates verified ────────────────────
{
  const { deps, state, ops } = makeFake({ claims: { beta: true } });
  const r = await runEnable(deps, UID, { confirm: true });
  check('enabled record + verified claim allows', r.ok && r.state === 'enabled' && decide(state).ok);
  check('enable order: pending record → claim → enable record',
    ops.indexOf('setRecord:false') < ops.indexOf('setClaims')
    && ops.indexOf('setClaims') < ops.indexOf('setRecord:true'));
  check('unrelated claims preserved through enable', state.claims.beta === true);
}

// ── enable failure modes stay denied with actionable state ────────────────
{
  const { deps, state } = makeFake({ failSetClaims: true });
  const r = await runEnable(deps, UID, { confirm: true });
  check('failure setting claim leaves pending/disabled record (denied)',
    !r.ok && r.state === 'claim-set-failed-record-disabled'
    && state.record.enabled === false && !decide(state).ok);
}
{
  const { deps, state } = makeFake({ silentClaimWrite: true });
  const r = await runEnable(deps, UID, { confirm: true });
  check('failure verifying claim cannot enable record (denied)',
    !r.ok && r.state === 'claim-verify-failed-record-disabled'
    && state.record.enabled === false && !decide(state).ok);
}
{
  const { deps, state } = makeFake({ failEnableRecord: true });
  const r = await runEnable(deps, UID, { confirm: true });
  check('failure enabling record leaves access denied (claim set, record disabled)',
    !r.ok && r.state === 'record-enable-failed-still-denied'
    && state.claims[CLAIM] === true && state.record.enabled === false && !decide(state).ok);
}
{
  // Rerun after the record-enable failure: enable completes idempotently.
  const { deps, state } = makeFake({ claims: { [CLAIM]: true }, record: { enabled: false, policyVersion: 1 } });
  const r = await runEnable(deps, UID, { confirm: true });
  check('enable rerun after partial failure completes', r.ok && decide(state).ok);
}
{
  const { deps, ops } = makeFake({ claims: { [CLAIM]: true }, record: { enabled: true, policyVersion: 1 } });
  const r = await runEnable(deps, UID, { confirm: true });
  check('enable rerun on fully-enabled state is a safe no-op',
    r.ok && r.state === 'already-enabled' && writes(ops).length === 0);
}
{
  const { deps, ops } = makeFake({ record: { enabled: false, policyVersion: 99 } });
  const r = await runEnable(deps, UID, { confirm: true });
  check('unsupported admin policy version fails closed before any write',
    !r.ok && r.state === 'unsupported-policy-version' && writes(ops).length === 0);
}

// ── disable lifecycle ─────────────────────────────────────────────────────
{
  const { deps, state, ops } = makeFake({ claims: { [CLAIM]: true, beta: true }, record: { enabled: true, policyVersion: 1 } });
  const r = await runDisable(deps, UID, { confirm: true });
  check('disable succeeds: claim gone, record disabled, denied',
    r.ok && r.state === 'disabled' && state.claims[CLAIM] === undefined
    && state.record.enabled === false && !decide(state).ok);
  check('disable order: record disabled BEFORE claim removal (immediate denial)',
    ops.indexOf('setRecord:false') < ops.indexOf('setClaims'));
  check('unrelated claims preserved through disable', state.claims.beta === true);
  check('token revocation NOT performed without explicit flag', !ops.includes('revokeTokens'));
}
{
  const { deps, ops } = makeFake({ claims: { [CLAIM]: true }, record: { enabled: true, policyVersion: 1 } });
  const r = await runDisable(deps, UID, { confirm: true, revokeTokens: true });
  check('token revocation only with explicit flag',
    r.ok && ops.filter((o) => o === 'revokeTokens').length === 1);
}
{
  const { deps, state } = makeFake({ claims: { [CLAIM]: true }, record: { enabled: true, policyVersion: 1 }, failSetClaims: true });
  const r = await runDisable(deps, UID, { confirm: true });
  check('claim-removal failure remains denied through the disabled record',
    !r.ok && r.state === 'claim-removal-failed-still-denied'
    && state.claims[CLAIM] === true && state.record.enabled === false && !decide(state).ok);
}
{
  const { deps, ops } = makeFake({ record: { enabled: false, policyVersion: 1 } });
  const r = await runDisable(deps, UID, { confirm: true });
  check('disable rerun is a safe no-op',
    r.ok && r.state === 'already-disabled' && writes(ops).length === 0);
}

// ── pin: the executable invokes the tested sequence ───────────────────────
{
  const src = readFileSync(join(root, 'tools/bootstrap-admin-claim.mjs'), 'utf8');
  check('executable imports the tested core',
    src.includes("from './lib/adminBootstrapCore.mjs'"));
  check('executable invokes runEnable and runDisable',
    /runEnable\(deps, uid/.test(src) && /runDisable\(deps, uid/.test(src));
  check('executable wires the REAL authorizeAdminCall as the verifier',
    src.includes('authorize: authorizeAdminCall'));
  check('credentials are demanded BEFORE the Admin SDK loads',
    src.indexOf('GOOGLE_APPLICATION_CREDENTIALS') < src.indexOf("import('firebase-admin/app')"));
  check('no embedded credentials in the executable',
    !/private_key|BEGIN PRIVATE KEY|apiKey/.test(src));
  check('policy version pinned to the authority module', POLICY_VERSION === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
