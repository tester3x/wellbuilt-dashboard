import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../../app/dispatch/page.tsx', import.meta.url), 'utf8');
const paneSrc = readFileSync(new URL('../../components/DetachablePane.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

// Both detachable panes (Well Queue and Active Jobs) share the SAME pop-out /
// reattach mechanism, and the Active Jobs pop-out must render exactly once, own its
// own scroll, and always expose a working Reattach — the defects Mike hit.

test('both panes use the shared DetachablePane with a reattach (onDock -> dock*(false)) wire', () => {
  assert.match(page, /<DetachablePane\s+detached=\{queueDetached\}\s+onDock=\{\(\) => dockQueue\(false\)\}\s+title="Well Queue"/);
  assert.match(page, /<DetachablePane\s+detached=\{jobsDetached\}\s+onDock=\{\(\) => dockJobs\(false\)\}\s+title="Active Jobs"/);
});

test('both panes expose a Pop-Out/Reattach toggle button wired to dock*(!detached)', () => {
  assert.match(page, /onClick=\{\(\) => dockQueue\(!queueDetached\)\}/);
  assert.match(page, /onClick=\{\(\) => dockJobs\(!jobsDetached\)\}/);
  assert.match(page, /\{queueDetached \? '⧉ Reattach' : '⧉ Pop Out'\}/);
  assert.match(page, /\{jobsDetached \? '⧉ Reattach' : '⧉ Pop Out'\}/);
});

test('REGRESSION: Reattach is always visible when detached (both panes) and never hidden in the pop-out', () => {
  assert.match(page, /\$\{queueDetached \? 'inline-flex' : 'hidden xl:inline-flex'\}/);
  assert.match(page, /\$\{jobsDetached \? 'inline-flex' : 'hidden xl:inline-flex'\}/);
  // Old broken form (hard-coded hidden) must not return.
  assert.doesNotMatch(page, /className="hidden xl:inline-flex items-center gap-1 px-2 py-1 text-\[11px\] font-medium rounded text-gray-300 bg-gray-900 border border-gray-700 hover:bg-gray-700 flex-shrink-0"/);
});

test('REGRESSION: the Active Jobs header wraps so controls (incl. Reattach) never get pushed off at narrow widths', () => {
  assert.match(page, /\{\/\* Panel header with tabs[\s\S]*?<div className="flex flex-wrap items-center justify-between gap-y-1 px-4 py-2\.5 border-b border-gray-700 flex-shrink-0">/);
});

test('the Active Jobs pop-out opens at ~1100x800 (centered/clamped by the component)', () => {
  assert.match(page, /title="Active Jobs"[\s\S]*?width=\{1100\}[\s\S]*?height=\{800\}/);
});

test('REGRESSION: exactly ONE live mount — the child body is cleared and a single marked mount is appended (no stale duplicate)', () => {
  assert.match(paneSrc, /child\.document\.body\.replaceChildren\(\);/);
  assert.match(paneSrc, /setAttribute\('data-wb-detached-mount', '1'\)/);
  // A window ref is reused rather than spawning a second window that could double-mount.
  assert.match(paneSrc, /const winRef = useRef<Window \| null>\(null\)/);
  assert.match(paneSrc, /winRef\.current && !winRef\.current\.closed \? winRef\.current : null/);
});

test('REGRESSION: the inner pane body is the SOLE scroll owner (no phantom document scroll)', () => {
  // Child document + body pinned to the window box with overflow hidden.
  assert.match(paneSrc, /html\.style\.overflow = 'hidden'/);
  assert.match(paneSrc, /child\.document\.body\.style\.overflow = 'hidden'/);
  assert.match(paneSrc, /child\.document\.body\.style\.height = '100%'/);
  // The pane clips; its inner body scrolls.
  assert.match(css, /\.detached-pane\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.detached-pane-jobs \.dispatch-jobs-body\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.detached-pane-queue \.dispatch-queue-body\s*\{[^}]*overflow-y:\s*auto/);
});

test('reattach lifecycle is clean: state cleared, window closed, opener refocused, listeners removed', () => {
  // dock*(false) clears the detached flag (and its persisted preference).
  assert.match(page, /const dockJobs = useCallback\(\(v: boolean\) => \{\s*setJobsDetached\(v\);\s*try \{ localStorage\.setItem\('wb\.dispatch\.jobsDetached', v \? '1' : '0'\);/);
  assert.match(page, /const dockQueue = useCallback\(\(v: boolean\) => \{\s*setQueueDetached\(v\);\s*try \{ localStorage\.setItem\('wb\.dispatch\.queueDetached', v \? '1' : '0'\);/);
  // Component cleanup: stop poll, drop listener, release container + window ref,
  // close the window, refocus the opener (main dashboard).
  assert.match(paneSrc, /window\.clearInterval\(poll\)/);
  assert.match(paneSrc, /removeEventListener\('pagehide', reattach\)/);
  assert.match(paneSrc, /setContainer\(null\)/);
  assert.match(paneSrc, /winRef\.current = null/);
  assert.match(paneSrc, /child\.close\(\)/);
  assert.match(paneSrc, /opener\?\.focus\?\.\(\)/);
  // Single subtree: docked returns children, detached PORTALS the same children.
  assert.match(paneSrc, /if \(!detached\) return <>\{children\}<\/>;/);
  assert.match(paneSrc, /createPortal\(children, container\)/);
});

test('the pop-out is centered and clamped to the available screen (survives narrow/short)', () => {
  assert.match(paneSrc, /function centeredFeatures/);
  assert.match(paneSrc, /Math\.min\(reqW, availW\)/);
  assert.match(paneSrc, /Math\.min\(reqH, availH\)/);
  assert.match(paneSrc, /left=\$\{left\},top=\$\{top\}/);
});
