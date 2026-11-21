import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Mount the real route while replacing only auth, navigation, and the callable.
const mocks = {
  '@/contexts/AuthContext': `const user = { uid: 'staff-a', canView: true };
    export function useAuth() { return { user: window.mode === 'guest' ? null : window.mode === 'no-role' ? { ...user, canView: false } : user, loading: false }; }`,
  '@/lib/auth': `export function hasCapability(user, capability) { return capability !== 'viewDispatch' || user?.canView === true; }`,
  '@/lib/independentDispatchJobs': `export async function independentDispatchJobs(payload) {
    window.calls.push(payload);
    if (window.mode === 'inactive') throw Error('independent_dispatch_package_inactive');
    return { ok: true, companyId: 'company-a', jobs: [] };
  }`,
  '@/components/AppHeader': `export function AppHeader() { return null; }`,
  '@/components/IndependentDispatchBoard': `export function IndependentDispatchBoard() { return <div data-testid="independent-board">Authorized board</div>; }`,
  'next/navigation': `const router = { replace(path) { window.redirects.push(path); } }; export function useRouter() { return router; }`,
  'next/link': `export default function Link({ href, children }) { return <a href={href}>{children}</a>; }`,
};
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
      import IndependentDispatchPage from './src/app/dispatch/independent/page';
      createRoot(document.getElementById('root')).render(<IndependentDispatchPage />);`,
    loader: 'tsx', resolveDir: process.cwd(),
  },
  bundle: true, write: false, jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'route-mocks', setup(plugin) {
    plugin.onResolve({ filter: /^(next\/(navigation|link)|@\/(contexts\/AuthContext|lib\/(auth|independentDispatchJobs)|components\/(AppHeader|IndependentDispatchBoard)))$/ },
      args => ({ path: args.path, namespace: 'route-mock' }));
    plugin.onLoad({ filter: /.*/, namespace: 'route-mock' }, args => ({ contents: mocks[args.path], loader: 'tsx', resolveDir: process.cwd() }));
  } }],
});
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].contents
    : `<div id="root"></div><script>window.mode=new URLSearchParams(location.search).get('mode');window.calls=[];window.redirects=[];</script><script src="/bundle.js"></script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  for (const [mode, redirect, board] of [
    ['inactive', '/dispatch', false], ['guest', '/login', false],
    ['no-role', '/dispatch', false], ['installed', null, true],
  ]) {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}`);
    if (redirect) await page.waitForFunction(() => window.redirects.length > 0);
    else await page.getByTestId('independent-board').waitFor();
    assert.deepEqual(await page.evaluate(() => window.redirects), redirect ? [redirect] : []);
    assert.equal(await page.getByTestId('independent-board').count(), Number(board));
    assert.equal(await page.getByRole('heading', { name: 'Independent Dispatch' }).count(), Number(board));
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Independent Dispatch route: no package, guest, and no-role redirect before board; installed package opens board.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
