// Render the real header with synthetic authentication; never reads live accounts.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { chromium } = require('playwright');
function load(file, dependencies) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const result = { exports: {} };
  new Function('require', 'module', 'exports', code)(id => id in dependencies ? dependencies[id] : require(id), result, result.exports);
  return result.exports;
}
const tabs = load('src/lib/tabs.ts', {});
const { AppHeader } = load('src/components/AppHeader.tsx', {
  'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
  'next/navigation': { usePathname: () => '/admin', useRouter: () => ({}) },
  'firebase/database': {},
  '@/contexts/AuthContext': { useAuth: () => ({ user: { uid: 'fixture', email: 'test@example.com', role: 'admin' }, signOut: async () => {} }) },
  '@/lib/tabs': tabs,
  '@/lib/auth': { getRoleLabel: () => 'Owner', hasCapability: () => true, hasEQuipmentAccess: () => true, hasRole: () => true },
  './NotificationBell': { NotificationBell: () => React.createElement('button', null, 'Alerts') },
  './chat/ChatIcon': { ChatIcon: () => React.createElement('button', null, 'Chat') },
  './chat/ChatSidebar': { ChatSidebar: () => null },
  '@/lib/firebase': {},
});
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const css = fs.readdirSync('out/_next/static/chunks').filter(n => n.endsWith('.css')).map(n => fs.readFileSync(path.join('out/_next/static/chunks', n), 'utf8')).join('\n');
    await page.setContent(`<style>${css}</style>${renderToStaticMarkup(React.createElement(AppHeader))}`);
    for (const width of [320, 390, 768, 800, 1024, 1600]) {
      await page.setViewportSize({ width, height: 900 });
      const metrics = await page.evaluate(() => {
        const title = document.querySelector('h1').getBoundingClientRect();
        const nav = document.querySelector('nav').getBoundingClientRect();
        const utilities = document.querySelector('[aria-label="Chat and notifications"]').getBoundingClientRect();
        const clipped = [...document.querySelectorAll('header a, header button')].some(el => { const r = el.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth + 1; });
        return { overflow: document.documentElement.scrollWidth > innerWidth, clipped, rightInset: innerWidth - utilities.right, titleOffset: Math.abs(title.x + title.width / 2 - innerWidth / 2), navOffset: Math.abs(nav.x + nav.width / 2 - innerWidth / 2) };
      });
      console.log(width, metrics);
      if (metrics.overflow || metrics.clipped || metrics.titleOffset > 1 || metrics.navOffset > 1 || metrics.rightInset > 16) throw new Error(`Header layout failed at ${width}`);
      if (width === 800) await page.screenshot({ path: path.join(require('os').tmpdir(), 'wb-header-800-qa.png') });
    }
    const adminSource = fs.readFileSync('src/app/admin/page.tsx', 'utf8');
    const setter = adminSource.match(/const setActiveTab = \(tab: AdminTab\) => \{([\s\S]*?)\n  \};/)[1];
    await page.route('https://header-fixture.invalid/**', route => route.fulfill({ body: '<html></html>', contentType: 'text/html' }));
    await page.goto('https://header-fixture.invalid/admin?existing=keep#anchor');
    for (const tab of ['drivers', 'companies', 'equipment', 'wells']) {
      await page.evaluate(({ setter, tab }) => new Function('setActiveTabState', 'tab', setter)(() => {}, tab), { setter, tab });
      await page.reload();
      const current = new URL(page.url());
      if (current.pathname !== '/admin' || current.searchParams.get('tab') !== tab || current.searchParams.get('existing') !== 'keep' || current.hash !== '#anchor') throw new Error(`Refresh lost ${tab}`);
    }
    console.log('Admin section URLs survive reload; other query parameters and fragment preserved.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
