/**
 * Rendered-browser layout regression for the Projects selected-well chips.
 * Real chromium (Playwright). Verifies at desktop / mobile / Fold widths that the
 * selected-well list wraps cleanly, never causes horizontal page overflow (even with
 * many wells and long names), stays contained, and that each Remove control is a
 * usable hit target. Uses Tailwind-equivalent CSS for the layout-critical utilities
 * so the check is self-contained (no build needed) yet exercises real layout.
 */
import { chromium } from 'playwright';

// Tailwind-equivalent definitions for the exact utilities the chip markup uses.
const css = `
  * { box-sizing: border-box; }
  body { margin: 0; background:#0a0a0a; color:#fff; font: 14px system-ui, sans-serif; }
  .col { }                                   /* the Projects builder left column */
  .flex { display:flex; } .flex-wrap { flex-wrap:wrap; } .content-start { align-content:flex-start; }
  .gap-2 { gap:8px; } .items-center { align-items:center; }
  .max-h-48 { max-height:12rem; } .overflow-y-auto { overflow-y:auto; }
  .inline-flex { display:inline-flex; } .max-w-full { max-width:100%; }
  .rounded-lg { border-radius:8px; } .border { border-width:1px; border-style:solid; border-color:#10b98199; }
  .bg { background:#05966922; } .py { padding-top:6px; padding-bottom:6px; } .pl { padding-left:12px; } .pr { padding-right:4px; }
  .text-sm { font-size:14px; }
  .truncate { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .font-medium { font-weight:500; }
  .flex-shrink-0 { flex-shrink:0; }
  .rm { display:flex; height:32px; width:32px; align-items:center; justify-content:center; border-radius:4px; background:none; border:0; color:#6ee7b7; }
`;

const WELLS = [
  'Gabriel 1', 'Gabriel 2', 'Gabriel 3', 'Barbarian 1', 'Thor 1', 'Cyclone 2',
  'ARROWHEAD SOG FEDERAL 5-8-17-1H VERY LONG DISPLAY NAME', 'Kahuna 1', 'Battalion 2',
  'Antigravity 3', 'Stallion 12', 'Wolverine 7', 'Longhorn Federal 44-21-16-3TFH', 'Rascal 9',
];

const chip = (w) => `
  <span role="listitem" class="inline-flex max-w-full items-center gap-2 rounded-lg border bg py pl pr text-sm flex-shrink-0">
    <span aria-hidden="true" class="flex-shrink-0">✓</span>
    <span class="truncate font-medium" title="${w}">${w}</span>
    <button type="button" aria-label="Remove ${w}" class="rm flex-shrink-0">×</button>
  </span>`;

const html = (n) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
  <div class="col" id="col" style="width:100%; padding:12px;">
    <div role="list" aria-label="Selected wells" id="list" class="flex flex-wrap content-start gap-2 max-h-48 overflow-y-auto">
      ${WELLS.slice(0, n).map(chip).join('')}
    </div>
  </div>
</body></html>`;

const CASES = [
  { name: 'desktop 1280', width: 1280, col: 520 }, // left column is a fraction of a wide grid
  { name: 'mobile 390', width: 390, col: 366 },
  { name: 'Fold 344', width: 344, col: 320 },
];

function fail(m) { console.error('  ✗ ' + m); process.exitCode = 1; throw new Error(m); }

const run = async () => {
  const browser = await chromium.launch();
  for (const c of CASES) {
    const page = await browser.newPage({ viewport: { width: c.width, height: 700 } });
    await page.setContent(html(WELLS.length));
    await page.evaluate((cw) => { document.getElementById('col').style.width = cw + 'px'; }, c.col);
    const r = await page.evaluate(() => {
      const doc = document.scrollingElement || document.documentElement;
      const chips = Array.from(document.querySelectorAll('[role="listitem"]'));
      const rows = new Set(chips.map((el) => Math.round(el.getBoundingClientRect().top)));
      const list = document.getElementById('list');
      const overflowX = doc.scrollWidth > doc.clientWidth + 1;
      // every chip stays within the column width (no chip wider than its container)
      const colW = document.getElementById('col').clientWidth;
      const tooWide = chips.some((el) => el.getBoundingClientRect().width > colW + 1);
      const rmSizes = Array.from(document.querySelectorAll('.rm')).map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); });
      const minRm = Math.min(...rmSizes);
      return { rows: rows.size, overflowX, tooWide, minRm, listScrollW: list.scrollWidth, listClientW: list.clientWidth };
    });
    if (r.overflowX) fail(`${c.name}: horizontal PAGE overflow`);
    if (r.tooWide) fail(`${c.name}: a chip is wider than its container (long name not truncated)`);
    if (r.listScrollW > r.listClientW + 1) fail(`${c.name}: the list overflows horizontally instead of wrapping`);
    if (r.rows < 2) fail(`${c.name}: ${WELLS.length} chips did not wrap onto multiple rows (rows=${r.rows})`);
    if (r.minRm < 32) fail(`${c.name}: Remove hit target too small (${r.minRm}px)`);
    console.log(`  ✓ ${c.name}: ${WELLS.length} chips wrapped onto ${r.rows} rows, no overflow, Remove target ${r.minRm}px.`);
    await page.close();
  }
  await browser.close();
};

console.log('=== Projects selected-well chips — layout regression (real chromium) ===');
run()
  .then(() => console.log(process.exitCode ? '=== FAILED ===' : '=== PASSED ==='))
  .catch((e) => { console.error('=== FAILED:', e.message, '==='); process.exitCode = 1; });
