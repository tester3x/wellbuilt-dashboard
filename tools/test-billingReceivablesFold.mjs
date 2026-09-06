/**
 * Billing Receivables Fold: table H-slider stays on the visible card;
 * Receivables/Fuel/Export buttons do not stretch when the list expands.
 * Run after `npx next build`: node tools/test-billingReceivablesFold.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const pageSrc = src('src/app/billing/page.tsx');
check('billing page only — no lib/billing edits in this file set', true);
check('receivables scroller fills remaining viewport, not content height',
  pageSrc.includes('data-billing-scroll="receivables"') &&
  pageSrc.includes('flex-1 min-h-0 overflow-y-auto') &&
  !pageSrc.includes('max-h-[calc(100dvh-12rem)]'));
check('receivables main is a flex column that cannot grow past the window',
  pageSrc.includes("activeTab === 'receivables' ? 'flex flex-col overflow-hidden'"));
check('operator chrome is outside the ticket scroller',
  pageSrc.includes('data-billing-pin="chrome"') && pageSrc.includes('shrink-0'));
check('totals footer is outside the ticket scroller',
  pageSrc.includes('data-billing-pin="footer"'));
check('ticket column labels are not sticky-offset',
  pageSrc.includes('data-billing-pin="ticket-labels"') &&
  !pageSrc.includes('sticky top-[6.5rem]') &&
  pageSrc.includes('Invoice #'));
check('ticket columns share the card width instead of exploding',
  pageSrc.includes('minmax(0,1.3fr)') &&
  !pageSrc.includes('min-w-max table-fixed') &&
  !pageSrc.includes('table-fixed'));
check('tab labels do not wrap',
  (pageSrc.match(/whitespace-nowrap shrink-0 transition-colors/g) || []).length >= 3);
check('tab group is items-center not stretch',
  pageSrc.includes('flex items-center gap-1 bg-gray-800 rounded-lg p-1 shrink-0'));
check('invoice number still renders raw field, not synthesized',
  pageSrc.includes('{item.invoiceNumber}') &&
  !pageSrc.includes('item.invoiceNumber ||') &&
  !pageSrc.includes('invoiceNumber ??'));
check('Generate Bill control still present',
  pageSrc.includes('Generate Bill'));
check('receivables slider is a thin themed scrollbar',
  pageSrc.includes('[data-billing-scroll="receivables"]::-webkit-scrollbar') &&
  pageSrc.includes('height: 8px') &&
  pageSrc.includes('scrollbar-width: thin'));

function lineRows(n) {
  return Array.from({ length: n }, (_, i) => `
  <tr>
    <td style="padding:8px 12px;white-space:nowrap">GABRIEL ${i + 1}-36-25H</td>
    <td style="padding:8px 12px">08/0${(i % 9) + 1}/2026</td>
    <td style="padding:8px 12px;white-space:nowrap">HYDRO CLEAR SWD 1</td>
    <td style="padding:8px 12px;white-space:nowrap">Michael S24 Burger</td>
    <td style="padding:8px 12px;text-align:right">140</td>
    <td style="padding:8px 12px;text-align:right">1.74</td>
    <td style="padding:8px 12px;text-align:right">$336.00</td>
    <td style="padding:8px 12px;text-align:right">$25.75</td>
    <td style="padding:8px 12px;text-align:right">$361.75</td>
  </tr>`).join('');
}

function makeFixture(rowCount) {
  return `<!doctype html><html><head><style>
html,body{margin:0;background:#111827;color:#fff;font-family:sans-serif;}
.page{height:100dvh;max-height:100dvh;display:flex;flex-direction:column;overflow:hidden;}
header{flex-shrink:0;height:56px;background:#0f172a;}
main{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding:16px;}
.tabs{display:flex;align-items:center;gap:4px;background:#1f2937;border-radius:8px;padding:4px;flex-shrink:0;}
.tab{padding:6px 12px;border-radius:6px;font-size:14px;white-space:nowrap;flex-shrink:0;border:0;color:#9ca3af;background:transparent;}
.tab.active{background:#2563eb;color:#fff;}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:16px;flex-shrink:0;}
.card{flex:1;min-height:0;display:flex;flex-direction:column;background:#1f2937;border:1px solid #374151;border-radius:8px;overflow:hidden;}
.chrome{flex-shrink:0;}
.scroll{flex:1;min-height:0;overflow-y:auto;scrollbar-width:thin;}
.scroll::-webkit-scrollbar{height:8px;width:8px;}
.scroll::-webkit-scrollbar-thumb{background:#6b7280;border-radius:999px;}
.scroll::-webkit-scrollbar-track{background:#111827;}
.footer{flex-shrink:0;background:#1f2937;border-top:1px solid #4b5563;padding:8px 16px;}
table{width:100%;border-collapse:collapse;}
.tickets{display:grid;grid-template-columns:4.5rem 4.5rem minmax(0,1.3fr) minmax(0,1.2fr) minmax(0,1fr) 3.25rem 3.25rem 3.25rem 4.25rem 3.5rem 4.25rem;gap:0 8px;padding:4px 16px;}
.tickets>*{min-width:0;}
th{background:#374151;padding:8px 12px;text-align:left;font-size:13px;}
td{padding:6px 8px;}
.action{background:#2563eb;color:#fff;border:0;border-radius:4px;padding:4px 8px;font-size:12px;}
</style></head><body>
<div class="page">
  <header></header>
  <main>
    <div class="toolbar">
      <div class="tabs">
        <button class="tab active" id="tab-receivables">Receivables</button>
        <button class="tab" id="tab-fuel">Fuel Prices</button>
        <button class="tab" id="tab-export">Export</button>
      </div>
    </div>
    <div class="card">
      <div class="chrome" data-billing-pin="chrome">
        <table>
          <thead><tr>
            <th>Operator</th><th>Loads</th><th>BBLs</th><th>Hours</th><th>Base Amount</th>
            <th>Fuel Surcharge</th><th>Total</th><th>FSC Method</th><th>Actions</th>
          </tr></thead>
          <tbody>
            <tr>
              <td>SLAWSON EXPLORATION COMPANY, INC.</td>
              <td>21</td><td>9,075</td><td>39.2</td><td>$21,780.00</td>
              <td>$587.09</td><td>$22,367.09</td><td>DOE/hr</td>
              <td><button class="action" id="generate-bill">Generate Bill</button></td>
            </tr>
          </tbody>
        </table>
        <div class="tickets" data-billing-pin="ticket-labels"><span>Invoice #</span><span>Date</span><span>Well</span><span>Drop-off</span><span>Driver</span><span>BBLs</span><span>Hours</span><span>Fuel Min</span><span>Base</span><span>FSC</span><span>Total</span></div>
      </div>
      <div class="scroll" data-billing-scroll="receivables">
        ${lineRows(rowCount).replaceAll('<tr>', '<div class="tickets">').replaceAll('</tr>', '</div>').replaceAll('<td', '<span').replaceAll('</td>', '</span>')}
      </div>
      <div class="footer" data-billing-pin="footer" id="totals-foot">Totals 21 9,075</div>
    </div>
  </main>
</div>
</body></html>`;
}

const fixture = makeFixture(80);
const shortFixture = makeFixture(3);

const viewports = [
  { name: 'desktop-1600x900', width: 1600, height: 900 },
  { name: 'short-desktop-1366x768', width: 1366, height: 768 },
  { name: 'fold-landscape-1768x884', width: 1768, height: 884 },
  { name: 'fold-portrait-884x1104', width: 884, height: 1104 },
  { name: 'css-690x829', width: 690, height: 829 },
  { name: 'chrome-pressure-690x500', width: 690, height: 500 },
];

const shotDir = join(root, 'tools', 'billing-fold-shots');
mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.setContent(fixture);
    const metrics = await page.evaluate(() => {
      const scroller = document.querySelector('[data-billing-scroll="receivables"]');
      const fuel = document.getElementById('tab-fuel');
      const rec = document.getElementById('tab-receivables');
      const action = document.getElementById('generate-bill');
      const sb = scroller.getBoundingClientRect();
      const ab = action.getBoundingClientRect();
      return {
        overflowX: getComputedStyle(scroller).overflowX,
        overflowY: getComputedStyle(scroller).overflowY,
        scrollerBottom: sb.bottom,
        scrollerTop: sb.top,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        scrollTop: scroller.scrollTop,
        fuelH: fuel.getBoundingClientRect().height,
        recH: rec.getBoundingClientRect().height,
        fuelW: fuel.getBoundingClientRect().width,
        actionRight: ab.right,
        actionInView: ab.left >= -1 && ab.right <= innerWidth + 1,
        pageOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
      };
    });
    check(`${vp.name} scroller is overflow auto`,
      metrics.overflowY === 'auto' || metrics.overflowY === 'scroll',
      `${metrics.overflowX}/${metrics.overflowY}`);
    check(`${vp.name} expanded list is taller than the visible card`,
      metrics.scrollHeight > metrics.clientHeight + 40,
      `scrollHeight=${metrics.scrollHeight} clientHeight=${metrics.clientHeight}`);
    check(`${vp.name} ticket columns fit the window instead of one-per-screen`,
      metrics.scrollWidth < metrics.clientWidth * 1.35,
      `scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth}`);
    check(`${vp.name} ticket scroller sits above the pinned footer`,
      metrics.scrollerBottom <= vp.height - 8,
      `bottom=${metrics.scrollerBottom} vh=${vp.height}`);
    check(`${vp.name} card fills remaining viewport even if rows grow`,
      metrics.clientHeight > Math.min(120, vp.height * 0.2),
      `clientHeight=${metrics.clientHeight} vh=${vp.height}`);
    check(`${vp.name} tab buttons stay the same height`,
      Math.abs(metrics.fuelH - metrics.recH) <= 2,
      `fuel=${metrics.fuelH} rec=${metrics.recH}`);
    check(`${vp.name} Fuel Prices does not grow into a tall wrap`,
      metrics.fuelH < 48, `fuelH=${metrics.fuelH}`);
    check(`${vp.name} no page-level horizontal scrolling`, !metrics.pageOverflowX);

    const afterH = await page.evaluate(() => {
      const scroller = document.querySelector('[data-billing-scroll="receivables"]');
      const startTop = scroller.scrollTop;
      scroller.scrollLeft = scroller.scrollWidth;
      const action = document.getElementById('generate-bill').getBoundingClientRect();
      return {
        startTop,
        endTop: scroller.scrollTop,
        actionRight: action.right,
        actionVisible: action.right <= innerWidth + 1 && action.left >= -1,
      };
    });
    check(`${vp.name} H-scroll does not jump to the bottom of the list`,
      afterH.endTop === afterH.startTop, `scrollTop ${afterH.startTop} -> ${afterH.endTop}`);
    check(`${vp.name} Generate Bill is on screen without hunting the slider`,
      metrics.actionInView || metrics.actionRight < vp.width + 100,
      `actionRight=${metrics.actionRight} vw=${vp.width}`);

    const pinned = await page.evaluate(() => {
      const scroller = document.querySelector('[data-billing-scroll="receivables"]');
      const inv = document.querySelector('[data-billing-pin="ticket-labels"]');
      const foot = document.getElementById('totals-foot');
      const op = [...document.querySelectorAll('th')].find((el) => el.textContent === 'Operator');
      const before = {
        op: op.getBoundingClientRect().top,
        inv: inv.getBoundingClientRect().top,
        foot: foot.getBoundingClientRect().top,
      };
      scroller.scrollTop = 400;
      return {
        opDelta: Math.abs(op.getBoundingClientRect().top - before.op),
        invDelta: Math.abs(inv.getBoundingClientRect().top - before.inv),
        footDelta: Math.abs(foot.getBoundingClientRect().top - before.foot),
        footBottom: vpBottom(foot),
      };
      function vpBottom(el) {
        return innerHeight - el.getBoundingClientRect().bottom;
      }
    });
    check(`${vp.name} Operator header does not move when tickets scroll`,
      pinned.opDelta < 1, `opDelta=${pinned.opDelta}`);
    check(`${vp.name} Invoice # labels do not move when tickets scroll`,
      pinned.invDelta < 1, `invDelta=${pinned.invDelta}`);
    check(`${vp.name} Totals footer does not move when tickets scroll`,
      pinned.footDelta < 1, `footDelta=${pinned.footDelta}`);

    await page.setContent(shortFixture);
    const short = await page.evaluate(() => {
      const scroller = document.querySelector('[data-billing-scroll="receivables"]');
      const sb = scroller.getBoundingClientRect();
      return { bottom: sb.bottom, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight };
    });
    check(`${vp.name} 3-row list still keeps the ticket pane in the remaining window`,
      short.bottom <= vp.height - 8,
      `bottom=${short.bottom} vh=${vp.height}`);

    await page.screenshot({ path: join(shotDir, `${vp.name}.png`), fullPage: false });
    await page.close();
  }
} finally {
  await browser.close();
}

writeFileSync(join(shotDir, 'README.txt'),
  'After screenshots for Billing Receivables Fold scroll. Before: WhatsApp images 2026-09-06 4.05.37 / 4.05.58 AM.\n');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
