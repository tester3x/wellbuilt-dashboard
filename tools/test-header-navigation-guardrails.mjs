import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);

const EXPECTED_TABS = [
  { id: 'home', label: 'Home', href: '/' },
  { id: 'mobile', label: 'WB Mobile', href: '/mobile' },
  { id: 'tickets', label: 'WB Tickets', href: '/tickets' },
  { id: 'dispatch', label: 'Dispatch', href: '/dispatch' },
  { id: 'billing', label: 'WB Billing', href: '/billing' },
  { id: 'payroll', label: 'WB Payroll', href: '/payroll' },
  { id: 'driverlogs', label: 'Driver Logs', href: '/driverlogs' },
  { id: 'equipment', label: 'eQuipment', href: '/equipment' },
  { id: 'safety', label: 'Safety', href: '/safety' },
  { id: 'settings', label: 'Settings', href: '/settings' },
];

function transpileAndLoad(filePath, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(filePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const result = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (id) => (id in dependencies ? dependencies[id] : require(id)),
    result,
    result.exports,
  );
  return result.exports;
}

export function validateTabs(actualTabs) {
  if (!Array.isArray(actualTabs)) {
    throw new Error('FAIL: TABS export in src/lib/tabs.ts is not an array.');
  }

  if (actualTabs.length !== EXPECTED_TABS.length) {
    throw new Error(
      `FAIL: Primary navigation tabs count mismatch. Expected ${EXPECTED_TABS.length}, got ${actualTabs.length}. Exposed tabs: ${actualTabs.map((t) => t.id).join(', ')}`,
    );
  }

  for (let i = 0; i < EXPECTED_TABS.length; i++) {
    const exp = EXPECTED_TABS[i];
    const act = actualTabs[i];
    if (act.id !== exp.id || act.label !== exp.label || act.href !== exp.href) {
      throw new Error(
        `FAIL: Tab mismatch at position ${i}. Expected [${exp.id}: "${exp.label}" -> ${exp.href}], got [${act.id}: "${act.label}" -> ${act.href}]`,
      );
    }
  }

  const hasPhotoReviewInNav = actualTabs.some(
    (t) => t.id === 'photo-review' || t.label.toLowerCase().includes('photo'),
  );
  if (hasPhotoReviewInNav) {
    throw new Error('FAIL: Photo Review is forbidden from appearing in primary navigation.');
  }
}

export function validateHeaderSource(headerSource) {
  if (headerSource.includes('grid-cols-[auto_1fr_auto]')) {
    throw new Error('FAIL: Regressed legacy 3-column header pattern detected in AppHeader.tsx.');
  }

  if (!headerSource.includes('order-2 w-full min-w-0 flex flex-wrap justify-center items-center gap-2')) {
    throw new Error('FAIL: Compact centered tool wrapper missing from AppHeader.tsx.');
  }

  if (!headerSource.includes('order-3 flex w-full min-w-0 flex-wrap justify-center')) {
    throw new Error('FAIL: Compact centered navigation wrapper missing from AppHeader.tsx.');
  }
}

export function runNegativeUnitTests() {
  console.log('--- Running Negative Guardrail Verifications ---');

  // Test 1: Photo Review in primary navigation must fail
  let threw = false;
  try {
    validateTabs([...EXPECTED_TABS, { id: 'photo-review', label: 'Photo Review', href: '/photo-review' }]);
  } catch (err) {
    threw = true;
    if (!err.message.includes('Primary navigation tabs count mismatch') && !err.message.includes('Photo Review is forbidden')) {
      throw new Error(`Unexpected error message: ${err.message}`);
    }
  }
  if (!threw) throw new Error('FAIL: Negative test 1 (Photo Review in nav) did not throw!');
  console.log('  ✓ Negative Test 1 Passed: Photo Review tab insertion was caught and rejected.');

  // Test 2: Wrong tab ordering must fail
  threw = false;
  try {
    const swapped = [...EXPECTED_TABS];
    swapped[0] = EXPECTED_TABS[1];
    swapped[1] = EXPECTED_TABS[0];
    validateTabs(swapped);
  } catch (err) {
    threw = true;
    if (!err.message.includes('Tab mismatch at position 0')) {
      throw new Error(`Unexpected error message: ${err.message}`);
    }
  }
  if (!threw) throw new Error('FAIL: Negative test 2 (wrong tab order) did not throw!');
  console.log('  ✓ Negative Test 2 Passed: Wrong tab ordering was caught and rejected.');

  // Test 3: Unexpected / extraneous tabs must fail
  threw = false;
  try {
    validateTabs([...EXPECTED_TABS, { id: 'billing-admin', label: 'Billing Admin', href: '/billing-admin' }]);
  } catch (err) {
    threw = true;
    if (!err.message.includes('Primary navigation tabs count mismatch')) {
      throw new Error(`Unexpected error message: ${err.message}`);
    }
  }
  if (!threw) throw new Error('FAIL: Negative test 3 (extra tab) did not throw!');
  console.log('  ✓ Negative Test 3 Passed: Unexpected primary navigation entry was caught and rejected.');

  // Test 4: Legacy 3-column header pattern must fail
  threw = false;
  try {
    validateHeaderSource('<header><div className="w-full grid grid-cols-[auto_1fr_auto] items-start"></div></header>');
  } catch (err) {
    threw = true;
    if (!err.message.includes('Regressed legacy 3-column header pattern detected')) {
      throw new Error(`Unexpected error message: ${err.message}`);
    }
  }
  if (!threw) throw new Error('FAIL: Negative test 4 (legacy 3-column header) did not throw!');
  console.log('  ✓ Negative Test 4 Passed: Legacy 3-column grid in AppHeader was caught and rejected.');
}

