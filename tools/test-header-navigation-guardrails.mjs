import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);

export const EXPECTED_TABS = [
  { id: 'home', label: 'Home', href: '/' },
  { id: 'mobile', label: 'WB Mobile', href: '/mobile', capability: 'viewMobile' },
  { id: 'tickets', label: 'WB Tickets', href: '/tickets', capability: 'viewTickets' },
  { id: 'dispatch', label: 'Dispatch', href: '/dispatch', capability: 'viewDispatch' },
  { id: 'photo-review', label: 'Photo Review', href: '/photo-review', capability: 'viewDispatch' },
  { id: 'billing', label: 'WB Billing', href: '/billing', capability: 'viewBilling' },
  { id: 'payroll', label: 'WB Payroll', href: '/payroll', capability: 'viewPayroll' },
  { id: 'driverlogs', label: 'Driver Logs', href: '/driverlogs', capability: 'viewDriverLogs' },
  { id: 'equipment', label: 'eQuipment', href: '/equipment', capability: 'viewEQuipment' },
  { id: 'safety', label: 'Safety', href: '/safety', capability: 'viewSafety' },
  { id: 'settings', label: 'Settings', href: '/settings', capability: 'viewSettings' },
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
    if (exp.capability && act.capability !== exp.capability) {
      throw new Error(
        `FAIL: Capability mismatch for tab ${exp.id}. Expected ${exp.capability}, got ${act.capability}`,
      );
    }
  }

  // Ensure Photo Review is at index 4, directly between Dispatch (3) and WB Billing (5)
  const prIndex = actualTabs.findIndex((t) => t.id === 'photo-review');
  if (prIndex !== 4) {
    throw new Error(`FAIL: Photo Review must be at index 4 (between Dispatch and WB Billing), found at index ${prIndex}`);
  }
  if (actualTabs[prIndex - 1]?.id !== 'dispatch') {
    throw new Error(`FAIL: Tab preceding Photo Review must be 'dispatch', found '${actualTabs[prIndex - 1]?.id}'`);
  }
  if (actualTabs[prIndex + 1]?.id !== 'billing') {
    throw new Error(`FAIL: Tab following Photo Review must be 'billing', found '${actualTabs[prIndex + 1]?.id}'`);
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

  // Test 1: Missing Photo Review must fail
  let threw = false;
  try {
    validateTabs(EXPECTED_TABS.filter((t) => t.id !== 'photo-review'));
  } catch (err) {
    threw = true;
    if (!err.message.includes('Primary navigation tabs count mismatch')) {
      throw new Error(`Unexpected error message: ${err.message}`);
    }
  }
  if (!threw) throw new Error('FAIL: Negative test 1 (missing Photo Review) did not throw!');
  console.log('  ✓ Negative Test 1 Passed: Missing Photo Review tab caught.');

  // Test 2: Wrong tab ordering (Photo Review not between Dispatch and Billing) must fail
  threw = false;
  try {
    const moved = [...EXPECTED_TABS];
    const pr = moved.splice(4, 1)[0];
    moved.push(pr); // Move to end
    validateTabs(moved);
  } catch (err) {
    threw = true;
    if (!err.message.includes('Photo Review must be at index 4') && !err.message.includes('Tab mismatch')) {
      throw new Error(`Unexpected error message: ${err.message}`);
    }
  }
  if (!threw) throw new Error('FAIL: Negative test 2 (misplaced Photo Review) did not throw!');
  console.log('  ✓ Negative Test 2 Passed: Misplaced Photo Review tab caught.');

  // Test 3: Extraneous tab must fail
  threw = false;
  try {
    validateTabs([...EXPECTED_TABS, { id: 'extra', label: 'Extra', href: '/extra' }]);
  } catch (err) {
    threw = true;
    if (!err.message.includes('Primary navigation tabs count mismatch')) {
      throw new Error(`Unexpected error message: ${err.message}`);
    }
  }
  if (!threw) throw new Error('FAIL: Negative test 3 (extraneous tab) did not throw!');
  console.log('  ✓ Negative Test 3 Passed: Extraneous tab caught.');

  // Test 4: Missing capability gate must fail
  threw = false;
  try {
    const noCap = EXPECTED_TABS.map((t) => (t.id === 'photo-review' ? { ...t, capability: undefined } : t));
    validateTabs(noCap);
  } catch (err) {
    threw = true;
    if (!err.message.includes('Capability mismatch for tab photo-review')) {
      throw new Error(`Unexpected error message: ${err.message}`);
    }
  }
  if (!threw) throw new Error('FAIL: Negative test 4 (missing capability gate) did not throw!');
  console.log('  ✓ Negative Test 4 Passed: Missing capability gate on Photo Review caught.');

  // Test 5: Legacy 3-column header pattern must fail
  threw = false;
  try {
    validateHeaderSource('<header><div className="w-full grid grid-cols-[auto_1fr_auto] items-start"></div></header>');
  } catch (err) {
    threw = true;
    if (!err.message.includes('Regressed legacy 3-column header pattern detected')) {
      throw new Error(`Unexpected error message: ${err.message}`);
    }
  }
  if (!threw) throw new Error('FAIL: Negative test 5 (legacy 3-column header) did not throw!');
  console.log('  ✓ Negative Test 5 Passed: Legacy 3-column grid caught.');
}

