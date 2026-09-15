import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAuthGate, computeAuthResolved } from '../authGateCore.ts';

test('while unresolved the gate WAITS — never redirects home during hydration', () => {
  // The root-cause guard: even with no user and no access, an unresolved gate waits.
  assert.equal(resolveAuthGate({ authResolved: false, hasUser: false }), 'wait');
  assert.equal(resolveAuthGate({ authResolved: false, hasUser: true, hasAccess: false }), 'wait');
  assert.equal(resolveAuthGate({ authResolved: false, hasUser: true, hasAccess: true }), 'wait');
});

test('resolved decisions: login / home / allow', () => {
  assert.equal(resolveAuthGate({ authResolved: true, hasUser: false }), 'login');
  assert.equal(resolveAuthGate({ authResolved: true, hasUser: true, hasAccess: false }), 'home');
  assert.equal(resolveAuthGate({ authResolved: true, hasUser: true, hasAccess: true }), 'allow');
  // no capability gate beyond sign-in → allow
  assert.equal(resolveAuthGate({ authResolved: true, hasUser: true }), 'allow');
});

test('computeAuthResolved requires BOTH auth and company hydration to settle', () => {
  assert.equal(computeAuthResolved({ loading: true, companyLoading: true }), false);
  assert.equal(computeAuthResolved({ loading: true, companyLoading: false }), false);
  assert.equal(computeAuthResolved({ loading: false, companyLoading: true }), false); // the race window
  assert.equal(computeAuthResolved({ loading: false, companyLoading: false }), true);
});
