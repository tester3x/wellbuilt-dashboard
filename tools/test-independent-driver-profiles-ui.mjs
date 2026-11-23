import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {IndependentDriverProfilesPanel} from './src/components/IndependentDriverProfilesPanel';createRoot(document.getElementById('root')).render(<IndependentDriverProfilesPanel initiallyOpen drivers={[{externalDriverId:'outside-a',displayName:'Outside A',active:true}]} wbDrivers={[{driverId:'wb-a',displayName:'Linked A',active:true}]} customers={[{id:'customer-a',name:'Customer A'}]}/>);`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'profile-transport', setup(plugin) {
  plugin.onResolve({ filter: /^@\/lib\/independentDriverProfiles$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `let profiles=[];window.savedProfiles=profiles;export const listIndependentDriverProfiles=async()=>structuredClone(profiles);export const saveIndependentDriverProfile=async(p,revision)=>{const previous=profiles.find(x=>x.driverKey===p.driverKey);if((previous?.revision||0)!==revision)throw Error('revision_conflict');const saved={...p,revision:revision+1};profiles=profiles.filter(x=>x.driverKey!==p.driverKey).concat(saved);window.savedProfiles=profiles;return saved};` }));
} }] });
const server = http.createServer((req, res) => { res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].contents : '<div id="root"></div><script src="/bundle.js"></script>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('combobox', { name: 'Driver profile' }).selectOption('wellbuilt:wb-a');
  await page.getByRole('combobox', { name: 'Usual shift' }).selectOption('day');
  await page.getByRole('combobox', { name: 'Primary customer' }).selectOption('customer-a');
  await page.getByRole('button', { name: 'Save driver profile' }).click();
  await page.getByText('Driver profile saved. Operator review notes remain nonbinding.').waitFor();
  assert.deepEqual(await page.evaluate(() => ({ key: window.savedProfiles[0].driverKey, shift: window.savedProfiles[0].shiftPreference })),
    { key: 'wellbuilt:wb-a', shift: 'day' });
  await page.getByRole('combobox', { name: 'Driver profile' }).selectOption('outside:outside-a');
  assert.equal(await page.getByRole('combobox', { name: 'Usual shift' }).count(), 0, 'outside shift preference remains in the roster');
  assert.deepEqual(errors, []);
  console.log('Independent Dispatch driver profile editor: linked shift preference and outside roster separation.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