export function testCapabilityGating(tabs) {
  console.log('--- Running Tab Capability Gating Tests ---');

  // Case A: User with viewDispatch capability
  const authorizedUser = { uid: 'auth-user', role: 'admin' };
  const authorizedCapabilities = new Set(['viewDispatch', 'viewMobile', 'viewTickets', 'viewBilling', 'viewPayroll', 'viewDriverLogs', 'viewEQuipment', 'viewSafety', 'viewSettings']);
  const visibleTabsAuth = tabs.filter((t) => !t.capability || authorizedCapabilities.has(t.capability));

  if (!visibleTabsAuth.some((t) => t.id === 'photo-review')) {
    throw new Error('FAIL: Authorized user with viewDispatch cannot see photo-review tab.');
  }
  console.log('  ✓ Authorized user with viewDispatch sees Photo Review tab.');

  // Case B: User without viewDispatch capability
  const unauthCapabilities = new Set(['viewBilling', 'viewPayroll']);
  const visibleTabsUnauth = tabs.filter((t) => !t.capability || unauthCapabilities.has(t.capability));

  if (visibleTabsUnauth.some((t) => t.id === 'photo-review')) {
    throw new Error('FAIL: Unauthorized user without viewDispatch sees photo-review tab.');
  }
  if (visibleTabsUnauth.some((t) => t.id === 'dispatch')) {
    throw new Error('FAIL: Unauthorized user without viewDispatch sees dispatch tab.');
  }
  console.log('  ✓ Unauthorized user without viewDispatch correctly hides Photo Review and Dispatch.');
}

export async function runHeaderNavigationGuardrails() {
  console.log('=== Running Header & Navigation Mechanical Guardrail Tests ===');

  // Step A: Run negative tests proving that every regression condition is caught
  runNegativeUnitTests();

  // Step B: Static tab configuration verification
  const tabsModule = transpileAndLoad('src/lib/tabs.ts');
  validateTabs(tabsModule.TABS);
  console.log('✓ Tab count (11), ordering, labels, and Photo Review positioning strictly verified.');

  // Step C: Capability gating verification
  testCapabilityGating(tabsModule.TABS);
  console.log('✓ Tab capability gating strictly verified.');

  // Step D: Source AST / layout contract inspection
  const headerSource = fs.readFileSync('src/components/AppHeader.tsx', 'utf8');
  validateHeaderSource(headerSource);
  console.log('✓ AppHeader source verified: legacy 3-column grid absent; compact centered wrappers present.');

  // Step E: Playwright Headless Layout Proof across viewports
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
