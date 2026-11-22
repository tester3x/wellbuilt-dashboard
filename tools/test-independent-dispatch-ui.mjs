import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Exercise the actual board/forms at desktop and phone widths. Only server transport is replaced.
const transport = `
let jobs=[]; window.requests=[];
export async function independentDispatchJobs(data){
 window.requests.push(data);
 if(data.op==='list')return {companyId:'fixture',jobs:structuredClone(jobs),wbDrivers:[{driverId:'wb-marcial',sourceCompanyId:'liquid-gold',displayName:'Nitto–Anthony (Marcial Lebaron)'}]};
 if(data.op==='create')jobs.push({...data.job,id:data.jobId,revision:1,status:'unassigned',companyId:'fixture',updatedAt:new Date().toISOString()});
 const job=jobs.find(j=>j.id===data.jobId);
 if(data.op==='update')Object.assign(job,data.job,{revision:job.revision+1});
 if(data.op==='assign')Object.assign(job,{status:'assigned',driverName:data.wbDriverId?'Nitto–Anthony (Marcial Lebaron)':'Outside Driver',externalDriverId:data.externalDriverId||'',wbDriverId:data.wbDriverId||'',driverSource:data.wbDriverId?'wellbuilt':'outside',revision:job.revision+1});
 if(data.op==='status')Object.assign(job,{status:data.status,revision:job.revision+1});
 return {ok:true,job};
}`;
const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {IndependentDispatchBoard} from './src/components/IndependentDispatchBoard';createRoot(document.getElementById('root')).render(<IndependentDispatchBoard companyId="fixture" canWrite={true} canManageDrivers={true}/>);`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'fixture', setup(b) {
  b.onResolve({ filter: /^@\/lib\/(independentDispatchJobs|independentDispatchDirectory|externalAssignmentDelivery)$/ }, a => ({ path: a.path, namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: a.path.endsWith('independentDispatchJobs') ? transport
    : a.path.endsWith('independentDispatchDirectory') ? `export const independentDispatchDirectory=async()=>({ok:true,companyId:'fixture',sectors:['water-hauling','ltl','otr','hot-shot','aggregate'],customers:[{id:'customer-a',name:'Customer A',phoneE164:'+17015550111',active:true,sectors:['water-hauling','ltl','otr','hot-shot','aggregate'],jobNames:['Pipe run'],pickupLocations:['Yard A'],deliveryLocations:['Site B']}]});`
    : `let roster=[{externalDriverId:'driver-a',displayName:'Outside Driver',phoneE164:'+17015550123',channels:['sms'],active:true}];export const listExternalDrivers=async()=>structuredClone(roster);export const listExternalDeliveries=async()=>[];export const saveExternalDriver=async(d)=>{const i=roster.findIndex(x=>x.externalDriverId===d.externalDriverId);if(i>=0)roster[i]=d;else roster.push(d);window.savedDriver=d;window.roster=structuredClone(roster);return d};export const writeExternalDelivery=async()=>{throw Error('Unexpected messaging call')};`, loader: 'js' }));
} }] });
const cssDir = 'out/_next/static/css';
const css = fs.existsSync(cssDir) ? fs.readdirSync(cssDir).filter(f => f.endsWith('.css')).map(f => fs.readFileSync(`${cssDir}/${f}`, 'utf8')).join('\n') : '';
const server = http.createServer((req,res) => { res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].contents : `<style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
 for (const width of [1280, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('New Independent Dispatch job').waitFor();
  await page.getByRole('button',{name:/Drivers Without WellBuilt Accounts/}).click();
  await page.getByPlaceholder('Driver name').fill('Isaac Hickert');
  await page.getByRole('button',{name:'Add driver'}).click();
  await page.getByText('Isaac Hickert · No phone on file').waitFor();
  assert.deepEqual(await page.evaluate(()=>({phone:window.savedDriver.phoneE164,channels:window.savedDriver.channels})),{phone:'',channels:[]});
  const originalId=await page.evaluate(()=>window.savedDriver.externalDriverId);
  await page.getByRole('button',{name:'Edit Isaac Hickert'}).click();
  await page.getByRole('textbox',{name:'Driver phone (optional)'}).fill('+17015550124');
  await page.getByRole('button',{name:'Save driver'}).click();
  await page.getByText('Isaac Hickert · +17015550124').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.savedDriver.channels),[], 'phone can be saved without opting into messaging');
  assert.equal(await page.evaluate(id=>window.roster.filter(d=>d.externalDriverId===id).length,originalId),1,'edit preserves the roster ID');
  await page.getByRole('button',{name:'Edit Isaac Hickert'}).click();
  await page.getByRole('textbox',{name:'Driver name'}).fill('Isaac H.');
  await page.getByRole('checkbox',{name:'SMS'}).check();
  await page.getByRole('checkbox',{name:'Active for new assignments'}).uncheck();
  await page.getByRole('button',{name:'Save driver'}).click();
  await page.getByText('Isaac H. · +17015550124 · sms · inactive').waitFor();
  assert.equal(await page.evaluate(id=>window.roster.find(d=>d.externalDriverId===id)?.active,originalId),false);
  await page.getByRole('textbox',{name:'Job request text'}).fill('Customer: Customer A\nSector: Water hauling\nJob: Production water run\nPickup: Yard A\nDelivery: Site B\nWater type: Production water\nBarrels: 120');
  await page.getByRole('button',{name:'Fill job form from text'}).click();
  assert.equal(await page.getByRole('combobox',{name:'Customer',exact:true}).inputValue(),'customer-a');
  assert.equal(await page.getByRole('combobox',{name:'Transportation sector',exact:true}).inputValue(),'water-hauling');
  assert.equal(await page.getByLabel('Job name *').inputValue(),'Production water run');
  assert.equal(await page.getByLabel('Estimated barrels').inputValue(),'120');
  assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.op==='create').length),0,'parsing never creates a job');
  await page.getByRole('button',{name:'Clear / new job'}).click();
  await page.getByRole('textbox',{name:'Job request text'}).fill('Customer: Unknown Co\nSector: Water hauling\nJob: Review pickup\nPickup: Yard A\nDelivery: Site B\nWater type: Production water\nBarrels: 50');
  await page.getByRole('button',{name:'Fill job form from text'}).click();
  await page.getByText(/Still needed: Customer/).waitFor();
  await page.getByRole('combobox',{name:'Customer',exact:true}).selectOption('customer-a');
  assert.equal(await page.getByLabel('Job name *').inputValue(),'Review pickup','manual customer choice retains parsed fields');
  assert.equal(await page.getByRole('combobox',{name:'Transportation sector',exact:true}).inputValue(),'water-hauling');
  assert.equal(await page.getByLabel('Estimated barrels').inputValue(),'50');
  await page.getByRole('button',{name:'Clear / new job'}).click();
  const sectors = [
    ['water-hauling', [['Water type *', 'Production water'], ['Estimated barrels *', '120']]],
    ['ltl', [['Freight description *', 'Palletized parts'], ['Pieces *', '12']]],
    ['otr', [['Trailer type *', 'Dry van'], ['Commodity *', 'Equipment']]],
    ['hot-shot', [['Urgency *', 'Same day'], ['Cargo and dimensions *', 'Pump skid']]],
    ['aggregate', [['Material *', 'Gravel'], ['Estimated tons *', '24']]],
  ];
  for (const [sector, fields] of sectors) {
    await page.getByRole('combobox',{name:'Customer',exact:true}).selectOption('customer-a');
    await page.getByRole('combobox',{name:'Transportation sector',exact:true}).selectOption(sector);
    for (const [label, value] of fields) {
      const field = page.getByLabel(label.replace(/ \*$/, ''),{exact:true});
      if (['Water type *','Trailer type *','Urgency *','Material *'].includes(label)) await field.selectOption({label:value});
      else await field.fill(value);
    }
    for (const [label,value] of [['Job name',`Pipe run ${sector}`],['Pickup address / location','Yard A'],['Delivery address / location','Site B']]) await page.getByLabel(label + ' *',{exact:true}).fill(value);
    await page.getByRole('button',{name:'Create job',exact:true}).click();
    await page.getByRole('article').filter({hasText:`Pipe run ${sector}`}).waitFor();
  }
  const card=page.getByRole('article').filter({hasText:'Pipe run water-hauling'});
  await card.waitFor();
  await card.getByRole('combobox').selectOption('outside:driver-a');
  await card.getByRole('button',{name:'Assign',exact:true}).click();
  const firstJobId = await page.evaluate(() => window.requests.find(request => request.op === 'create').jobId);
  assert.equal(await card.getByRole('link',{name:'Call customer in Dialpad'}).getAttribute('href'),
    `dialpad://+17015550111?confirmPhone=1&customData=wellbuilt-independent%3A${firstJobId}`);
  assert.ok((await card.getByRole('link',{name:'Call driver in Dialpad'}).getAttribute('href'))?.startsWith('dialpad://+17015550123?confirmPhone=1&customData='));
  const linkedCard=page.getByRole('article').filter({hasText:'Pipe run ltl'});
  await linkedCard.getByRole('combobox').selectOption('wellbuilt:wb-marcial');
  await linkedCard.getByRole('button',{name:'Assign',exact:true}).click();
  assert.equal(await linkedCard.getByText('WellBuilt account',{exact:false}).count(),1);
  assert.equal(await page.evaluate(()=>window.requests.find(r=>r.op==='assign'&&r.wbDriverId)?.wbDriverId),'wb-marcial');
  assert.equal(await linkedCard.getByRole('link',{name:'Call driver in Dialpad'}).count(),0);
  await card.getByRole('button',{name:'Mark started',exact:true}).click();
  assert.equal(await card.getByRole('button',{name:'Edit',exact:true}).count(),0);
  await card.getByRole('button',{name:'Mark completed',exact:true}).click();
  await card.waitFor({state:'detached'});
  await page.getByRole('combobox',{name:'Job status',exact:true}).selectOption('completed');
  await card.waitFor();
  assert.equal(await card.getByRole('button').count(),0);
  assert.deepEqual(await page.evaluate(()=>window.requests.filter(r=>r.op==='create').map(r=>r.job.sector)),sectors.map(([sector])=>sector));
  assert.deepEqual(errors,[]);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow');
  await page.close();
 }
 console.log('Independent Dispatch actual UI: five sector forms, customer selection, assign/start/complete, filters, terminal lock; desktop/mobile; no messaging.');
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
