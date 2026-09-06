/**
 * Unfolded Z Fold body-scroll: one primary scroller, bottom control fully visible.
 * Run: node tools/test-foldBodyScroll.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const src = (rel) => readFileSync(join(root, rel), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const css = src('src/app/globals.css');
const admin = src('src/app/admin/page.tsx');
const dispatch = src('src/app/dispatch/page.tsx');
const header = src('src/components/AppHeader.tsx');

check('globals define dvh shell with vh fallback',
  css.includes('height: 100vh') && css.includes('height: 100dvh') && css.includes('.dashboard-viewport-shell'));
check('globals main scroller has min-height 0',
  css.includes('.dashboard-viewport-main') && css.includes('min-height: 0') && css.includes('overflow-y: auto'));
check('globals pad bottom with safe-area',
  css.includes('env(safe-area-inset-bottom'));
check('admin uses viewport shell, not h-screen chrome',
  admin.includes('dashboard-viewport-shell') && !/className="h-screen bg-gray-900 flex flex-col overflow-hidden"/.test(admin));
check('admin main is the primary scroller',
  admin.includes('data-dashboard-scroll="primary"') && admin.includes('dashboard-viewport-main'));
check('admin dropped calc(100vh - 220px)',
  !admin.includes('calc(100vh - 220px)'));
check('wells grid no longer traps in flex-1 min-h-0 overflow',
  !admin.includes('flex-1 grid grid-cols-1 lg:grid-cols-2 gap-6 min-h-0'));
check('add-well action id preserved',
  admin.includes('id="add-well-action"') && admin.includes('staffCreateWellConfig'));
check('dispatch uses viewport shell',
  dispatch.includes('dashboard-viewport-shell') && dispatch.includes('data-dashboard-scroll="workspace"'));
check('dispatch main has min-h-0',
  dispatch.includes('flex-1 flex flex-col min-h-0 overflow-hidden'));
check('header title still centered wrapping tools then tabs',
  header.includes('order-2 w-full min-w-0 flex flex-wrap justify-center') &&
  header.includes('aria-label="Account and administration"') &&
  header.includes('order-3 flex w-full min-w-0 flex-wrap justify-center') &&
  header.includes('WellBuilt Suite'));
check('header still has Admin in the tools row, not TABS',
  header.includes('href={pendingDriverCount > 0 ? \'/admin?tab=drivers\' : \'/admin\'}') &&
  !header.includes('label: \'Admin\''));

const shellCss = `
.dashboard-viewport-shell {
  height: 100vh;
  height: 100dvh;
  max-height: 100vh;
  max-height: 100dvh;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #111827;
}
.dashboard-viewport-main {
  flex: 1 1 0%;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding-bottom: max(1.5rem, env(safe-area-inset-bottom, 0px));
}
.header-mock { flex-shrink: 0; height: 197px; background: #1f2937; }
.sub-mock { flex-shrink: 0; height: 52px; background: #1f2937; }
.wide-table { width: 2400px; height: 40px; background: #374151; }
#fold-scroll-target {
  display: block; width: 100%; height: 48px; margin: 0; border: 0;
  background: #16a34a; color: #fff;
}
`;

const fixture = `<!doctype html><html><head><style>
html,body{margin:0;}
${shellCss}
</style></head><body>
<div class="dashboard-viewport-shell">
  <div class="header-mock"></div>
  <div class="sub-mock"></div>
  <main data-dashboard-scroll="primary" class="dashboard-viewport-main">
    <div style="height:2200px;background:#111827"></div>
    <div id="table-hscroll" style="overflow-x:auto;overflow-y:hidden">
      <div class="wide-table"></div>
    </div>
    <button id="fold-scroll-target">Add Well</button>
  </main>
</div>
</body></html>`;

const viewports = [
  { name: 'desktop-1600x900', width: 1600, height: 900 },
  { name: 'tablet-800x1280', width: 800, height: 1280 },
  { name: 'fold-landscape-1768x884', width: 1768, height: 884 },
  { name: 'fold-portrait-884x1104', width: 884, height: 1104 },
  { name: 'css-690x829', width: 690, height: 829 },
  { name: 'chrome-pressure-690x500', width: 690, height: 500 },
];

const browser = await chromium.launch({ headless: true });
try {
  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.setContent(fixture);
    const before = await page.evaluate(() => {
      const t = document.getElementById('fold-scroll-target').getBoundingClientRect();
      return { top: t.top, bottom: t.bottom, fully: t.top >= 0 && t.bottom <= innerHeight + 1 };
    });
    check(`${vp.name} bottom control starts below the fold`, before.fully === false || before.top > vp.height - 48,
      `top=${before.top}`);
    await page.evaluate(() => {
      const main = document.querySelector('[data-dashboard-scroll="primary"]');
      const target = document.getElementById('fold-scroll-target');
      target.scrollIntoView({ block: 'end', inline: 'nearest' });
      main.scrollTop = main.scrollHeight;
    });
    const after = await page.evaluate(() => {
      const t = document.getElementById('fold-scroll-target').getBoundingClientRect();
      const header = document.querySelector('.header-mock').getBoundingClientRect();
      const coveredByHeader = t.top < header.bottom && t.bottom > header.top;
      return {
        top: t.top,
        bottom: t.bottom,
        height: t.height,
        fully: t.top >= -1 && t.bottom <= innerHeight + 1 && t.height >= 47,
        coveredByHeader,
        pageOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
        tableHScroll: (() => {
          const wrap = document.getElementById('table-hscroll');
          return wrap.scrollWidth > wrap.clientWidth + 1;
        })(),
      };
    });
    check(`${vp.name} bottom control fully in view after scroll`, after.fully,
      `top=${after.top} bottom=${after.bottom} vh=${vp.height}`);
    check(`${vp.name} sticky header does not cover bottom control`, !after.coveredByHeader);
    check(`${vp.name} no horizontal page clipping`, !after.pageOverflowX);
    check(`${vp.name} wide table still scrolls horizontally inside its wrapper`, after.tableHScroll);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
