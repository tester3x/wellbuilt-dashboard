/**
 * Rendered DOM regression test for the Projects Well (and every) Builder autocomplete
 * scroll behavior. Uses a REAL chromium layout engine (Playwright) — pure scroll-math
 * unit tests cannot catch the offsetParent bug, because that bug only exists once real
 * layout assigns offsetParent/rects.
 *
 * It reproduces the exact Projects Well condition: a NON-positioned suggestion
 * container (max-height + overflow-y:auto) inside a tall, independently-scrollable
 * page, with more options than fit. It then runs the ACTUAL scrollActiveOptionIntoView
 * source (type-stripped, the same code the hook calls) while Arrow-navigating, and
 * proves that on every step:
 *   - the active option is fully inside the container viewport (ArrowDown to the last,
 *     ArrowUp back to the first),
 *   - the CONTAINER scrollTop moves,
 *   - the PAGE/document does NOT scroll.
 * It also asserts the container is genuinely the bug condition (option.offsetParent is
 * NOT the container), so the test would catch a regression to offsetTop math.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');

// The actual shipped helper, type-stripped so it runs as a classic browser script.
const helperSrc = fs
  .readFileSync(path.join(repo, 'src/lib/scrollActiveOption.ts'), 'utf8')
  .replace(/export function/, 'function')
  .replace(/: HTMLElement/g, '')
  .replace(/\): void/g, ')');

const N = 40;
const ROW = 30;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; }
  /* Tall page so the DOCUMENT could scroll if we wrongly moved it. */
  .page { height: 3000px; padding-top: 400px; }
  .builder { width: 360px; }
  /* Projects Well condition: NOT positioned, capped height, own scroll. */
  .list { max-height: ${ROW * 3}px; overflow-y: auto; border: 1px solid #444; }
  .opt { display:block; width:100%; height:${ROW}px; box-sizing:border-box; border-bottom:1px solid #333; text-align:left; }
</style></head><body>
  <div class="page">
    <div class="builder">
      <input id="inp" />
      <div id="list" class="list">
        ${Array.from({ length: N }, (_, i) => `<button class="opt" id="opt-${i}">Well ${i}</button>`).join('')}
      </div>
    </div>
  </div>
  <script>${helperSrc}
    window.__opts = () => Array.from(document.querySelectorAll('.opt'));
    window.__list = () => document.getElementById('list');
  </script>
</body></html>`;

function fail(msg) {
  console.error('  ✗ ' + msg);
  process.exitCode = 1;
  throw new Error(msg);
}

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(html);

  // Precondition: the container is genuinely NON-positioned (the bug condition).
  const isBugCondition = await page.evaluate(() => {
    const list = window.__list();
    const opt = document.getElementById('opt-10');
    return opt.offsetParent !== list; // offsetTop would be relative to a far ancestor
  });
  if (!isBugCondition) fail('precondition: expected a non-positioned container (offsetParent !== list)');
  console.log('  ✓ Reproduced the Projects Well condition: suggestion container is not the offsetParent.');

  // Helper: activate option i, run the REAL scroll helper, return visibility + scroll facts.
  const step = (i) =>
    page.evaluate((idx) => {
      const list = window.__list();
      const opt = document.getElementById('opt-' + idx);
      // eslint-disable-next-line no-undef
      scrollActiveOptionIntoView(list, opt); // the actual shipped code
      const lr = list.getBoundingClientRect();
      const or = opt.getBoundingClientRect();
      const fullyVisible = or.top >= lr.top - 0.5 && or.bottom <= lr.bottom + 0.5;
      const doc = document.scrollingElement || document.documentElement;
      return { fullyVisible, listScrollTop: list.scrollTop, docScrollTop: doc.scrollTop };
    }, i);

  // ArrowDown 0 → last (clamped), then a few extra to confirm it holds at the end.
  let lastListScroll = -1;
  let listMoved = false;
  for (let n = 0; n <= N + 3; n++) {
    const i = Math.min(n, N - 1);
    const r = await step(i);
    if (!r.fullyVisible) fail(`ArrowDown: option ${i} not fully visible (listScrollTop=${r.listScrollTop})`);
    if (r.docScrollTop !== 0) fail(`ArrowDown: the PAGE scrolled (docScrollTop=${r.docScrollTop}) — only the container may scroll`);
    if (r.listScrollTop !== lastListScroll) listMoved = true;
    lastListScroll = r.listScrollTop;
  }
  if (!listMoved) fail('ArrowDown: the container never scrolled (max-height not enforced?)');
  console.log('  ✓ ArrowDown: every option stayed fully visible to the last; container scrolled; page did not.');

  // ArrowUp last → first.
  for (let i = N - 1; i >= 0; i--) {
    const r = await step(i);
    if (!r.fullyVisible) fail(`ArrowUp: option ${i} not fully visible (listScrollTop=${r.listScrollTop})`);
    if (r.docScrollTop !== 0) fail(`ArrowUp: the PAGE scrolled (docScrollTop=${r.docScrollTop})`);
  }
  // Back at the top, the container is scrolled to (or near) 0.
  const top = await step(0);
  if (top.listScrollTop > 1) fail(`ArrowUp to first: container not returned to top (listScrollTop=${top.listScrollTop})`);
  console.log('  ✓ ArrowUp: every option stayed fully visible back to the first; container returned to top; page did not move.');

  await browser.close();
};

console.log('=== Projects Well (non-positioned container) scroll regression — real chromium layout ===');
run()
  .then(() => {
    if (process.exitCode) {
      console.error('=== Projects Well scroll regression FAILED ===');
    } else {
      console.log('=== Projects Well scroll regression PASSED ===');
    }
  })
  .catch((err) => {
    console.error('=== Projects Well scroll regression FAILED:', err.message, '===');
    process.exitCode = 1;
  });
