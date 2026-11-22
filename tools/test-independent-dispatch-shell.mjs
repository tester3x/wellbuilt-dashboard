import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {IndependentDispatchRouteGate} from './src/components/IndependentDispatchRouteGate';createRoot(document.getElementById('root')).render(<IndependentDispatchRouteGate><div data-testid="workspace">Mounted workspace</div></IndependentDispatchRouteGate>);`, loader: 'tsx', resolveDir: process.cwd() },
  bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'route-fixture', setup(plugin) {
    plugin.onResolve({ filter: /^(@\/contexts\/AuthContext|next\/navigation)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'next/navigation'
      ? `const router={replace(path){window.redirects.push(path)}};export const useRouter=()=>router;export const usePathname=()=>location.pathname;`
      : `export function useAuth(){return {user:{uid:'owner',companyId:'company-a'},userCompany:window.mode==='missing'?null:window.mode==='free'?{id:'company-a',ownerUid:'owner',wellbuiltContract:{planId:'free-company-a'},activePackages:[]}:{activePackages:window.mode==='dual'?['independent-dispatch','water-hauling']:['independent-dispatch']},authResolved:window.mode!=='loading'}};` }));
  } }],
});
const server = http.createServer((req, res) => { res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].contents : `<div id="root"></div><script>window.mode=new URLSearchParams(location.search).get('mode');window.redirects=[];</script><script src="/bundle.js"></script>`); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  for (const [route, mode, mounted, target] of [
    ['/', 'only', false, '/dispatch/independent'], ['/dispatch', 'only', false, '/dispatch/independent'], ['/tickets', 'only', false, '/dispatch/independent'],
    ['/dispatch/independent', 'only', true, null], ['/settings', 'only', true, null],
    ['/', 'free', false, '/welcome'], ['/tickets', 'free', false, '/welcome'],
    ['/welcome', 'free', true, null], ['/equipment', 'free', true, null], ['/safety', 'free', true, null], ['/settings', 'free', true, null],
    ['/tickets', 'dual', true, null], ['/dispatch/independent', 'loading', false, null],
    ['/dispatch/independent', 'missing', false, null],
  ]) {
    const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}${route}?mode=${mode}`);
    if (target) await page.waitForFunction(() => window.redirects.length > 0);
    else await page.getByText(mounted ? 'Mounted workspace' : mode === 'missing'
      ? 'Company workspace unavailable. Refresh this page to try again.' : 'Loading company workspace…').waitFor();
    assert.equal(await page.getByTestId('workspace').count(), Number(mounted), `${mode} ${route} content gate`);
    assert.deepEqual(await page.evaluate(() => window.redirects), target ? [target] : [], `${mode} ${route} redirect`);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Company workspace shell: Independent Dispatch and new free owners reach only their available routes; mixed packages preserved.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
