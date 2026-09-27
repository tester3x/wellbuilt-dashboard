// Source-contract tests for the Dashboard UX checkpoint (parts 5/6/7):
// canonical queue→WB-M links + control propagation, detach reflow (no placeholder,
// Reattach in the portaled header, no duplicate), and URL reload restoration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dispatch = read('../../app/dispatch/page.tsx');
const wellPage = read('../../app/well/page.tsx');
const pool = read('../../lib/wellPoolCore.ts');
const css = read('../../app/globals.css');
const pane = read('../../components/DetachablePane.tsx');

test('part 5: client pool carries canonical identity (companyId + ndicApiNo)', () => {
  assert.match(pool, /ndicApiNo\?: string/, 'WellResponse declares ndicApiNo');
  assert.match(pool, /companyId\?: string/, 'WellResponse declares companyId');
  assert.match(pool, /ndicApiNo: typeof config\.ndicApiNo/, 'catalog carries ndicApiNo through');
  assert.match(pool, /companyId: typeof config\.companyId/, 'catalog carries companyId through');
});

test('part 5: queue row links to the canonical WB-M page and fails closed', () => {
  assert.match(dispatch, /import \{ wellDetailHref \} from '@\/lib\/wellDetailLink'/);
  assert.match(dispatch, /const wbmHref = wellDetailHref\(well\)/, 'row computes canonical href');
  assert.match(dispatch, /onClick=\{wbmHref \? \(\) => router\.push\(wbmHref\) : undefined\}/, 'row navigates only when canonical');
  assert.match(dispatch, /Open in WB-M unavailable/, 'no-canonical-identity shows unavailable, no fuzzy fallback');
});

test('part 5: control cell stops navigation propagation', () => {
  assert.match(dispatch, /text-right" onClick=\{\(e\) => e\.stopPropagation\(\)\}/, 'action cell stops row navigation');
});

test('part 5: /well resolves by canonical identity, exact match, no name fallback', () => {
  assert.match(wellPage, /const isCanonical = !!\(companyParam && apiParam\)/);
  assert.match(wellPage, /w\.companyId \|\| ''\)\.trim\(\) === companyParam && \(w\.ndicApiNo \|\| ''\)\.trim\(\) === apiParam/, 'exact canonical match');
  assert.match(wellPage, /canonicalUnavailable/, 'canonical-not-found renders unavailable');
});

test('part 6: detach reflow — no docked placeholder, wrappers hide, grid drops the area', () => {
  assert.ok(!/Well Queue is in its own window/.test(dispatch), 'queue docked placeholder card removed');
  assert.ok(!/Active Jobs is in its own window/.test(dispatch), 'jobs docked placeholder card removed');
  assert.match(dispatch, /is-queue-detached/, 'workspace flags queue-detached');
  assert.match(dispatch, /is-jobs-detached/, 'workspace flags jobs-detached');
  assert.match(dispatch, /dispatch-queue.*\$\{queueDetached \? ' is-detached'/, 'queue wrapper hides when detached');
  assert.match(css, /\.dispatch-queue\.is-detached,\s*\n\s*\.dispatch-pane-jobs\.is-detached \{\s*\n\s*display: none/, 'detached wrapper occupies no space');
  assert.match(css, /\.dispatch-workspace\.is-queue-detached \{[\s\S]*?grid-template-areas:\s*"builder"\s*"jobs"/, 'grid drops queue area');
});

test('part 6: Reattach lives in the portaled header; named window prevents duplicates', () => {
  // The header (with the Pop Out/Reattach toggle) is inside DetachablePane children,
  // so it is portaled into the detached window.
  assert.match(dispatch, /queueDetached \? '⧉ Reattach' : '⧉ Pop Out'/, 'reattach toggle in the queue header');
  assert.match(pane, /window\.open\('', `wb_\$\{title\.replace/, 'named target window — reused, not duplicated');
  assert.match(pane, /if \(!child \|\| child\.closed\) onDock\(\)/, 'closing the window reattaches (no strand/duplicate)');
  // Hardened: the child body is cleared before the single marked mount is appended,
  // so a reused window can never strand a second, orphaned copy of the subtree.
  assert.match(pane, /child\.document\.body\.replaceChildren\(\);/, 'child body cleared → exactly one mount');
  assert.match(pane, /data-wb-detached-mount/, 'single marked mount node');
});

test('part 7: reload restoration — URL init + persist, gated on auth', () => {
  assert.match(dispatch, /readInitialParam\('q'\)/, 'search restored from URL');
  assert.match(dispatch, /readInitialParam\('route'\)/, 'route filter restored from URL');
  assert.match(dispatch, /readInitialParam\('view'\)/, 'queue view restored from URL');
  assert.match(dispatch, /window\.history\.replaceState\(window\.history\.state, '',/, 'persists without navigation');
  assert.match(dispatch, /if \(loading \|\| !user \|\| typeof window === 'undefined'\) return;/, 'persist waits for auth (no timing hack)');
  assert.match(dispatch, /if \(!loading && !user\) \{\s*\n\s*router\.push\('\/login'\)/, 'default redirect waits for auth resolution');
});
