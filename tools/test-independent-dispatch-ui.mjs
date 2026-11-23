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
 if(data.op==='list')return {companyId:'fixture',jobs:structuredClone(jobs),wbDrivers:[{driverId:'wb-marcial',sourceCompanyId:'liquid-gold',displayName:'Nitto–Anthony (Marcial Lebaron)',active:true},{driverId:'wb-luiz',sourceCompanyId:'liquid-gold',displayName:'Luiz Lebaron',active:true}]};
 if(data.op==='create')jobs.push({...data.job,id:data.jobId,revision:1,status:'unassigned',companyId:'fixture',updatedAt:new Date().toISOString()});
 const job=jobs.find(j=>j.id===data.jobId);
 if(data.op==='update')Object.assign(job,data.job,{revision:job.revision+1});
 if(data.op==='assign'||data.op==='addDriver'||data.op==='replaceDriver'){
  const driver={key:data.wbDriverId?'wellbuilt:'+data.wbDriverId:'outside:'+data.externalDriverId,name:data.wbDriverId?'Nitto–Anthony (Marcial Lebaron)':data.externalDriverId==='driver-a'?'Outside Driver':'Driver '+data.externalDriverId.slice(-1).toUpperCase(),source:data.wbDriverId?'wellbuilt':'outside',shift:data.shift||'',assignedAt:new Date().toISOString()};
  const crew=job.drivers||[]; const next=data.op==='replaceDriver'?crew.map(d=>d.key===data.driverKey?driver:d):data.op==='assign'?[driver]:[...crew,driver];
  Object.assign(job,{status:job.status==='unassigned'?'assigned':job.status,drivers:next,driverName:next[0].name,externalDriverId:next[0].source==='outside'?next[0].key.slice(8):'',wbDriverId:next[0].source==='wellbuilt'?next[0].key.slice(10):'',driverSource:next[0].source,revision:job.revision+1});
 }
 if(data.op==='addDrivers'){
  const added=data.drivers.map(d=>({key:d.key,name:d.key.startsWith('wellbuilt:')?'Nitto–Anthony (Marcial Lebaron)':d.key==='outside:driver-a'?'Outside Driver':'Driver '+d.key.slice(-1).toUpperCase(),source:d.key.startsWith('wellbuilt:')?'wellbuilt':'outside',shift:d.shift,assignedAt:new Date().toISOString()}));
  const next=[...(job.drivers||[]),...added];
  Object.assign(job,{status:job.status==='unassigned'?'assigned':job.status,drivers:next,driverName:next[0].name,externalDriverId:next[0].source==='outside'?next[0].key.slice(8):'',wbDriverId:next[0].source==='wellbuilt'?next[0].key.slice(10):'',driverSource:next[0].source,revision:job.revision+1});
 }
 if(data.op==='removeDriver'){const next=job.drivers.filter(d=>d.key!==data.driverKey);Object.assign(job,{drivers:next,status:next.length?job.status:'unassigned',driverName:next[0]?.name||'',externalDriverId:next[0]?.source==='outside'?next[0].key.slice(8):'',wbDriverId:next[0]?.source==='wellbuilt'?next[0].key.slice(10):'',revision:job.revision+1});}
 if(data.op==='setDriverShift'){job.drivers=job.drivers.map(d=>d.key===data.driverKey?{...d,shift:data.shift}:d);job.revision+=1;}
 if(data.op==='status')Object.assign(job,{status:data.status,revision:job.revision+1});
 return {ok:true,job};
}`;
const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {IndependentDispatchBoard} from './src/components/IndependentDispatchBoard';createRoot(document.getElementById('root')).render(<IndependentDispatchBoard companyId="fixture" canWrite={true} canManageDrivers={true}/>);`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'fixture', setup(b) {
  b.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'next/link', namespace: 'fixture-link' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture-link' }, () => ({ contents: `import React from 'react';export default function Link({href,children,...props}){return React.createElement('a',{href,...props},children)}`, loader: 'js', resolveDir: process.cwd() }));
  b.onResolve({ filter: /^@\/lib\/(independentDispatchJobs|independentDispatchDirectory|externalAssignmentDelivery|independentDriverProfiles)$/ }, a => ({ path: a.path, namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: a.path.endsWith('independentDispatchJobs') ? transport
    : a.path.endsWith('independentDispatchDirectory') ? `export const independentDispatchDirectory=async()=>({ok:true,companyId:'fixture',sectors:['water-hauling','ltl','otr','hot-shot','aggregate'],communicationChannels:['sms'],dispatchPhoneE164:'+17015550100',customers:[{id:'customer-a',name:'Customer A',phoneE164:'+17015550111',active:true,sectors:['water-hauling','ltl','otr','hot-shot','aggregate'],contacts:[{id:'john',name:'John Wick',role:'Company man',phoneE164:'+17015550112'},{id:'jane',name:'Jane Doe',role:'Lead',phoneE164:'+17015550113'}],workCategories:[{id:'rig-work',name:'Rig Work',sector:'water-hauling',sourceChannels:['Rig Work chat'],assets:['Rig 429']}],jobNames:['Pipe run'],pickupLocations:['Yard A'],deliveryLocations:['Site B']},{id:'bob',name:"Bob's Hot Shot LLC",alternateNames:["Bob's",'BHS'],phoneE164:'',active:true,sectors:['hot-shot'],jobNames:[],pickupLocations:[],deliveryLocations:[]}]});`
    : a.path.endsWith('independentDriverProfiles') ? `let profiles=[];window.savedProfiles=profiles;export const listIndependentDriverProfiles=async()=>structuredClone(profiles);export const saveIndependentDriverProfile=async(p,expectedRevision)=>{const previous=profiles.find(x=>x.driverKey===p.driverKey);if((previous?.revision||0)!==expectedRevision)throw Error('revision_conflict');const saved={...p,companyId:'fixture',revision:expectedRevision+1,updatedAt:new Date().toISOString(),updatedBy:'fixture'};profiles=profiles.filter(x=>x.driverKey!==p.driverKey).concat(saved);window.savedProfiles=profiles;return saved};`
    : `let roster=[{externalDriverId:'driver-a',displayName:'Outside Driver',phoneE164:'+17015550123',channels:['sms'],active:true},...['b','c','d','e','f'].map(x=>({externalDriverId:'driver-'+x,displayName:'Driver '+x.toUpperCase(),phoneE164:'',channels:[],active:true,shiftPreference:x==='b'?'night':undefined}))];export const listExternalDrivers=async()=>structuredClone(roster);export const listExternalDeliveries=async()=>[];export const saveExternalDriver=async(d)=>{const i=roster.findIndex(x=>x.externalDriverId===d.externalDriverId);if(i>=0)roster[i]=d;else roster.push(d);window.savedDriver=d;window.roster=structuredClone(roster);return d};export const writeExternalDelivery=async()=>{throw Error('Unexpected messaging call')};`, loader: 'js' }));
} }] });
const cssDir = 'out/_next/static/css';
const css = fs.existsSync(cssDir) ? fs.readdirSync(cssDir).filter(f => f.endsWith('.css')).map(f => fs.readFileSync(`${cssDir}/${f}`, 'utf8')).join('\n') : '';
const server = http.createServer((req,res) => { res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].contents : `<style>${css}</style><header style="position:sticky;top:0;height:72px;z-index:40;background:#111"></header><div id="root"></div><script src="/bundle.js"></script>`); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
 for (const width of [2560, 1280, 1024, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading',{name:'Dispatch board'}).waitFor();
  assert.equal(await page.getByRole('link',{name:'Driver profiles'}).getAttribute('href'),'/dispatch/independent/drivers/');
  await page.getByText('No active jobs. New requests will appear here.').waitFor();
  assert.equal(await page.getByRole('region',{name:'Needs a driver jobs'}).count(),0,'empty waiting queue does not reserve board space');
  assert.equal(await page.getByRole('heading',{name:'New Independent Dispatch job'}).count(),0,'intake starts collapsed so the board is visible first');
  await page.getByRole('button',{name:'New job / paste request'}).click();
  await page.getByText('New Independent Dispatch job').waitFor();
  await page.getByRole('button',{name:/Drivers Without WellBuilt Accounts/}).click();
  await page.getByPlaceholder('Driver name').fill('Isaac Hickert');
  await page.getByRole('button',{name:'Add driver'}).click();
  await page.getByText('Isaac Hickert · No phone on file').waitFor();
  await page.getByRole('heading',{name:'Preference not set (6)'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>({phone:window.savedDriver.phoneE164,channels:window.savedDriver.channels})),{phone:'',channels:[]});
  const originalId=await page.evaluate(()=>window.savedDriver.externalDriverId);
  await page.getByRole('button',{name:'Edit Isaac Hickert'}).click();
  await page.getByRole('textbox',{name:'Driver phone (optional)'}).fill('+17015550124');
  await page.getByLabel('Shift preference').selectOption('night');
  await page.getByRole('button',{name:'Save driver'}).click();
  await page.getByText('Isaac Hickert · +17015550124').waitFor();
  await page.getByRole('heading',{name:'Night shift (2)'}).waitFor();
  assert.equal(await page.evaluate(()=>window.savedDriver.shiftPreference),'night');
  assert.deepEqual(await page.evaluate(()=>window.savedDriver.channels),[], 'phone can be saved without opting into messaging');
  assert.equal(await page.evaluate(id=>window.roster.filter(d=>d.externalDriverId===id).length,originalId),1,'edit preserves the roster ID');
  await page.getByRole('button',{name:'Edit Isaac Hickert'}).click();
  await page.getByRole('textbox',{name:'Driver name'}).fill('Isaac H.');
  await page.getByLabel('Shift preference').selectOption('day');
  await page.getByRole('checkbox',{name:'Active for new assignments'}).uncheck();
  await page.getByRole('button',{name:'Save driver'}).click();
  await page.getByText('Isaac H. · +17015550124 · inactive').waitFor();
  await page.getByRole('heading',{name:'Day shift (1)'}).waitFor();
  assert.equal(await page.evaluate(id=>window.roster.find(d=>d.externalDriverId===id)?.active,originalId),false);
  await page.getByRole('textbox',{name:'Job request text'}).fill('Customer: Customer A\nSector: Water hauling\nJob: Production water run\nPickup: Yard A\nDelivery: Site B\nWater type: Production water\nBarrels: 120\nNeed 3 drivers');
  await page.getByRole('button',{name:'Fill job form from text'}).click();
  assert.equal(await page.getByRole('combobox',{name:'Customer',exact:true}).inputValue(),'customer-a');
  assert.equal(await page.getByRole('combobox',{name:'Transportation sector',exact:true}).inputValue(),'water-hauling');
  assert.equal(await page.getByLabel('Job name *').inputValue(),'Production water run');
  assert.equal(await page.getByLabel('Estimated barrels').inputValue(),'120');
  assert.equal(await page.getByRole('spinbutton',{name:'Drivers requested'}).inputValue(),'3');
  assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.op==='create').length),0,'parsing never creates a job');
  await page.getByRole('button',{name:'Clear / new job'}).click();
  await page.getByRole('textbox',{name:'Job request text'}).fill("Customer: Bob's Hot Shot\nSector: Hot shot\nJob: Pump\nPickup: Yard\nDelivery: Rig\nUrgency: Same day\nCargo details: Pump skid");
  await page.getByRole('button',{name:'Fill job form from text'}).click();
  assert.equal(await page.getByRole('combobox',{name:'Customer',exact:true}).inputValue(),'');
  await page.getByRole('button',{name:/Bob's Hot Shot LLC · matches job sector/}).click();
  assert.equal(await page.getByRole('combobox',{name:'Customer',exact:true}).inputValue(),'bob');
  await page.getByRole('button',{name:'Clear / new job'}).click();
  await page.getByRole('textbox',{name:'Job request text'}).fill('Customer: BHS\nSector: Hot shot\nJob: Pump\nPickup: Yard\nDelivery: Rig\nUrgency: Same day\nCargo details: Pump skid');
  await page.getByRole('button',{name:'Fill job form from text'}).click();
  assert.equal(await page.getByRole('combobox',{name:'Customer',exact:true}).inputValue(),'bob','unique alias chooses the saved official customer');
  await page.getByRole('button',{name:'Clear / new job'}).click();
  await page.getByRole('textbox',{name:'Job request text'}).fill('Customer: Unknown Co\nSector: Water hauling\nJob: Review pickup\nPickup: Yard A\nDelivery: Site B\nWater type: Production water\nBarrels: 50');
  await page.getByRole('button',{name:'Fill job form from text'}).click();
  assert.equal(await page.getByRole('combobox',{name:'Customer',exact:true}).inputValue(),'__new__');
  assert.equal(await page.getByRole('textbox',{name:"New customer's official company name"}).inputValue(),'Unknown Co');
  assert.equal(await page.getByRole('checkbox',{name:'Save this customer for future jobs'}).isChecked(),false);
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
    if (sector === 'water-hauling') {
      await page.getByRole('combobox',{name:'Customer category'}).selectOption('rig-work');
      await page.getByLabel('Rig, site, or asset').fill('Rig 429');
    }
    if (sector === 'water-hauling' || sector === 'ltl') {
      await page.getByRole('combobox',{name:'Saved job contact'}).selectOption(sector === 'water-hauling' ? 'john' : 'jane');
      if (sector === 'water-hauling') await page.getByLabel('Contact phone (+country code)').fill('+17015550199');
    }
    for (const [label, value] of fields) {
      const field = page.getByLabel(label.replace(/ \*$/, ''),{exact:true});
      if (['Water type *','Trailer type *','Urgency *','Material *'].includes(label)) await field.selectOption({label:value});
      else await field.fill(value);
    }
    for (const [label,value] of [['Job name',`Pipe run ${sector}`],['Pickup address / location','Yard A'],['Delivery address / location','Site B']]) await page.getByLabel(label + ' *',{exact:true}).fill(value);
    if (sector === 'water-hauling') {
      await page.getByLabel('Scheduled pickup (your local time)').fill('2099-11-23T08:00');
      await page.getByLabel('Estimated finish (your local time)').fill('2099-11-23T20:00');
      await page.getByLabel('Job shift').selectOption('day');
      await page.getByRole('checkbox',{name:'Ongoing / recurring work'}).check();
      await page.getByRole('spinbutton',{name:'Drivers requested'}).fill('3');
    }
    await page.getByRole('button',{name:'Create job',exact:true}).click();
    await page.waitForFunction(title => window.requests.some(request => request.op === 'create' && request.job.title === title),`Pipe run ${sector}`);
    if (sector === 'water-hauling') assert.deepEqual(await page.evaluate(() => {
      const job = window.requests.find(request => request.op === 'create' && request.job.title === 'Pipe run water-hauling')?.job;
      return { categoryId: job?.categoryId, asset: job?.asset };
    }), { categoryId: 'rig-work', asset: 'Rig 429' });
  }
  await page.getByRole('combobox',{name:'Customer',exact:true}).selectOption('__new__');
  await page.getByRole('textbox',{name:"New customer's official company name"}).fill('One Time Freight LLC');
  await page.getByRole('combobox',{name:'Transportation sector',exact:true}).selectOption('ltl');
  await page.getByLabel('Freight description').fill('Parts');
  await page.getByLabel('Pieces').fill('2');
  await page.getByLabel('Job name *').fill('One-time job');
  await page.getByLabel('Pickup address / location *').fill('Yard');
  await page.getByLabel('Delivery address / location *').fill('Site');
  await page.getByRole('button',{name:'Create job',exact:true}).click();
  await page.waitForFunction(() => window.requests.some(request => request.op === 'create' && request.job.title === 'One-time job'));
  assert.deepEqual(await page.evaluate(()=>{const r=window.requests.find(r=>r.op==='create'&&r.job.title==='One-time job');return {customer:r.job.customer,customerId:r.job.customerId,saveCustomer:r.saveCustomer}}),
    {customer:'One Time Freight LLC',customerId:undefined,saveCustomer:undefined});
  await page.getByRole('combobox',{name:'Customer',exact:true}).selectOption('__new__');
  await page.getByRole('textbox',{name:"New customer's official company name"}).fill('New Repeat Customer LLC');
  await page.getByRole('checkbox',{name:'Save this customer for future jobs'}).check();
  await page.getByRole('combobox',{name:'Transportation sector',exact:true}).selectOption('ltl');
  await page.getByLabel('Freight description').fill('Parts');
  await page.getByLabel('Pieces').fill('3');
  await page.getByLabel('Job name *').fill('First repeat job');
  await page.getByLabel('Pickup address / location *').fill('Yard');
  await page.getByLabel('Delivery address / location *').fill('Site');
  await page.getByRole('button',{name:'Create job',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.requests.find(r=>r.op==='create'&&r.job.title==='First repeat job')?.saveCustomer),true);
  const queue=page.getByRole('region',{name:'Needs a driver jobs'});
  await queue.getByRole('button',{name:/Needs a driver 7/}).waitFor();
  assert.equal(await queue.getByText('Customer A · Pipe run water-hauling',{exact:true}).isVisible(),true,'collapsed alert previews a waiting job');
  assert.equal(await page.getByRole('dialog',{name:'Jobs needing a driver'}).isVisible(),false,'waiting cards start collapsed');
  await queue.getByRole('button',{name:/Needs a driver 7/}).click();
  const dialog=page.getByRole('dialog',{name:'Jobs needing a driver'});
  const card=dialog.getByRole('article').filter({hasText:'Pipe run water-hauling'});
  await card.waitFor();
  assert.equal(await dialog.getByRole('article').count(),7,'all waiting jobs are available in the modal');
  await card.getByText('Job contact: John Wick · Company man · +17015550199').waitFor();
  await dialog.getByRole('article').filter({hasText:'Pipe run ltl'}).getByText('Job contact: Jane Doe · Lead · +17015550113').waitFor();
  await card.getByRole('heading',{name:'Pipe run water-hauling'}).click();
  assert.match(await card.getAttribute('class'),/ring-amber-400/,'clicking a job card highlights it');
  await card.getByRole('button',{name:'Edit'}).click();
  assert.equal(await dialog.isVisible(),false,'editing a waiting job closes the modal so the form is usable');
  await page.getByRole('heading',{name:'Editing job: Pipe run water-hauling'}).waitFor();
  await page.getByRole('button',{name:'Cancel edit / back to board'}).waitFor();
  await page.waitForFunction(() => {
    const heading = document.querySelector('#independent-job-form h2');
    const toolbar = document.querySelector('[data-testid="independent-board-toolbar"]');
    return heading && toolbar && heading.getBoundingClientRect().top >= toolbar.getBoundingClientRect().bottom + 8;
  }, null, {timeout: 3000});
  await page.getByRole('button',{name:'Cancel edit / back to board'}).click();
  const boardCard = page.getByRole('region',{name:'Unassigned jobs'}).getByRole('article',{name:'Customer A · Pipe run water-hauling'});
  await boardCard.waitFor();
  assert.match(await boardCard.getAttribute('class'),/ring-amber-400/,'cancel returns to the selected card');
  await page.waitForFunction(() => {
    const card = document.querySelector('[id^="independent-job-"][aria-label="Customer A · Pipe run water-hauling"]');
    const toolbar = document.querySelector('[data-testid="independent-board-toolbar"]');
    const gap = card && toolbar && card.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom;
    return gap >= 8 && gap <= 40;
  }, null, {timeout: 3000});
  await boardCard.getByRole('button',{name:'Edit'}).click();
  await page.getByLabel('Customer reference / load number').fill('TEST-REF');
  await page.getByRole('button',{name:'Save changes'}).click();
  await boardCard.getByText('TEST-REF').waitFor();
  assert.match(await boardCard.getAttribute('class'),/ring-amber-400/,'save returns to the selected card');
  await page.waitForFunction(() => {
    const card = document.querySelector('[id^="independent-job-"][aria-label="Customer A · Pipe run water-hauling"]');
    const toolbar = document.querySelector('[data-testid="independent-board-toolbar"]');
    const gap = card && toolbar && card.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom;
    return gap >= 8 && gap <= 40;
  }, null, {timeout: 3000});
  await page.getByRole('combobox',{name:'Job status',exact:true}).selectOption('active');
  await queue.getByRole('button',{name:/Needs a driver/}).click();
  const waitingPicker = card.locator('details').filter({hasText:'Choose drivers'});
  if (!await waitingPicker.evaluate(details => details.open)) await waitingPicker.locator('summary').click();
  assert.equal(await card.getByRole('combobox',{name:'Shift for Driver B on Pipe run water-hauling'}).inputValue(),'night');
  await card.getByRole('group',{name:'Prefers night shift candidates'}).getByText('Driver B').waitFor();
  await card.getByRole('checkbox',{name:'Choose Nitto–Anthony (Marcial Lebaron) for Pipe run water-hauling'}).locator('..').getByText('WB',{exact:true}).waitFor();
  await card.getByRole('checkbox',{name:'Choose Outside Driver for Pipe run water-hauling'}).check();
  await card.getByRole('checkbox',{name:'Choose Driver B for Pipe run water-hauling'}).check();
  await card.getByRole('combobox',{name:'Shift for Driver B on Pipe run water-hauling'}).selectOption('day');
  await card.getByRole('group',{name:'Prefers night shift candidates'}).getByText('Driver B').waitFor();
  await card.getByRole('group',{name:'Prefers night shift candidates'}).getByText('This job · Day').waitFor();
  await card.getByRole('combobox',{name:'Shift for Driver B on Pipe run water-hauling'}).selectOption('night');
  await card.getByRole('group',{name:'Prefers night shift candidates'}).getByText('Driver B').waitFor();
  const luiz = card.getByRole('checkbox',{name:'Choose Luiz Lebaron for Pipe run water-hauling'});
  await luiz.check();
  await card.getByRole('combobox',{name:'Shift for Luiz Lebaron on Pipe run water-hauling'}).selectOption('day');
  await card.getByRole('group',{name:'Preference not set candidates'}).getByText('Luiz Lebaron').waitFor();
  await luiz.uncheck();
  assert.equal(await card.getByRole('combobox',{name:'Shift for Driver B on Pipe run water-hauling'}).inputValue(),'night','saved night preference overrides the job day shift');
  await card.getByRole('button',{name:'Assign selected drivers'}).click();
  await dialog.getByRole('button',{name:'Close'}).click();
  const assignedCard=page.getByRole('region',{name:'Assigned jobs'}).getByRole('article').filter({has:page.getByRole('heading',{name:'Pipe run water-hauling',exact:true})});
  await assignedCard.waitFor();
  await assignedCard.getByText('Drivers (2)').waitFor();
  await assignedCard.getByText('Drivers requested: 3 · Assigned: 2 · 1 still needed').waitFor();
  await assignedCard.getByRole('region',{name:'Day Shift drivers'}).getByText('Day Shift',{exact:true}).waitFor();
  await assignedCard.getByRole('region',{name:'Night Shift drivers'}).getByText('Night Shift',{exact:true}).waitFor();
  // Each shift list must show three padded two-line rows, without clipping driver names.
  for (const shift of ['Day', 'Night']) {
    const metrics = await assignedCard.getByRole('region',{name:`${shift} Shift drivers`}).evaluate(panel => {
      const list = panel.querySelector('.overflow-y-auto');
      const row = list?.querySelector('div[class*="min-h-"]');
      const name = row?.querySelector('[title]');
      const controls = row?.querySelector('select')?.parentElement;
      return { width: panel.getBoundingClientRect().width, listHeight: list?.getBoundingClientRect().height || 0,
        rowMinHeight: row ? parseFloat(getComputedStyle(row).minHeight) : 0,
        whiteSpace: name ? getComputedStyle(name).whiteSpace : '', textOverflow: name ? getComputedStyle(name).textOverflow : '',
        rowRight: row?.getBoundingClientRect().right || 0, controlsRight: controls?.getBoundingClientRect().right || 0,
        nameRight: name?.getBoundingClientRect().right || 0, controlsLeft: controls?.getBoundingClientRect().left || 0 };
    });
    assert.ok(metrics.width >= 240, `${shift} shift panel should be wide enough for wrapped names at ${width}px`);
    assert.ok(metrics.listHeight >= metrics.rowMinHeight * 3 && metrics.rowMinHeight >= 70,
      `${shift} shift list must fit three two-line driver rows at ${width}px`);
    assert.equal(metrics.whiteSpace, 'normal', `${shift} shift names should wrap`);
    assert.notEqual(metrics.textOverflow, 'ellipsis', `${shift} shift names must not truncate`);
    assert.ok(metrics.rowRight - metrics.controlsRight < 12 && metrics.nameRight <= metrics.controlsLeft,
      `${shift} shift controls should use the right side without overlapping the driver name at ${width}px`);
  }
  assert.equal(await assignedCard.getByLabel('1 day shift drivers').count(),1);
  assert.equal(await assignedCard.getByLabel('1 night shift drivers').count(),1);
  assert.deepEqual(await page.evaluate(()=>window.requests.find(r=>r.op==='addDrivers')?.drivers),
    [{key:'outside:driver-a',shift:'day'},{key:'outside:driver-b',shift:'night'}]);
  assert.equal(await assignedCard.getByText('Day shift · Ongoing work').count(),1);
  const firstJobId = await page.evaluate(() => window.requests.find(request => request.op === 'create'&&request.job.title==='Pipe run water-hauling').jobId);
  assert.equal(await assignedCard.getByRole('link',{name:'Call customer in Dialpad'}).getAttribute('href'),
    `dialpad://+17015550111?confirmPhone=1&fromNumber=%2B17015550100&customData=wellbuilt-independent%3A${firstJobId}`);
  assert.equal(await assignedCard.getByRole('link',{name:'Call job contact in Dialpad'}).getAttribute('href'),
    `dialpad://+17015550199?confirmPhone=1&fromNumber=%2B17015550100&customData=wellbuilt-independent%3A${firstJobId}`);
  assert.ok((await assignedCard.getByRole('link',{name:'Call driver in Dialpad'}).getAttribute('href'))?.startsWith('dialpad://+17015550123?confirmPhone=1&fromNumber=%2B17015550100&customData='));
  await assignedCard.getByTitle('Driver B').waitFor();
  assert.equal(await assignedCard.getByRole('combobox',{name:'Assignment shift for Driver B on Pipe run water-hauling'}).inputValue(),'night');
  await assignedCard.getByRole('combobox',{name:'Assignment shift for Driver B on Pipe run water-hauling'}).selectOption('day');
  await assignedCard.getByLabel('2 day shift drivers').waitFor();
  await assignedCard.getByRole('combobox',{name:'Assignment shift for Driver B on Pipe run water-hauling'}).selectOption('night');
  await assignedCard.getByLabel('1 night shift drivers').waitFor();
  await assignedCard.getByText('Choose drivers').click();
  assert.ok(await assignedCard.locator('details').filter({hasText:'Choose drivers'}).evaluate(details => details.getBoundingClientRect().width >= details.parentElement.getBoundingClientRect().width - 1),
    'the driver picker spans the job card action area');
  assert.ok(await assignedCard.getByText('HOS unverified').evaluate(label => label.tagName === 'P' && label.nextElementSibling?.querySelector('details')),
    'HOS notice is independent of the driver picker');
  assert.ok(await assignedCard.getByRole('button',{name:'Add selected drivers'}).evaluate(button =>
    button.getBoundingClientRect().top >= button.parentElement.previousElementSibling.getBoundingClientRect().bottom),
    'action buttons sit below the open picker');
  assert.ok(await assignedCard.getByRole('button',{name:'Add selected drivers'}).evaluate(button => button.getBoundingClientRect().height < 60),
    'opening the picker must not stretch the assignment button to the picker height');
  assert.ok(await assignedCard.getByRole('button',{name:'Mark started'}).evaluate(button => button.getBoundingClientRect().height < 60),
    'status controls remain compact beside an open picker');
  assert.ok(await assignedCard.getByRole('button',{name:'Cancel job'}).evaluate(button => {
    const card = button.closest('article');
    const actions = card?.querySelector('button:not([disabled])');
    return card && actions && card.getBoundingClientRect().right - button.getBoundingClientRect().right < 24
      && button.getBoundingClientRect().top > actions.getBoundingClientRect().top;
  }), 'Cancel job sits at the bottom right of the card');
  await assignedCard.getByRole('checkbox',{name:'Choose Driver C for Pipe run water-hauling'}).check();
  await assignedCard.getByRole('combobox',{name:'Shift for Driver C on Pipe run water-hauling'}).selectOption('night');
  await assignedCard.getByRole('button',{name:'Swap'}).last().click();
  await assignedCard.getByTitle('Driver C').waitFor();
  await assignedCard.getByRole('button',{name:'Remove'}).last().click();
  await assignedCard.getByText('Drivers (1)').waitFor();
  await queue.getByRole('button',{name:/Needs a driver/}).click();
  const linkedCard=dialog.getByRole('article').filter({has:page.getByRole('heading',{name:'Pipe run ltl',exact:true})});
  await linkedCard.getByText('Choose drivers').click();
  assert.equal(await linkedCard.getByRole('checkbox',{name:'Choose Outside Driver for Pipe run ltl'}).isDisabled(),true,'ongoing assignment stays visible but unavailable');
  assert.equal(await linkedCard.getByRole('checkbox',{name:'Choose Isaac H. for Pipe run ltl'}).isDisabled(),true,'inactive driver stays visible');
  await linkedCard.getByRole('checkbox',{name:'Choose Nitto–Anthony (Marcial Lebaron) for Pipe run ltl'}).check();
  await linkedCard.getByRole('combobox',{name:'Shift for Nitto–Anthony (Marcial Lebaron) on Pipe run ltl'}).selectOption('night');
  await linkedCard.getByRole('group',{name:'Preference not set candidates'}).getByText('Nitto–Anthony (Marcial Lebaron)').waitFor();
  await linkedCard.getByRole('button',{name:'Assign selected drivers'}).click();
  await dialog.getByRole('button',{name:'Close'}).click();
  const assignedLinkedCard=page.getByRole('region',{name:'Assigned jobs'}).getByRole('article').filter({has:page.getByRole('heading',{name:'Pipe run ltl',exact:true})});
  assert.match(await assignedLinkedCard.getByTitle('Nitto–Anthony (Marcial Lebaron)').textContent(),/WB/);
  assert.equal(await page.evaluate(()=>window.requests.find(r=>r.op==='addDrivers'&&r.drivers.some(d=>d.key==='wellbuilt:wb-marcial'))?.drivers[0].key),'wellbuilt:wb-marcial');
  assert.equal(await assignedLinkedCard.getByRole('link',{name:'Call driver in Dialpad'}).count(),0);
  await queue.getByRole('button',{name:/Needs a driver/}).click();
  const planningCard = dialog.getByRole('article').first();
  await planningCard.getByText('Choose drivers').click();
  const marcialPlanning = planningCard.getByRole('checkbox',{name:/^Choose Nitto–Anthony \(Marcial Lebaron\) for /});
  assert.equal(await marcialPlanning.isEnabled(),true,'a pending nonongoing assignment permits another reviewed plan');
  await planningCard.getByRole('group',{name:'Preference not set candidates'}).getByText('Assigned · Night').waitFor();
  await planningCard.getByText('Choose drivers').click();
  for (let remaining = 5; remaining > 0; remaining--) {
    const next = dialog.getByRole('article').first();
    await next.getByText('Choose drivers').click();
    await next.getByRole('checkbox',{name:new RegExp(`^Choose Driver ${'BCDEF'[5-remaining]} for `)}).check();
    await next.getByRole('button',{name:'Assign selected drivers'}).click();
    if (remaining > 1) await page.waitForFunction(count => document.querySelectorAll('dialog[open] article').length === count, remaining - 1);
  }
  await page.waitForFunction(() => !document.querySelector('section[aria-label="Needs a driver jobs"]'));
  const assignedWidth=await page.getByRole('region',{name:'Assigned jobs'}).evaluate(element => element.getBoundingClientRect().width / element.parentElement.getBoundingClientRect().width);
  assert.ok(assignedWidth > .95, `assigned jobs should fill the board when no other lane has jobs at ${width}px`);
  await page.evaluate(() => window.scrollTo({ top: 300, behavior: 'instant' }));
  await page.waitForFunction(() => {
    const toolbar = document.querySelector('[data-testid="independent-board-toolbar"]');
    const header = document.querySelector('header');
    return !!toolbar && !!header && Math.abs(toolbar.getBoundingClientRect().top - header.getBoundingClientRect().bottom) <= 2;
  });
  assert.equal(await page.getByRole('textbox',{name:'Search dispatch jobs'}).isVisible(),true,'search remains in the pinned toolbar');
  await assignedCard.getByRole('button',{name:'Mark started',exact:true}).click();
  await page.getByRole('region',{name:'In progress jobs'}).getByRole('article').filter({hasText:'Pipe run water-hauling'}).waitFor();
  await assignedLinkedCard.getByText('Choose drivers').click();
  await assignedLinkedCard.getByText('Working · Day').waitFor();
  if (width >= 1024) {
    const workLaneWidth=await page.getByRole('region',{name:'Assigned jobs'}).evaluate(element => element.getBoundingClientRect().width / element.parentElement.getBoundingClientRect().width);
    assert.ok(workLaneWidth > .45 && workLaneWidth < .55, `assigned and in-progress jobs should split the board at ${width}px`);
  }
  const progressCard=page.getByRole('region',{name:'In progress jobs'}).getByRole('article').filter({hasText:'Pipe run water-hauling'});
  assert.equal(await progressCard.getByRole('button',{name:'Edit',exact:true}).count(),0);
  await progressCard.getByRole('button',{name:'Mark completed',exact:true}).click();
  await progressCard.waitFor({state:'detached'});
  await page.getByRole('combobox',{name:'Job status',exact:true}).selectOption('completed');
  const completedCard=page.getByRole('region',{name:'Completed jobs'}).getByRole('article').filter({hasText:'Pipe run water-hauling'});
  await completedCard.waitFor();
  assert.equal(await completedCard.getByRole('button').count(),0);
  assert.equal(await page.getByRole('link',{name:'Driver profiles'}).getAttribute('href'),'/dispatch/independent/drivers/');
  assert.deepEqual(await page.evaluate(()=>window.requests.filter(r=>r.op==='create'&&r.job.title.startsWith('Pipe run ')).map(r=>r.job.sector)),sectors.map(([sector])=>sector));
  assert.deepEqual(errors,[]);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow');
  await page.close();
 }
 console.log('Independent Dispatch actual UI: five sector forms, compact waiting alert/modal, checkbox crew batch and swap, adaptive work lanes, assign/start/complete, filters, terminal lock; desktop/mobile; no messaging.');
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
