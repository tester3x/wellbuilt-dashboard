/**
 * Focused tests for the governed Dashboard pull-edit core (no firebase, no DOM).
 * Run: node --test --experimental-strip-types src/lib/pullEditCore.test.ts
 *
 * Covers the regression scenario and required cases: the edit targets the
 * original packet only, mints no new pull, is deterministic under double-submit,
 * and every failure class maps to a clear, sanitized operator message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildAdminPullEditRequest,
  describeEditError,
  invokeAdminPullEdit,
  ADMIN_PULL_EDIT_CALLABLE,
  type AdminPullEditRequest,
} from './pullEditCore.ts';

const readSibling = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const ORIG = '20260911_213623_Cyclone2_fbxyqp'; // the accepted original from the incident

test('successful edit: payload targets the original packet and mints NO new pull', () => {
  // Regression scenario: top 117in -> 104in, bbls stay 165, time unchanged.
  const req = buildAdminPullEditRequest(ORIG, 'Cyclone 2', 104, 165, undefined, false);
  assert.equal(req.originalPacketId, ORIG);       // addressed only by original id
  assert.equal(req.wellName, 'Cyclone 2');
  assert.equal(req.tankTopInches, 104);
  assert.equal(req.bblsTaken, 165);
  assert.equal(req.wellDown, false);
  assert.ok(!('newDateTimeUTC' in req));          // time unchanged -> omitted
  // No new-pull / client-minted fields may ever be present:
  for (const forbidden of ['packetId', 'requestType', 'timestamp', 'source', 'dateTimeUTC']) {
    assert.ok(!(forbidden in req), `payload must not contain ${forbidden}`);
  }
});

test('operational timestamp preserved as-is when unchanged (no time key sent)', () => {
  const req = buildAdminPullEditRequest(ORIG, 'Cyclone 2', 104, 165, undefined, false);
  assert.equal(req.newDateTimeUTC, undefined);
});

test('changed time is forwarded verbatim under newDateTimeUTC', () => {
  const req = buildAdminPullEditRequest(ORIG, 'Cyclone 2', 104, 165, '2026-09-12T02:26:00.000Z', false);
  assert.equal(req.newDateTimeUTC, '2026-09-12T02:26:00.000Z');
});

test('double-submit / retry is deterministic: identical inputs -> identical request, same original target', () => {
  const a = buildAdminPullEditRequest(ORIG, 'Cyclone 2', 104, 165, undefined, false);
  const b = buildAdminPullEditRequest(ORIG, 'Cyclone 2', 104, 165, undefined, false);
  assert.deepEqual(a, b);                          // no time-based / random id -> idempotent target
  assert.equal(a.originalPacketId, b.originalPacketId);
});

test('wellDown authority: only explicit true sets it', () => {
  assert.equal(buildAdminPullEditRequest(ORIG, 'W', 1, 1, undefined, true).wellDown, true);
  assert.equal(buildAdminPullEditRequest(ORIG, 'W', 1, 1, undefined, undefined).wellDown, false);
});

// ── error mapping (validation / auth / callable / network) ───────────────────

test('validation failures map to specific, sanitized guidance', () => {
  assert.match(describeEditError({ code: 'invalid-argument', message: 'tankTopInches_invalid' }), /tank level/i);
  assert.match(describeEditError({ code: 'invalid-argument', message: 'bblsTaken_invalid' }), /barrels/i);
  assert.match(describeEditError({ code: 'invalid-argument', message: 'newDateTimeUTC_invalid' }), /date\/time/i);
  assert.match(describeEditError({ code: 'invalid-argument', message: 'originalPacketId_required' }), /identified|refresh/i);
});

test('prefixed transport message ("code: reason") still resolves the reason', () => {
  assert.match(describeEditError({ code: 'invalid-argument', message: 'invalid-argument: bblsTaken_invalid' }), /barrels/i);
});

test('auth / permission failures map to permission guidance', () => {
  assert.match(describeEditError({ code: 'unauthenticated', message: 'x' }), /session expired/i);
  assert.match(describeEditError({ code: 'permission-denied', message: 'well_outside_company' }), /permission/i);
  assert.match(describeEditError({ code: 'permission-denied', message: 'manageDrivers_required' }), /permission/i);
});

test('network / service failures state the pull was NOT changed', () => {
  for (const code of ['unavailable', 'internal', 'deadline-exceeded']) {
    const msg = describeEditError({ code, message: 'boom' });
    assert.match(msg, /NOT changed/i);
  }
});

test('unknown error never leaks raw text and states no change occurred', () => {
  const msg = describeEditError(new Error('TypeError: undefined is not a function at line 42'));
  assert.ok(!msg.includes('undefined is not a function'));
  assert.match(msg, /NOT changed/i);
});

test('null / undefined error is handled safely', () => {
  assert.match(describeEditError(undefined), /NOT changed/i);
  assert.match(describeEditError(null), /NOT changed/i);
});

// ── client invocation boundary (spy over the injectable callable) ────────────

test('invokes the callable EXACTLY ONCE, named adminSubmitPullEdit, with the original packet id', async () => {
  const calls: Array<{ name: string; data: AdminPullEditRequest }> = [];
  const spy = async (name: string, data: AdminPullEditRequest) => {
    calls.push({ name, data });
    return { data: { ok: true as const, packetId: 'edit_server_minted_Cyclone2' } };
  };
  const req = buildAdminPullEditRequest('20260911_213623_Cyclone2_fbxyqp', 'Cyclone 2', 104, 165, undefined, false);
  const res = await invokeAdminPullEdit(spy, req);

  assert.equal(calls.length, 1);                                  // exactly one invocation
  assert.equal(calls[0].name, 'adminSubmitPullEdit');            // correct callable
  assert.equal(calls[0].name, ADMIN_PULL_EDIT_CALLABLE);
  assert.equal(calls[0].data.originalPacketId, '20260911_213623_Cyclone2_fbxyqp'); // immutable target
  assert.deepEqual(res, { ok: true, packetId: 'edit_server_minted_Cyclone2' });    // returns server data
});

test('callable rejection propagates (so the caller can keep the modal open and show it)', async () => {
  const spy = async () => { throw { code: 'permission-denied', message: 'well_outside_company' }; };
  const req = buildAdminPullEditRequest('P', 'W', 1, 1);
  await assert.rejects(() => invokeAdminPullEdit(spy, req));
});

// ── source guards: the legacy direct-write path is gone and the UI fails safe ─

test('SOURCE: no client write to packets/incoming remains in the edit path', () => {
  const wells = readSibling('./wells.ts');
  const pullEdit = readSibling('./pullEdit.ts');
  // The legacy bug wrote set(ref(db, `packets/incoming/${editPacketId}`), ...).
  assert.ok(!/packets\/incoming\/\$\{editPacketId\}/.test(wells), 'wells.ts must not write packets/incoming');
  assert.ok(!/export\s+async\s+function\s+editPull/.test(wells), 'legacy editPull must be removed from wells.ts');
  // pullEdit.ts may mention packets/incoming in its docstring, but must never
  // WRITE it (no set(ref(...)) / no `packets/incoming/${...}` path build).
  assert.ok(!/set\s*\(\s*ref\s*\(/.test(pullEdit), 'pullEdit.ts must not call set(ref(...))');
  assert.ok(!/packets\/incoming\/\$\{/.test(pullEdit), 'pullEdit.ts must not build a packets/incoming write path');
  // The governed path must go through the callable.
  assert.ok(/adminSubmitPullEdit|invokeAdminPullEdit/.test(pullEdit), 'pullEdit.ts must use the governed callable');
});

test('SOURCE: a failed edit stays visible in the modal and cannot double-submit', () => {
  const page = readSibling('../app/well/page.tsx');
  // editPull now comes from the governed module, not wells.ts.
  assert.ok(/from '@\/lib\/pullEdit'/.test(page), 'page must import editPull from the governed module');
  // Failure path sets the in-modal error (not only a page-level banner) …
  assert.ok(/setEditError\(describeEditError\(err\)\)/.test(page), 'catch must set the in-modal error');
  // … and an editError banner is rendered inside the modal.
  assert.ok(/\{editError && \(/.test(page), 'modal must render the editError banner');
  // Double-click guard: ignore re-entry while a submit is in flight.
  assert.ok(/if \(editSubmitting\) return;/.test(page), 'submitEdit must guard against double submit');
  // On failure the modal is NOT closed (no setEditingPull(null) in the catch block).
  const catchBlock = page.slice(page.indexOf('} catch (err) {'), page.indexOf('} finally {'));
  assert.ok(!/setEditingPull\(null\)/.test(catchBlock), 'a failed edit must not close the modal');
});
