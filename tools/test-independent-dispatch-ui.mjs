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
 if(data.op==='list')return {companyId:'fixture',jobs:structuredClone(jobs)};
 if(data.op==='create')jobs.push({...data.job,id:data.jobId,revision:1,status:'unassigned',companyId:'fixture',updatedAt:new Date().toISOString()});
 const job=jobs.find(j=>j.id===data.jobId);
 if(data.op==='update')Object.assign(job,data.job,{revision:job.revision+1});
 if(data.op==='assign')Object.assign(job,{status:'assigned',driverName:'Outside Driver',revision:job.revision+1});
 if(data.op==='status')Object.assign(job,{status:data.status,revision:job.revision+1});
 return {ok:true,job};
}`;
const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {IndependentDispatchBoard} from './src/components/IndependentDispatchBoard';createRoot(document.getElementById('root')).render(<IndependentDispatchBoard companyId="fixture" canWrite={true} canManageDrivers={true}/>);`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'fixture', setup(b) {
  b.onResolve({ filter: /^@\/lib\/(independentDispatchJobs|externalAssignmentDelivery)$/ }, a => ({ path: a.path, namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: a.path.endsWith('independentDispatchJobs') ? transport : `export const listExternalDrivers=async()=>[{externalDriverId:'driver-a',displayName:'Outside Driver',phoneE164:'+17015550123',channels:['sms'],active:true}];export const listExternalDeliveries=async()=>[];export const saveExternalDriver=async(d)=>d;export const writeExternalDelivery=async()=>{throw Error('Unexpected messaging call')};`, loader: 'js' }));
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
  for (const [label,value] of [['Job name','Pipe run'],['Customer','Customer A'],['Pickup address / location','Yard A'],['Delivery address / location','Site B']]) await page.getByLabel(label + ' *',{exact:true}).fill(value);
  await page.getByRole('button',{name:'Create job',exact:true}).click();
  const card=page.getByRole('article').filter({hasText:'Pipe run'});
  await card.waitFor();
  await card.getByRole('combobox').selectOption('driver-a');
  await card.getByRole('button',{name:'Assign',exact:true}).click();
  await card.getByRole('button',{name:'Mark started',exact:true}).click();
  assert.equal(await card.getByRole('button',{name:'Edit',exact:true}).count(),0);
  await card.getByRole('button',{name:'Mark completed',exact:true}).click();
  await card.waitFor({state:'detached'});
  await page.getByRole('combobox',{name:'Job status',exact:true}).selectOption('completed');
  await card.waitFor();
  assert.equal(await card.getByRole('button').count(),0);
  assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.op==='create').length),1);
  assert.deepEqual(errors,[]);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow');
  await page.close();
 }
 console.log('Independent Dispatch actual UI: create, assign, start, complete, filters, locked completed jobs; desktop/mobile; no messaging.');
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
