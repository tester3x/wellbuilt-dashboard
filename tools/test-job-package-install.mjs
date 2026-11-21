import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Exercise the actual Settings card. Firestore catalog reads and the callable
// transport are mocked; no production package or company is changed here.
const mocks = {
  '@/lib/firebase': `export const getFirestoreDb = () => ({}); export const getFirebaseFunctions = () => ({});`,
  '@/lib/independentDispatchCatalog': `export const independentDispatchCatalog = { id: 'independent-dispatch', name: 'Independent Dispatch', industry: 'General', unit: 'job', icon: 'truck-delivery' };`,
  'firebase/firestore': `export const collection = () => ({}); export const getDocs = async () => ({ forEach(fn) {
    fn({ id: 'water-hauling', data: () => ({ name: 'Water Hauling', industry: 'Oil & Gas' }) });
    fn({ id: 'independent-dispatch', data: () => ({ name: 'Independent Dispatch', industry: 'General' }) });
  } });`,
  'firebase/functions': `export const httpsCallable = (_functions, name) => async payload => {
    window.calls.push({ name, payload }); return { data: { ok: true } };
  };`,
};
const bundle = await build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
    import { PackagesCard } from './src/components/settings/PackagesCard';
    const root = createRoot(document.getElementById('root'));
    window.renderPackages = activePackages => root.render(<PackagesCard
      company={{ id: 'liquid-gold', activePackages }} canEdit={true}
      onSave={() => { window.refreshes++; }} />);
    window.renderPackages(['water-hauling']);`, loader: 'tsx', resolveDir: process.cwd() },
  bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'settings-mocks', setup(plugin) {
    plugin.onResolve({ filter: /^(firebase\/(firestore|functions)|@\/lib\/(firebase|independentDispatchCatalog))$/ },
      args => ({ path: args.path, namespace: 'settings-mock' }));
    plugin.onLoad({ filter: /.*/, namespace: 'settings-mock' },
      args => ({ contents: mocks[args.path], loader: 'tsx', resolveDir: process.cwd() }));
  } }],
});
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].contents
    : `<div id="root"></div><script>window.calls=[];window.refreshes=0;</script><script src="/bundle.js"></script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('select').selectOption('independent-dispatch');
  await page.waitForFunction(() => window.refreshes === 1);
  assert.deepEqual(await page.evaluate(() => window.calls), [{ name: 'staffSetCompanyJobPackage',
    payload: { companyId: 'liquid-gold', packageId: 'independent-dispatch', action: 'install' } }]);
  await page.evaluate(() => window.renderPackages(['water-hauling', 'independent-dispatch']));
  await page.getByText('Independent Dispatch', { exact: true }).waitFor();
  await page.locator('.space-y-2 > div').filter({ hasText: 'Independent Dispatch' })
    .getByRole('button', { name: 'Remove' }).click();
  await page.waitForFunction(() => window.refreshes === 2);
  assert.deepEqual((await page.evaluate(() => window.calls))[1], { name: 'staffSetCompanyJobPackage',
    payload: { companyId: 'liquid-gold', packageId: 'independent-dispatch', action: 'remove' } });
  assert.deepEqual(errors, []);
  await page.close();
  console.log('Job Packages card installs and removes through the governed callable.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
