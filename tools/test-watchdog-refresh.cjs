const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),http=require('http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'watchdog-refresh-'));
 const component=path.join(root,'src/components/watchdog/WatchdogReviewInbox.tsx').replaceAll('\\','/');
 fs.writeFileSync(path.join(dir,'stub.js'),'export const httpsCallable=()=>{throw Error("Unexpected live Firebase call")};export const getFirebaseFunctions=()=>null;');
 fs.writeFileSync(path.join(dir,'entry.jsx'),`
 import React from 'react';import {createRoot} from 'react-dom/client';import {WatchdogReviewInbox} from ${JSON.stringify(component)};
 const root=createRoot(document.getElementById('root'));window.calls=[];
 const load=company=>new Promise((resolve,reject)=>window.calls.push({company,resolve,reject}));
 window.show=company=>root.render(<WatchdogReviewInbox key={company} companyId={company} load={load}/>);
 window.ok=(i,name)=>window.calls[i].resolve({truncated:false,rows:name?[{id:'fixture',revision:'1',groupName:'Fixture',body:'Synthetic test',author:'Fixture',postedAt:'2026-10-18T12:00:00Z',editable:false,issues:[],row:{wellName:name,dateTimeUTC:'2026-10-18T12:00:00Z',tankLevelFeet:null,bottomLevelFeet:null,bblsTaken:null}}]:[]});
 window.bad=i=>window.calls[i].reject(Error('Fixture network timeout'));window.show('A');`);
 let esbuild;
 try{esbuild=require('esbuild');}catch{
  // Use a transient test tool without changing application dependencies.
  const fixedCommand=command=>process.platform==='win32'
   ?cp.execFileSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',command],{encoding:'utf8'})
   :cp.execFileSync(command.split(' ')[0],command.split(' ').slice(1),{encoding:'utf8'});
  fixedCommand('npx --yes esbuild --version');
  const cache=path.join(fixedCommand('npm config get cache').trim(),'_npx');
  const candidates=fs.readdirSync(cache).map(name=>path.join(cache,name,'node_modules/esbuild/lib/main.js')).filter(file=>fs.existsSync(file));
  candidates.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  if(!candidates.length)throw Error('Transient esbuild test tool unavailable');
  esbuild=require(candidates[0]);
 }
 esbuild.buildSync({entryPoints:[path.join(dir,'entry.jsx')],bundle:true,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},nodePaths:[path.join(root,'node_modules')],outfile:path.join(dir,'bundle.js'),alias:{'firebase/functions':path.join(dir,'stub.js'),'@/lib/firebase':path.join(dir,'stub.js')},logLevel:'silent'});
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?fs.readFileSync(path.join(dir,'bundle.js')):'<div id="root"></div><script src="/bundle.js"></script>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();page.on('pageerror',error=>console.error('Browser error:',error.message));await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.calls?.length===1);
  const refresh=page.getByRole('button',{name:'Refresh',exact:true});
  assert.equal(await page.getByRole('button',{name:'Refreshing...',exact:true}).isDisabled(),true);
  await page.evaluate(()=>window.ok(0));await refresh.waitFor();assert.equal(await refresh.isEnabled(),true);
  await refresh.click();await page.waitForFunction(()=>window.calls.length===2);assert.equal(await page.getByRole('button',{name:'Refreshing...',exact:true}).getAttribute('aria-busy'),'true');
  await page.getByRole('button',{name:'Refreshing...',exact:true}).press('Enter');assert.equal(await page.evaluate(()=>window.calls.length),2);
  await page.evaluate(()=>window.bad(1));await page.getByRole('alert').filter({hasText:'Fixture network timeout'}).waitFor();assert.equal(await refresh.isEnabled(),true);
  await refresh.click();await page.waitForFunction(()=>window.calls.length===3);await page.evaluate(()=>window.ok(2));await refresh.waitFor();assert.match(await page.getByRole('status').first().innerText(),/Last checked:/);
  await refresh.click();await page.waitForFunction(()=>window.calls.length===4);await page.evaluate(()=>window.show('B'));await page.waitForFunction(()=>window.calls.length===5);
  await page.evaluate(()=>window.ok(4,'Fixture B'));await page.getByRole('heading',{name:'Fixture B / Fixture'}).waitFor();
  await page.evaluate(()=>window.ok(3,'Fixture A'));assert.equal(await page.getByRole('heading',{name:'Fixture A / Fixture'}).count(),0);
  console.log('Watchdog Refresh browser checks passed: click, immediate busy feedback, repeated-click suppression, failure/retry, checked timestamp, and company-switch isolation.');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
