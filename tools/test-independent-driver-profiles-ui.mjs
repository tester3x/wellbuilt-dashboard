import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ stdin: { contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {IndependentDriverProfilesPanel} from './src/components/IndependentDriverProfilesPanel';function View(){const [drivers,setDrivers]=useState([{externalDriverId:'outside-a',displayName:'Outside A',phoneE164:'',active:true}]);return <IndependentDriverProfilesPanel initiallyOpen drivers={drivers} onRosterChange={setDrivers} wbDrivers={[{driverId:'wb-a',displayName:'Linked A',active:true}]} customers={[{id:'customer-a',name:'Customer A'}]}/>};createRoot(document.getElementById('root')).render(<View/>);`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'profile-transport', setup(plugin) {
  plugin.onResolve({ filter: /^@\/lib\/independentDriverProfiles$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `let profiles=[];window.savedProfiles=profiles;export const listIndependentDriverProfiles=async()=>structuredClone(profiles);export const saveIndependentDriverProfile=async(p,revision)=>{const previous=profiles.find(x=>x.driverKey===p.driverKey);if((previous?.revision||0)!==revision)throw Error('revision_conflict');const saved={...p,revision:revision+1};profiles=profiles.filter(x=>x.driverKey!==p.driverKey).concat(saved);window.savedProfiles=profiles;return saved};` }));
  plugin.onResolve({ filter: /^@\/lib\/externalAssignmentDelivery$/ }, args => ({ path: args.path, namespace: 'external-fixture' }));
  plugin.onLoad({ filter: /.*/, namespace: 'external-fixture' }, () => ({ loader: 'js', contents: `let roster=[{externalDriverId:'outside-a',displayName:'Outside A',phoneE164:'',channels:[],active:true}];window.rosterSaves=0;export const saveExternalDriver=async(d)=>{window.rosterSaves++;const i=roster.findIndex(x=>x.externalDriverId===d.externalDriverId);const saved={...d,companyId:'fixture'};if(i>=0)roster[i]=saved;else roster.push(saved);window.savedDriver=saved;window.roster=structuredClone(roster);return saved};` }));
} }] });
const routeBundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import IndependentDispatchDriversPage from './src/app/dispatch/independent/drivers/page';createRoot(document.getElementById('root')).render(<IndependentDispatchDriversPage/>);`, loader: 'tsx', resolveDir: process.cwd() },
  bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'route-transport', setup(plugin) {
    plugin.onResolve({ filter: /^(next\/navigation|@\/contexts\/AuthContext|@\/lib\/auth|@\/components\/AppHeader|@\/components\/IndependentDriverProfilesPanel|@\/lib\/independentDispatchJobs|@\/lib\/independentDispatchDirectory|@\/lib\/externalAssignmentDelivery)$/ }, args => ({ path: args.path, namespace: 'route-fixture' }));
    plugin.onLoad({ filter: /.*/, namespace: 'route-fixture' }, args => ({ loader: 'js', resolveDir: process.cwd(), contents: {
      'next/navigation': `const router={replace(path){window.redirects.push(path)}};export const useRouter=()=>router;`,
      '@/contexts/AuthContext': `export const useAuth=()=>({user:{uid:'manager'},loading:false});`,
      '@/lib/auth': `export const hasCapability=(_,cap)=>window.capabilities.includes(cap);`,
      '@/components/AppHeader': `export const AppHeader=()=>null;`,
      '@/components/IndependentDriverProfilesPanel': `import React from 'react';export const IndependentDriverProfilesPanel=()=>React.createElement('div',{'data-testid':'profiles-panel'},'Profiles loaded');`,
      '@/lib/independentDispatchJobs': `export const independentDispatchJobs=async()=>({companyId:'fixture',wbDrivers:[]});`,
      '@/lib/independentDispatchDirectory': `export const independentDispatchDirectory=async()=>({companyId:'fixture',customers:[]});`,
      '@/lib/externalAssignmentDelivery': `export const listExternalDrivers=async()=>[];`,
    }[args.path] }));
  } }] });