export async function runHeaderNavigationGuardrails() {
  console.log('=== Running Header & Navigation Mechanical Guardrail Tests ===');

  // Step A: Run negative tests proving that every regression condition is caught
  runNegativeUnitTests();

  // Step B: Static tab configuration verification
  const tabsModule = transpileAndLoad('src/lib/tabs.ts');
  validateTabs(tabsModule.TABS);
  console.log('✓ Tab count (10), ordering, labels, and Photo Review absence strictly verified.');

  // Step C: Source AST / layout contract inspection
  const headerSource = fs.readFileSync('src/components/AppHeader.tsx', 'utf8');
  validateHeaderSource(headerSource);
  console.log('✓ AppHeader source verified: legacy 3-column grid absent; compact centered wrappers present.');

  // Step D: Playwright Headless Layout Proof across viewports
  const { AppHeader } = transpileAndLoad('src/components/AppHeader.tsx', {
    'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
    'next/navigation': { usePathname: () => '/dispatch', useRouter: () => ({}) },
    'firebase/database': {},
    '@/contexts/AuthContext': {
      useAuth: () => ({
        user: { uid: 'guardrail-test-uid', email: 'dispatch-admin@wellbuilt.test', role: 'admin' },
        signOut: async () => {},
      }),
    },
    '@/lib/tabs': tabsModule,
    '@/lib/auth': {
      getRoleLabel: () => 'Admin',
      hasCapability: () => true,
      hasEQuipmentAccess: () => true,
      hasRole: () => true,
    },
    './NotificationBell': { NotificationBell: () => React.createElement('button', null, 'Alerts') },
    './chat/ChatIcon': { ChatIcon: () => React.createElement('button', null, 'Chat') },
    './chat/ChatSidebar': { ChatSidebar: () => null },
    '@/lib/firebase': {},
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    let css = '';
    const cssDir = path.join(process.cwd(), 'out', '_next', 'static', 'css');
    if (fs.existsSync(cssDir)) {
      css = fs
        .readdirSync(cssDir)
        .filter((n) => n.endsWith('.css'))
        .map((n) => fs.readFileSync(path.join(cssDir, n), 'utf8'))
        .join('\n');
    }

    const html = `<style>${css}</style>${renderToStaticMarkup(React.createElement(AppHeader))}`;
    await page.setContent(html);

    const testWidths = [344, 390, 412, 768, 800, 1024, 1280, 1440, 1920];

    for (const width of testWidths) {
      await page.setViewportSize({ width, height: 900 });
      const metrics = await page.evaluate(() => {
        const title = document.querySelector('h1')?.getBoundingClientRect();
        const nav = document.querySelector('nav')?.getBoundingClientRect();
        const header = document.querySelector('header')?.getBoundingClientRect();
        const scrollWidth = document.documentElement.scrollWidth;
        const clientWidth = window.innerWidth;
        const clipped = [...document.querySelectorAll('header a, header button')].some((el) => {
          const r = el.getBoundingClientRect();
          return r.left < -1 || r.right > clientWidth + 1;
        });

        return {
          overflow: scrollWidth > clientWidth,
          clipped,
          scrollWidth,
          clientWidth,
          headerHeight: header ? header.height : 0,
          titleOffset: title ? Math.abs(title.x + title.width / 2 - clientWidth / 2) : 999,
          navOffset: nav ? Math.abs(nav.x + nav.width / 2 - clientWidth / 2) : 999,
        };
      });

      if (metrics.overflow) {
        throw new Error(`FAIL at ${width}px: Horizontal viewport overflow detected (${metrics.scrollWidth} > ${metrics.clientWidth}).`);
      }
      if (metrics.clipped) {
        throw new Error(`FAIL at ${width}px: Header button or link is clipped offscreen.`);
      }
      if (metrics.titleOffset > 1.5) {
        throw new Error(`FAIL at ${width}px: Header title is off-center by ${metrics.titleOffset.toFixed(1)}px.`);
      }
      if (metrics.navOffset > 1.5) {
        throw new Error(`FAIL at ${width}px: Header nav is off-center by ${metrics.navOffset.toFixed(1)}px.`);
      }
      console.log(`✓ Viewport ${width}px passed (height: ${metrics.headerHeight.toFixed(0)}px, titleOffset: ${metrics.titleOffset.toFixed(1)}px, overflow: false).`);
    }

    console.log('=== All Header & Navigation Guardrail Tests Passed Mechanically ===');
  } finally {
    await browser.close();
  }
}

if (process.argv[1]?.endsWith('test-header-navigation-guardrails.mjs')) {
  runHeaderNavigationGuardrails().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
