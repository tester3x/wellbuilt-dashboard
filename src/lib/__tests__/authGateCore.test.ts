import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

test('source contract: all capability-gated redirect pages gate on authResolved', () => {
  const pages = [
    '../../app/equipment/page.tsx',
    '../../app/photo-review/page.tsx',
    '../../app/settings/page.tsx',
    '../../app/admin/diagnostics/page.tsx',
    '../../app/admin/truth-debug/page.tsx',
    '../../app/admin/truth-rag-exports/page.tsx',
  ];

  for (const p of pages) {
    const filePath = fileURLToPath(new URL(p, import.meta.url));
    const content = readFileSync(filePath, 'utf8');
    assert.match(content, /authResolved/, `${p} must import and use authResolved`);
    assert.match(content, /if \(!authResolved\) return;/, `${p} must wait for authResolved before redirecting`);
  }
});

