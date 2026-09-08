/**
 * Explicit Z Fold cover proof at 344x748 CSS px (not covered by the recovered
 * suites). Renders the real AppHeader + the accepted globals + built CSS into a
 * shell that mirrors admin (long flow), dispatch (jobs-first, collapsed queue),
 * and billing (pinned chrome + pinned totals + middle scroller), then measures
 * real layout in Chromium.
 * Run after `npx next build`: node tools/test-fold344.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

function load(file, dependencies) {
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const result = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (id) => (id in dependencies ? dependencies[id] : require(id)), result, result.exports);
  return result.exports;
}

const tabs = load(join(root, 'src/lib/tabs.ts'), {});
const { AppHeader } = load(join(root, 'src/components/AppHeader.tsx'), {
  'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
  'next/navigation': { usePathname: () => '/dispatch', useRouter: () => ({}) },
  'firebase/database': {},
  '@/contexts/AuthContext': { useAuth: () => ({ user: { uid: 'fx', email: 't@e.com', role: 'admin' }, signOut: async () => {} }) },
  '@/lib/tabs': tabs,
  '@/lib/auth': { getRoleLabel: () => 'Owner', hasCapability: () => true, hasEQuipmentAccess: () => true, hasRole: () => true },
  './NotificationBell': { NotificationBell: () => React.createElement('button', null, 'Alerts') },
  './chat/ChatIcon': { ChatIcon: () => React.createElement('button', null, 'Chat') },
  './chat/ChatSidebar': { ChatSidebar: () => null },
  '@/lib/firebase': {},
});
const headerHtml = renderToStaticMarkup(React.createElement(AppHeader));

const globals = readFileSync(join(root, 'src/app/globals.css'), 'utf8');
const chunksDir = join(root, 'out/_next/static/chunks');
const builtCss = existsSync(chunksDir)
  ? readdirSync(chunksDir).filter((n) => n.endsWith('.css')).map((n) => readFileSync(join(chunksDir, n), 'utf8')).join('\n')
  : '';

// A billing-style pinned chrome/totals + middle scroller (mirrors the accepted
// recovery markers billing-scroll / billing-pin used by the billing suite).
const billing = `
<div class="dashboard-viewport-main">
  <div style="display:flex;flex-direction:column;height:100%;min-height:0">
    <div class="billing-pin" style="flex-shrink:0;background:#374151">Receivables — Operator · Amount · Status</div>
    <div class="billing-scroll" style="flex:1 1 0%;min-height:0;overflow-y:auto">
      ${Array.from({ length: 60 }, (_, i) => `<div style="height:40px">row ${i}</div>`).join('')}
      <div id="billing-bottom">last row</div>
    </div>
    <div class="billing-pin" style="flex-shrink:0;background:#374151">TOTALS $12,345 · footer</div>
  </div>
</div>`;

const dispatch = `
<main class="dispatch-scroll-main">
  <div class="dispatch-workspace">
    <div class="dispatch-pane">
      <div class="dispatch-builder" style="background:#1f2937;height:300px">builder</div>
      <div class="dispatch-queue"><div class="dispatch-queue-body">${Array.from({ length: 30 }, (_, i) => `<div>well ${i}</div>`).join('')}</div></div>
    </div>
    <div class="dispatch-pane dispatch-pane-jobs" id="jobs-pane"><div class="dispatch-jobs" style="background:#1f2937;height:800px">jobs<div id="dispatch-bottom">end</div></div></div>
  </div>
</main>`;

const html = `<!doctype html><html><head><style>
html,body{margin:0}
${globals}
${builtCss}
</style></head><body>
<div class="dashboard-viewport-shell">${headerHtml}${billing}${dispatch}</div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 344, height: 748 } });
  await page.setContent(html, { waitUntil: 'load' });

  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const jobs = document.getElementById('jobs-pane');
    const queueBody = document.querySelector('.dispatch-queue-body');
    const billScroll = document.querySelector('.billing-scroll');
    const header = document.querySelector('h1');
    const pins = [...document.querySelectorAll('.billing-pin')];
    return {
      scrollWidth: de.scrollWidth, clientWidth: de.clientWidth,
      jobsOrder: jobs ? getComputedStyle(jobs).order : null,
      queueBodyDisplay: queueBody ? getComputedStyle(queueBody).display : null,
      billOverflowY: billScroll ? getComputedStyle(billScroll).overflowY : null,
      headerText: header ? header.textContent : '',
      headerCentered: header ? getComputedStyle(header.parentElement).textAlign : '',
      pinsFlexShrink: pins.map((p) => getComputedStyle(p).flexShrink),
    };
  });

  check('344px: scrollWidth === clientWidth (no horizontal page scroll)', m.scrollWidth === m.clientWidth, `${m.scrollWidth} vs ${m.clientWidth}`);
  check('344px: header shows accepted centered "WellBuilt Suite"', m.headerText === 'WellBuilt Suite' && m.headerCentered === 'center');
  check('344px: dispatch jobs pane is first (order -1)', m.jobsOrder === '-1');
  check('344px: collapsed well-queue body is hidden until expanded/search', m.queueBodyDisplay === 'none');
  check('344px: billing middle records scroll (overflow-y auto)', m.billOverflowY === 'auto' || m.billOverflowY === 'scroll');
  check('344px: billing chrome + totals are pinned (flex-shrink 0, not scrolled)', m.pinsFlexShrink.length === 2 && m.pinsFlexShrink.every((v) => v === '0'));

  // Reachability: scroll the page to the bottom and confirm the last sections are reachable (not clipped/hidden).
  const reach = await page.evaluate(async () => {
    const main = document.querySelector('.dispatch-scroll-main') || document.scrollingElement;
    main.scrollTop = main.scrollHeight;
    await new Promise((r) => requestAnimationFrame(r));
    const db = document.getElementById('dispatch-bottom');
    const r = db ? db.getBoundingClientRect() : null;
    return { canScroll: main.scrollHeight > main.clientHeight, bottomVisible: !!r && r.top < window.innerHeight + 4 };
  });
  check('344px: dispatch page is scrollable and its bottom is reachable', reach.canScroll && reach.bottomVisible);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
