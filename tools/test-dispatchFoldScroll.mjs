/**
 * Rendered Dispatch Fold scroll: real AppHeader + Dispatch chrome.
 * Wheel/touch-style scroll must move the page scroller and reveal lower controls.
 * Run after `npx next build`: node tools/test-dispatchFoldScroll.mjs
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

const src = (rel) => readFileSync(join(root, rel), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const dispatchPage = src('src/app/dispatch/page.tsx');
const globals = src('src/app/globals.css');
check('dispatch page scroller marker', dispatchPage.includes('data-dispatch-scroll="primary"'));
check('dispatch uses dispatch-scroll-main not overflow-hidden main',
  dispatchPage.includes('className="dispatch-scroll-main px-4 py-4"') &&
  !dispatchPage.includes('data-dashboard-scroll="workspace"'));
check('dispatch dropped fixed 460px builder', !dispatchPage.includes('h-[460px]'));
check('dispatch dropped locked 50% overflow-hidden panes',
  !dispatchPage.includes('w-[50%] flex-shrink-0 flex flex-col gap-3 min-h-0 overflow-hidden') &&
  !dispatchPage.includes('w-[50%] flex-shrink-0 flex flex-col min-h-0 overflow-hidden'));
check('globals define dispatch-scroll-main', globals.includes('.dispatch-scroll-main') && globals.includes('overflow-y: auto'));
check('globals do not nest another 100dvh under header for dispatch',
  !/dispatch-scroll-main[\s\S]{0,200}100dvh/.test(globals));
check('stacked layouts put jobs pane first',
  globals.includes('.dispatch-pane-jobs') && globals.includes('order: -1'));
check('desktop split restores jobs pane order',
  /@media \(min-width: 1280px\) and \(min-height: 900px\)[\s\S]*\.dispatch-pane-jobs[\s\S]*order: 0/.test(globals));
check('stacked well queue is collapsed unless expanded',
  globals.includes('.dispatch-queue:not(.is-expanded):not(.has-search) .dispatch-queue-body') &&
  dispatchPage.includes('wellQueueExpanded') &&
  dispatchPage.includes('dispatch-queue-toggle') &&
  dispatchPage.includes('aria-controls="dispatch-queue-body"'));
check('search box lives in the well queue title row', (() => {
  const title = dispatchPage.indexOf('>Well Queue<');
  const searchBox = dispatchPage.indexOf('placeholder="Search wells..."', title);
  const body = dispatchPage.indexOf('id="dispatch-queue-body"', title);
  return title !== -1 && searchBox > title && body > searchBox;
})());
check('search hits open the queue without Show list',
  globals.includes('.has-search') &&
  dispatchPage.includes('has-search') &&
  dispatchPage.includes('wellQueueUsesSearchHits'));

function load(file, dependencies) {
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
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

const tabs = load(join(root, 'src/lib/tabs.ts'), {});
const { AppHeader } = load(join(root, 'src/components/AppHeader.tsx'), {
  'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
  'next/navigation': { usePathname: () => '/dispatch', useRouter: () => ({}) },
  'firebase/database': {},
  '@/contexts/AuthContext': { useAuth: () => ({ user: { uid: 'fixture', email: 'test@example.com', role: 'admin' }, signOut: async () => {} }) },
  '@/lib/tabs': tabs,
  '@/lib/auth': { getRoleLabel: () => 'Owner', hasCapability: () => true, hasEQuipmentAccess: () => true, hasRole: () => true },
  './NotificationBell': { NotificationBell: () => React.createElement('button', null, 'Alerts') },
  './chat/ChatIcon': { ChatIcon: () => React.createElement('button', null, 'Chat') },
  './chat/ChatSidebar': { ChatSidebar: () => null },
  '@/lib/firebase': {},
});

const headerHtml = renderToStaticMarkup(React.createElement(AppHeader));
check('real AppHeader rendered', headerHtml.includes('WellBuilt Suite') && headerHtml.includes('Account and administration'));

const dispatchCssMatch = globals.match(/\/\* Dispatch-only:[\s\S]*}\s*}\s*/);
const dispatchCss = dispatchCssMatch
  ? dispatchCssMatch[0]
  : src('src/app/globals.css').slice(src('src/app/globals.css').indexOf('.dispatch-scroll-main'));
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
${dispatchCss}
`;

const chunksDir = join(root, 'out/_next/static/chunks');
let builtCss = '';
if (existsSync(chunksDir)) {
  builtCss = readdirSync(chunksDir).filter((n) => n.endsWith('.css'))
    .map((n) => readFileSync(join(chunksDir, n), 'utf8')).join('\n');
}

const fixture = `<!doctype html><html><head><style>
html,body{margin:0;}
${shellCss}
${builtCss}
</style></head><body>
<div class="dashboard-viewport-shell">
  ${headerHtml}
  <main data-dashboard-scroll="dispatch" data-dispatch-scroll="primary" class="dispatch-scroll-main px-4 py-4">
    <div class="dispatch-workspace">
      <div class="dispatch-pane">
        <div class="dispatch-builder" id="dispatch-builder" style="min-height:720px;background:#1f2937;color:#fff;padding:12px">
          <div>PW / SW form</div>
          <button id="dispatch-form-bottom" type="button">Create Pull</button>
        </div>
        <div class="dispatch-queue" style="background:#1f2937;color:#fff">
          <div style="padding:12px">Well Queue <input placeholder="Search wells..." /><button type="button" class="dispatch-queue-toggle">Show list</button></div>
          <div class="dispatch-queue-body" style="padding:12px">
            <div class="dispatch-queue-filters">All Routes</div>
            <div style="height:640px">queue rows</div>
            <div id="dispatch-queue-bottom">final queue row</div>
          </div>
        </div>
      </div>
      <div class="dispatch-pane dispatch-pane-jobs">
        <div class="dispatch-jobs" id="dispatch-jobs" style="background:#1f2937;color:#fff;padding:12px">
          <div style="height:520px">jobs</div>
          <div id="dispatch-job-bottom">final job row</div>
        </div>
      </div>
    </div>
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

