import assert from 'node:assert/strict';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ stdin: { contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {IndependentDriverProfilesPanel} from './src/components/IndependentDriverProfilesPanel';import {ExternalAssignmentDeliveryPanel} from './src/components/ExternalAssignmentDeliveryPanel';import {listExternalDrivers} from '@/lib/externalAssignmentDelivery';function View(){const [drivers,setDrivers]=useState([{externalDriverId:'outside-a',displayName:'Outside A',phoneE164:'',active:true}]);return <><ExternalAssignmentDeliveryPanel jobs={[]} canManage rosterOnly initiallyExpanded onRosterChange={async()=>setDrivers(await listExternalDrivers())}/><IndependentDriverProfilesPanel initiallyOpen drivers={drivers} wbDrivers={[{driverId:'wb-a',displayName:'Linked A',active:true}]} customers={[{id:'customer-a',name:'Customer A'}]}/></>};createRoot(document.getElementById('root')).render(<View/>);`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'profile-transport', setup(plugin) {
  plugin.onResolve({ filter: /^@\/lib\/independentDriverProfiles$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `let profiles=[];window.savedProfiles=profiles;export const listIndependentDriverProfiles=async()=>structuredClone(profiles);export const saveIndependentDriverProfile=async(p,revision)=>{const previous=profiles.find(x=>x.driverKey===p.driverKey);if((previous?.revision||0)!==revision)throw Error('revision_conflict');const saved={...p,revision:revision+1};profiles=profiles.filter(x=>x.driverKey!==p.driverKey).concat(saved);window.savedProfiles=profiles;return saved};` }));
  plugin.onResolve({ filter: /^@\/lib\/externalAssignmentDelivery$/ }, args => ({ path: args.path, namespace: 'external-fixture' }));
  plugin.onLoad({ filter: /.*/, namespace: 'external-fixture' }, () => ({ loader: 'js', contents: `let roster=[{externalDriverId:'outside-a',displayName:'Outside A',phoneE164:'',channels:[],active:true}];export const listExternalDrivers=async()=>structuredClone(roster);export const listExternalDeliveries=async()=>[];export const saveExternalDriver=async(d)=>{const i=roster.findIndex(x=>x.externalDriverId===d.externalDriverId);if(i>=0)roster[i]=d;else roster.push(d);window.savedDriver=d;window.roster=structuredClone(roster);return d};export const writeExternalDelivery=async()=>{throw Error('Unexpected delivery')};` }));
} }] });
const routeBundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import IndependentDispatchDriversPage from './src/app/dispatch/independent/drivers/page';createRoot(document.getElementById('root')).render(<IndependentDispatchDriversPage/>);`, loader: 'tsx', resolveDir: process.cwd() },
  bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'route-transport', setup(plugin) {
    plugin.onResolve({ filter: /^(next\/navigation|@\/contexts\/AuthContext|@\/lib\/auth|@\/components\/AppHeader|@\/components\/IndependentDriverProfilesPanel|@\/components\/ExternalAssignmentDeliveryPanel|@\/lib\/independentDispatchJobs|@\/lib\/independentDispatchDirectory|@\/lib\/externalAssignmentDelivery)$/ }, args => ({ path: args.path, namespace: 'route-fixture' }));
    plugin.onLoad({ filter: /.*/, namespace: 'route-fixture' }, args => ({ loader: 'js', resolveDir: process.cwd(), contents: {
      'next/navigation': `const router={replace(path){window.redirects.push(path)}};export const useRouter=()=>router;`,
      '@/contexts/AuthContext': `export const useAuth=()=>({user:{uid:'manager'},loading:false});`,
      '@/lib/auth': `export const hasCapability=(_,cap)=>window.capabilities.includes(cap);`,
      '@/components/AppHeader': `export const AppHeader=()=>null;`,
      '@/components/IndependentDriverProfilesPanel': `import React from 'react';export const IndependentDriverProfilesPanel=()=>React.createElement('div',{'data-testid':'profiles-panel'},'Profiles loaded');`,
      '@/components/ExternalAssignmentDeliveryPanel': `import React from 'react';export const ExternalAssignmentDeliveryPanel=()=>React.createElement('div',{'data-testid':'roster-panel'},'Outside roster loaded');`,
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
  await page.getByRole('button', { name: /Drivers Without WellBuilt Accounts \(1\)/ }).waitFor();
  await page.getByRole('textbox', { name: 'Driver name' }).fill('Michael Test');
  await page.getByRole('combobox', { name: 'Shift preference' }).selectOption('night');
  await page.getByRole('button', { name: 'Add driver' }).click();
  await page.getByText('Michael Test · No phone on file').waitFor();
  const newDriverId = await page.evaluate(() => window.savedDriver.externalDriverId);
  await page.getByRole('combobox', { name: 'Driver profile' }).selectOption(`outside:${newDriverId}`);
  await page.getByRole('heading', { name: 'Michael Test' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Driver phone (optional)' }).count(), 0, 'phone is edited in the driver profile only');
  await page.getByRole('button', { name: 'Edit Michael Test' }).click();
  await page.getByRole('combobox', { name: 'Shift preference' }).selectOption('day');
  await page.getByRole('checkbox', { name: 'Active for new assignments' }).uncheck();
  await page.getByRole('button', { name: 'Save driver', exact: true }).click();
  await page.getByText('Michael Test · No phone on file · inactive').waitFor();
  assert.equal(await page.evaluate(id => window.roster.filter(driver => driver.externalDriverId === id).length, newDriverId), 1, 'editing keeps the roster ID');
  await page.getByRole('textbox', { name: 'Driver phone (international format)' }).fill('+17015550124');
  await page.getByRole('textbox', { name: 'WhatsApp name (optional)' }).fill('Michael on WhatsApp');
  await page.getByRole('button', { name: 'Save driver profile' }).click();
  await page.getByText('Driver profile saved. Operator review notes remain nonbinding.').waitFor();
  assert.deepEqual(await page.evaluate(id => {
    const saved = window.savedProfiles.find(profile => profile.driverKey === `outside:${id}`);
    return { phone: saved?.phoneE164, whatsappName: saved?.whatsappName };
  }, newDriverId), { phone: '+17015550124', whatsappName: 'Michael on WhatsApp' });
  await page.getByRole('combobox', { name: 'Driver profile' }).selectOption('wellbuilt:wb-a');
  await page.getByRole('textbox', { name: 'Driver phone (international format)' }).fill('+17015550123');
  await page.getByRole('textbox', { name: 'WhatsApp name (optional)' }).fill('Marcial WA');
  await page.getByRole('combobox', { name: 'Usual shift' }).selectOption('day');
  await page.getByRole('combobox', { name: 'Primary customer' }).selectOption('customer-a');
  await page.getByRole('button', { name: 'Save driver profile' }).click();
  await page.getByText('Driver profile saved. Operator review notes remain nonbinding.').waitFor();
  assert.deepEqual(await page.evaluate(() => { const profile = window.savedProfiles.find(item => item.driverKey === 'wellbuilt:wb-a'); return { key: profile.driverKey, shift: profile.shiftPreference,
    phone: profile.phoneE164, whatsappName: profile.whatsappName }; }),
    { key: 'wellbuilt:wb-a', shift: 'day', phone: '+17015550123', whatsappName: 'Marcial WA' });
  await page.getByRole('combobox', { name: 'Driver profile' }).selectOption('outside:outside-a');
  assert.equal(await page.getByRole('combobox', { name: 'Usual shift' }).count(), 0, 'outside shift preference remains in the roster');
  assert.deepEqual(errors, []);
  for (const [mode, target] of [['manager', null], ['denied', '/dispatch/independent']]) {
    const routePage = await browser.newPage();
    const routeErrors = []; routePage.on('pageerror', error => routeErrors.push(error.message));
    await routePage.goto(`http://127.0.0.1:${server.address().port}/route?mode=${mode}`);
    if (target) await routePage.waitForFunction(() => window.redirects.length > 0);
    else { await routePage.getByTestId('profiles-panel').waitFor(); await routePage.getByTestId('roster-panel').waitFor(); }
    assert.deepEqual(await routePage.evaluate(() => window.redirects), target ? [target] : [], `${mode} profile route access`);
    assert.deepEqual(routeErrors, []);
    await routePage.close();
  }
  console.log('Independent Dispatch driver profiles: outside roster add/edit, live profile picker, linked contacts and route access.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
