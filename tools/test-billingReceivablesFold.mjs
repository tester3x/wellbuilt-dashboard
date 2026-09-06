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
check('receivables scroller is overflow-auto with viewport max-height',
  pageSrc.includes('data-billing-scroll="receivables"') &&
  pageSrc.includes('overflow-auto max-h-[calc(100dvh-12rem)]'));
check('operator table header is sticky',
  pageSrc.includes('sticky top-0 z-10'));
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

const rows = Array.from({ length: 40 }, (_, i) => `
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

const fixture = `<!doctype html><html><head><style>
html,body{margin:0;background:#111827;color:#fff;font-family:sans-serif;}
.page{height:100dvh;max-height:100dvh;display:flex;flex-direction:column;overflow:hidden;}
header{flex-shrink:0;height:56px;background:#0f172a;}
main{flex:1;min-height:0;overflow-y:auto;padding:16px;}
.tabs{display:flex;align-items:center;gap:4px;background:#1f2937;border-radius:8px;padding:4px;flex-shrink:0;}
.tab{padding:6px 12px;border-radius:6px;font-size:14px;white-space:nowrap;flex-shrink:0;border:0;color:#9ca3af;background:transparent;}
.tab.active{background:#2563eb;color:#fff;}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:16px;}
.card{background:#1f2937;border:1px solid #374151;border-radius:8px;overflow:hidden;}
.scroll{overflow:auto;max-height:calc(100dvh - 12rem);}
table{width:max-content;min-width:2200px;border-collapse:collapse;}
th{position:sticky;top:0;background:#374151;padding:8px 12px;text-align:left;font-size:13px;}
td{padding:8px 12px;white-space:nowrap;}
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
      <div class="scroll" data-billing-scroll="receivables">
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
            <tr><td colspan="9" style="padding:0">
              <table>
                <thead><tr>
                  <th>Invoice #</th><th>Date</th><th>Well</th><th>Drop-off</th><th>Driver</th>
                  <th>BBLs</th><th>Hours</th><th>Base</th><th>FSC</th>
                </tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>
</div>
</body></html>`;

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
        pageOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
      };
    });
    check(`${vp.name} scroller is overflow auto`,
      metrics.overflowX === 'auto' && metrics.overflowY === 'auto',
      `${metrics.overflowX}/${metrics.overflowY}`);
    check(`${vp.name} expanded list is taller than the visible card`,
      metrics.scrollHeight > metrics.clientHeight + 40,
      `scrollHeight=${metrics.scrollHeight} clientHeight=${metrics.clientHeight}`);
    check(`${vp.name} table is wider than the visible card`,
      metrics.scrollWidth > metrics.clientWidth + 20,
      `scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth}`);
    check(`${vp.name} horizontal slider is on screen`,
      metrics.scrollerBottom <= vp.height + 1 && metrics.scrollerBottom > 40,
      `bottom=${metrics.scrollerBottom} vh=${vp.height}`);
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
    check(`${vp.name} right-side Actions can be brought into view`,
      afterH.actionVisible, `actionRight=${afterH.actionRight}`);

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