const server = http.createServer((req, res) => {
  const route = req.url?.startsWith('/route');
  const script = route ? routeBundle.outputFiles[0].contents : bundle.outputFiles[0].contents;
  res.setHeader('Content-Type', req.url?.endsWith('bundle.js') ? 'text/javascript' : 'text/html');
  res.end(req.url?.endsWith('bundle.js') ? script : route
    ? '<div id="root"></div><script>window.redirects=[];window.capabilities=new URLSearchParams(location.search).get("mode")==="manager"?["viewDispatch","manageDrivers"]:["viewDispatch"];</script><script src="/route-bundle.js"></script>'
    : '<div id="root"></div><script src="/bundle.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('combobox', { name: 'Driver profile' }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Has a WellBuilt account' }).count(), 0, 'account source does not filter the roster');
  assert.equal(await page.getByRole('textbox', { name: 'Driver phone (international format)' }).count(), 0, 'no driver selected yet');
  assert.equal(await page.getByRole('combobox', { name: 'Driver profile' }).locator('option').count(), 3, 'outside and WellBuilt drivers share one list');
  await page.getByRole('button', { name: 'Add driver' }).click();
  await page.getByText('Independent driver', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Driver name' }).fill('Michael Test');
  await page.getByRole('combobox', { name: 'Usual shift' }).selectOption('night');
  await page.getByRole('textbox', { name: 'Driver phone (international format)' }).fill('+17015550124');
  await page.getByRole('textbox', { name: 'WhatsApp name (optional)' }).fill('Michael on WhatsApp');
  await page.getByRole('button', { name: 'Save driver profile' }).click();
  await page.getByText('Driver profile saved. Operator review notes remain nonbinding.').waitFor();
  const newDriverId = await page.evaluate(() => window.savedDriver.externalDriverId);
  assert.deepEqual(await page.evaluate(id => {
    const saved = window.savedProfiles.find(profile => profile.driverKey === `outside:${id}`);
    return { phone: saved?.phoneE164, whatsappName: saved?.whatsappName, shift: saved?.shiftPreference };
  }, newDriverId), { phone: '+17015550124', whatsappName: 'Michael on WhatsApp', shift: 'night' });
  await page.getByRole('combobox', { name: 'Driver profile' }).selectOption(`outside:${newDriverId}`);
  await page.getByRole('heading', { name: 'Michael Test' }).waitFor();
  await page.getByRole('textbox', { name: 'Driver name' }).fill('Michael T.');
  await page.getByRole('combobox', { name: 'Usual shift' }).selectOption('day');
  await page.getByRole('checkbox', { name: 'Active for new assignments' }).uncheck();
  await page.getByRole('button', { name: 'Save driver profile' }).click();
  await page.waitForFunction(id => document.querySelector(`select[aria-label="Driver profile"] option[value="outside:${id}"]`)?.textContent === 'Michael T. · Independent · inactive', newDriverId);
  assert.equal(await page.evaluate(id => window.roster.filter(driver => driver.externalDriverId === id).length, newDriverId), 1, 'editing keeps the roster ID');
  assert.equal(await page.evaluate(id => window.roster.find(driver => driver.externalDriverId === id)?.shiftPreference, newDriverId), 'day');
  await page.getByRole('button', { name: 'Add driver' }).click();
  const accountCheck = page.getByRole('checkbox', { name: 'Has a WellBuilt account' });
  assert.equal(await accountCheck.isChecked(), false, 'new driver begins as independent until a linked account is chosen');
  await accountCheck.check();
  await page.getByRole('combobox', { name: 'Linked WellBuilt driver' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Driver name' }).evaluate(input => input.closest('fieldset')?.disabled), true, 'independent form is disabled for linked account selection');
  assert.equal(await page.evaluate(() => window.rosterSaves), 2, 'checking the account box does not create a driver');
  await page.getByRole('combobox', { name: 'Linked WellBuilt driver' }).selectOption('wellbuilt:wb-a');
  await page.getByText('Linked WellBuilt account', { exact: true }).waitFor();
  assert.equal(await accountCheck.isChecked(), true);
  assert.equal(await accountCheck.isDisabled(), true, 'existing verified link is shown without allowing a false toggle');
  assert.equal(await page.getByRole('button', { name: 'Add driver' }).count(), 1, 'add action stays available beside the shared list');
  await page.getByRole('textbox', { name: 'Driver phone (international format)' }).fill('+17015550123');
  await page.getByRole('textbox', { name: 'WhatsApp name (optional)' }).fill('Marcial WA');
  await page.getByRole('combobox', { name: 'Usual shift' }).selectOption('day');
  await page.getByRole('combobox', { name: 'Primary customer' }).selectOption('customer-a');
  await page.getByRole('button', { name: 'Save driver profile' }).click();
  await page.getByText('Driver profile saved. Operator review notes remain nonbinding.').waitFor();
  assert.equal(await page.evaluate(() => window.rosterSaves), 2, 'linked profile does not create an outside driver');
  assert.deepEqual(await page.evaluate(() => { const profile = window.savedProfiles.find(item => item.driverKey === 'wellbuilt:wb-a'); return { key: profile.driverKey, shift: profile.shiftPreference,
    phone: profile.phoneE164, whatsappName: profile.whatsappName }; }),
    { key: 'wellbuilt:wb-a', shift: 'day', phone: '+17015550123', whatsappName: 'Marcial WA' });
  await page.getByRole('combobox', { name: 'Driver profile' }).selectOption('outside:outside-a');
  assert.equal(await page.getByRole('combobox', { name: 'Usual shift' }).count(), 1, 'outside shift uses the same form');
  assert.equal(await accountCheck.isChecked(), false);
  assert.deepEqual(errors, []);
  for (const [mode, target] of [['manager', null], ['denied', '/dispatch/independent']]) {
    const routePage = await browser.newPage();
    const routeErrors = []; routePage.on('pageerror', error => routeErrors.push(error.message));
    await routePage.goto(`http://127.0.0.1:${server.address().port}/route?mode=${mode}`);
    if (target) await routePage.waitForFunction(() => window.redirects.length > 0);
    else await routePage.getByTestId('profiles-panel').waitFor();
    assert.deepEqual(await routePage.evaluate(() => window.redirects), target ? [target] : [], `${mode} profile route access`);
    assert.deepEqual(routeErrors, []);
    await routePage.close();
  }
  console.log('Independent Dispatch driver profiles: one roster, account checkbox inside Add form, verified source retained.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
