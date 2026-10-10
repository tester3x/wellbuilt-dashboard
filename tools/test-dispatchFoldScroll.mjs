/** Check Dispatch workspace tabs at desktop, tablet, and Fold sizes. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const pageSource = readFileSync(join(root, 'src/app/dispatch/page.tsx'), 'utf8');
const css = readFileSync(join(root, 'src/app/globals.css'), 'utf8');
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

check('Dispatch provides Build Job, Well Queue, and Jobs tabs',
  pageSource.includes("['build', 'Build Job']") &&
  pageSource.includes("['queue', 'Well Queue']") &&
  pageSource.includes("['jobs', 'Jobs']"));
check('queue assignment opens the PW builder',
  pageSource.includes("handleBuilderTabChange('pw');") &&
  pageSource.includes("setWorkspaceTab('build');") &&
  pageSource.includes('Build PW Job'));
check('Pop Out is reserved for tall desktops',
  css.includes('.dispatch-popout-control { display: none; }') &&
  css.includes('.dispatch-popout-control { display: inline-flex; }'));

const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{margin:0;background:#111827;color:#fff}
.dashboard-viewport-shell{height:100dvh;min-height:0;display:flex;flex-direction:column;overflow:hidden}
header{height:48px;flex-shrink:0;background:#1f2937}
nav{display:flex;gap:8px;padding:8px;flex-shrink:0}
nav button{min-width:80px;padding:8px}
.dispatch-scroll-main{padding:12px;box-sizing:border-box}
.dispatch-builder,.dispatch-queue,.dispatch-jobs{background:#1f2937;border:1px solid #4b5563}
.dispatch-builder,.dispatch-queue,.dispatch-pane-jobs{box-sizing:border-box}
.dispatch-queue-body,.dispatch-jobs-body{padding:12px}
${css.slice(css.indexOf('/* Dispatch-only:'), css.indexOf('/* ─────────────────────────────────────────────────────────────────────────'))}
</style></head><body><div class="dashboard-viewport-shell"><header>WellBuilt Suite · Dispatch</header>
<main class="dispatch-scroll-main" data-dispatch-scroll="primary"><nav aria-label="Dispatch workspace">
<button data-tab="build" aria-pressed="true">Build Job</button>
<button data-tab="queue" aria-pressed="false">Well Queue</button>
<button data-tab="jobs" aria-pressed="false">Jobs</button></nav>
<div class="dispatch-workspace">
<div class="dispatch-builder" data-panel="build"><div style="height:900px;padding:12px">PW / SW form <input id="draft" value="draft remains"></div><div id="build-end">Dispatch</div></div>
<div class="dispatch-queue is-inactive" data-panel="queue"><div style="padding:12px">Well Queue <input class="dispatch-queue-search" placeholder="Search wells..."><select class="dispatch-queue-route"><option>All Routes</option></select><button class="dispatch-popout-control">Pop Out</button></div><div class="dispatch-queue-body"><div style="height:900px">Well rows</div><div id="queue-end">Final well</div></div></div>
<div class="dispatch-pane dispatch-pane-jobs is-inactive" data-panel="jobs"><div class="dispatch-jobs"><div style="padding:12px">Active / Completed / Projects <button class="dispatch-popout-control">Pop Out</button></div><div class="dispatch-jobs-body"><div style="height:900px">Job rows</div><div id="jobs-end">Final job</div></div></div></div>
</div></main></div><script>
document.querySelectorAll('nav button').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  document.querySelectorAll('[data-panel]').forEach(panel => panel.classList.toggle('is-inactive', panel.dataset.panel !== button.dataset.tab));
}));
</script></body></html>`;

const viewports = [
  [1600, 900], [800, 1280], [1768, 884], [884, 1104], [690, 829], [690, 500], [344, 740],
];
const browser = await chromium.launch({ headless: true });
try {
  for (const [width, height] of viewports) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(fixture);
    for (const tab of ['build', 'queue', 'jobs']) {
      await page.locator(`button[data-tab="${tab}"]`).click();
      const state = await page.evaluate((active) => {
        const panels = [...document.querySelectorAll('[data-panel]')];
        const visible = panels.filter(panel => getComputedStyle(panel).display !== 'none');
        const rect = visible[0]?.getBoundingClientRect();
        return {
          visible: visible.map(panel => panel.dataset.panel),
          pressed: document.querySelector(`button[data-tab="${active}"]`).getAttribute('aria-pressed'),
          left: rect?.left, right: rect?.right, top: rect?.top,
          headerBottom: document.querySelector('header').getBoundingClientRect().bottom,
          overflowX: document.documentElement.scrollWidth > innerWidth + 1,
          popout: getComputedStyle(visible[0]?.querySelector('.dispatch-popout-control') || document.querySelector('.dispatch-popout-control')).display,
        };
      }, tab);
      const name = `${width}x${height} ${tab}`;
      check(`${name} shows only its pane`, state.visible.length === 1 && state.visible[0] === tab && state.pressed === 'true', JSON.stringify(state.visible));
      check(`${name} pane fits below header`, state.left >= 0 && state.right <= width + 1 && state.top >= state.headerBottom - 1 && !state.overflowX, JSON.stringify(state));
      if (tab !== 'build') check(`${name} Pop Out matches viewport`, state.popout === (width >= 1280 && height >= 900 ? 'inline-flex' : 'none'), state.popout);
      const bottom = await page.evaluate((active) => {
        const end = document.getElementById(`${active}-end`);
        end.scrollIntoView({ block: 'end' });
        const rect = end.getBoundingClientRect();
        const headerBottom = document.querySelector('header').getBoundingClientRect().bottom;
        return { top: rect.top, bottom: rect.bottom, headerBottom };
      }, tab);
      check(`${name} last control can be reached`, bottom.top >= bottom.headerBottom - 1 && bottom.bottom <= height + 1, JSON.stringify(bottom));
    }
    await page.locator('button[data-tab="build"]').click();
    check(`${width}x${height} draft survives tab switches`, await page.locator('#draft').inputValue() === 'draft remains');
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