function fullyVisible(box, vh) {
  return box.top >= -1 && box.bottom <= vh + 1 && box.height > 8;
}

const browser = await chromium.launch({ headless: true });
try {
  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.setContent(fixture);
    const start = await page.evaluate(() => {
      const main = document.querySelector('[data-dispatch-scroll="primary"]');
      const header = document.querySelector('header');
      return {
        scrollTop: main.scrollTop,
        mainOverflowY: getComputedStyle(main).overflowY,
        headerH: header ? header.getBoundingClientRect().height : 0,
        formBottom: document.getElementById('dispatch-form-bottom').getBoundingClientRect().bottom,
        queueBottom: document.getElementById('dispatch-queue-bottom').getBoundingClientRect().bottom,
      };
    });
    check(`${vp.name} primary scroller is overflow-y auto/scroll`,
      start.mainOverflowY === 'auto' || start.mainOverflowY === 'scroll', start.mainOverflowY);
    check(`${vp.name} starts at scrollTop 0`, start.scrollTop === 0);
    const pad = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-dispatch-scroll="primary"]')).paddingBottom) || 0);
    check(`${vp.name} scroller has bottom safe-area padding`, pad >= 16, `paddingBottom=${pad}`);

    const stacked = vp.width < 1280 || vp.height < 900;
    const layout = await page.evaluate(() => {
      const jobs = document.getElementById('dispatch-jobs').getBoundingClientRect();
      const builder = document.getElementById('dispatch-builder').getBoundingClientRect();
      const body = getComputedStyle(document.querySelector('.dispatch-queue-body'));
      const toggle = getComputedStyle(document.querySelector('.dispatch-queue-toggle'));
      const header = document.querySelector('header');
      const hb = header ? header.getBoundingClientRect().bottom : 0;
      return {
        jobsTop: jobs.top,
        jobsLeft: jobs.left,
        builderTop: builder.top,
        builderLeft: builder.left,
        bodyDisplay: body.display,
        toggleDisplay: toggle.display,
        headerBottom: hb,
      };
    });
    if (stacked) {
      check(`${vp.name} jobs sit above the builder`, layout.jobsTop < layout.builderTop - 1,
        `jobsTop=${layout.jobsTop} builderTop=${layout.builderTop}`);
      check(`${vp.name} jobs card is on screen at top`,
        layout.jobsTop >= layout.headerBottom - 1 && layout.jobsTop < vp.height,
        `jobsTop=${layout.jobsTop} headerBottom=${layout.headerBottom}`);
      check(`${vp.name} well list starts collapsed`, layout.bodyDisplay === 'none', layout.bodyDisplay);
      check(`${vp.name} well list toggle is visible`, layout.toggleDisplay !== 'none', layout.toggleDisplay);
      const searched = await page.evaluate(() => {
        document.querySelector('.dispatch-queue').classList.add('has-search');
        return {
          body: getComputedStyle(document.querySelector('.dispatch-queue-body')).display,
          filters: getComputedStyle(document.querySelector('.dispatch-queue-filters')).display,
        };
      });
      check(`${vp.name} search shows hits without Show list`, searched.body !== 'none', searched.body);
      check(`${vp.name} search hits hide the full-list route filter`, searched.filters === 'none', searched.filters);
      await page.evaluate(() => {
        document.querySelector('.dispatch-queue').classList.remove('has-search');
        document.querySelector('.dispatch-queue').classList.add('is-expanded');
      });
    } else {
      check(`${vp.name} jobs sit to the right of the builder`, layout.jobsLeft > layout.builderLeft + 40,
        `jobsLeft=${layout.jobsLeft} builderLeft=${layout.builderLeft}`);
      check(`${vp.name} well list is expanded`, layout.bodyDisplay === 'block', layout.bodyDisplay);
      check(`${vp.name} well list toggle is hidden`, layout.toggleDisplay === 'none', layout.toggleDisplay);
    }

    await page.evaluate(() => {
      const main = document.querySelector('[data-dispatch-scroll="primary"]');
      main.dispatchEvent(new WheelEvent('wheel', { deltaY: 1800, bubbles: true, cancelable: true }));
      main.scrollBy(0, 1800);
    });
    const moved = await page.evaluate(() => document.querySelector('[data-dispatch-scroll="primary"]').scrollTop);
    check(`${vp.name} wheel/touch-style scroll changed scrollTop`, moved > 0, `scrollTop=${moved}`);

    const measure = async (id) => page.evaluate((targetId) => {
      const el = document.getElementById(targetId);
      const main = document.querySelector('[data-dispatch-scroll="primary"]');
      el.scrollIntoView({ block: 'end', inline: 'nearest' });
      main.scrollTop = Math.min(main.scrollHeight, main.scrollTop + 1);
      const box = el.getBoundingClientRect();
      const header = document.querySelector('header');
      const hb = header ? header.getBoundingClientRect().bottom : 0;
      return {
        top: box.top,
        bottom: box.bottom,
        height: box.height,
        covered: box.top < hb - 1 && box.bottom > hb,
        pageOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
      };
    }, id);

    const form = await measure('dispatch-form-bottom');
    const queue = await measure('dispatch-queue-bottom');
    const job = await measure('dispatch-job-bottom');
    check(`${vp.name} form bottom fully in view`, fullyVisible(form, vp.height),
      `top=${form.top} bottom=${form.bottom}`);
    check(`${vp.name} queue bottom fully in view`, fullyVisible(queue, vp.height),
      `top=${queue.top} bottom=${queue.bottom}`);
    check(`${vp.name} job bottom fully in view`, fullyVisible(job, vp.height),
      `top=${job.top} bottom=${job.bottom}`);
    check(`${vp.name} header does not cover form/queue/job`,
      !form.covered && !queue.covered && !job.covered);
    check(`${vp.name} no page-level horizontal clipping`, !form.pageOverflowX && !queue.pageOverflowX && !job.pageOverflowX);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
