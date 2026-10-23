const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),http=require('http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'watchdog-health-'));
 assert.match(fs.readFileSync(path.join(root,'src/app/watchdog/page.tsx'),'utf8'),/<WatchdogHealthPanel companyId=\{operatingCompanyId\}/,'Live Watchdog route must include remote health controls');
 const component=path.join(root,'src/components/watchdog/WatchdogHealthPanel.tsx').replaceAll('\\','/');
 fs.writeFileSync(path.join(dir,'stub.js'),'export const httpsCallable=()=>{throw Error("Unexpected Firebase request")};export const getFirebaseFunctions=()=>null;');
 fs.writeFileSync(path.join(dir,'entry.jsx'),`
 import React from 'react';import {createRoot} from 'react-dom/client';import {WatchdogHealthPanel} from ${JSON.stringify(component)};
 const root=createRoot(document.getElementById('root'));window.calls=[];window.sends=[];
 const load=company=>new Promise((resolve,reject)=>window.calls.push({company,resolve,reject}));
 const send=payload=>new Promise((resolve,reject)=>window.sends.push({payload,resolve,reject}));
 window.show=company=>root.render(<WatchdogHealthPanel key={company} companyId={company} load={load} send={send}/>);
 window.ok=(i,extra={})=>window.calls[i].resolve({installed:true,seenAt:Date.now(),stale:false,serverTime:Date.now(),canRecover:true,command:null,health:{workerReachable:true,state:'Connected',paused:false,lastReceiverCheck:new Date().toISOString(),transportStatus:'Ready',pending:3,reviews:1,channels:8,error:''},...extra});window.show('A');`);
 let esbuild;try{esbuild=require('esbuild');}catch{
  const fixed=command=>cp.execFileSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',command],{encoding:'utf8'});
  const cache=path.join(fixed('npm config get cache').trim(),'_npx');const candidates=fs.readdirSync(cache).map(n=>path.join(cache,n,'node_modules/esbuild/lib/main.js')).filter(p=>fs.existsSync(p));candidates.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);if(!candidates.length)throw Error('Run existing Watchdog component regression to provision esbuild');esbuild=require(candidates[0]);
 }
 esbuild.buildSync({entryPoints:[path.join(dir,'entry.jsx')],bundle:true,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},nodePaths:[path.join(root,'node_modules')],outfile:path.join(dir,'bundle.js'),alias:{'firebase/functions':path.join(dir,'stub.js'),'@/lib/firebase':path.join(dir,'stub.js')},logLevel:'silent'});
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?fs.readFileSync(path.join(dir,'bundle.js')):'<div id="root"></div><script src="/bundle.js"></script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.clock.install();await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.calls.length===1);
  await page.evaluate(()=>window.ok(0,{installed:false,health:null,seenAt:null,stale:true}));await page.getByText('Remote helper is ready to install on the HP.',{exact:false}).waitFor();
  await page.getByLabel('Recovery reason').fill('Check pending updates');assert.equal(await page.getByRole('button',{name:'Restart Watchdog',exact:true}).isDisabled(),true);
  await page.clock.fastForward(180000);assert.equal(await page.evaluate(()=>window.calls.length),1,'Health panel must not poll Firebase');
  await page.getByRole('button',{name:'Refresh HP status',exact:true}).click();await page.waitForFunction(()=>window.calls.length===2);await page.evaluate(()=>window.ok(1));await page.getByText('8 watched chats · 3 pending updates · 1 reviews').waitFor();
  await page.getByRole('button',{name:'Retry pending work',exact:true}).click();await page.waitForFunction(()=>window.sends.length===1);const request=await page.evaluate(()=>window.sends[0].payload);assert.equal(request.companyId,'A');assert.equal(request.action,'retry_pending');assert.equal(request.reason,'Check pending updates');assert.match(request.requestId,/^[a-f0-9-]{36}$/);
  assert.equal(await page.getByRole('button',{name:'Restart Watchdog',exact:true}).isDisabled(),true);
  await page.evaluate(()=>window.sends[0].resolve());await page.waitForFunction(()=>window.calls.length===3);await page.evaluate(()=>window.ok(2,{command:{id:'queued',action:'retry_pending',state:'pending',expiresAt:Date.now()+600000,error:''}}));await page.getByText('Last recovery:',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'Restart Watchdog',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Refresh HP status',exact:true}).click();await page.waitForFunction(()=>window.calls.length===4);await page.evaluate(()=>window.show('B'));await page.waitForFunction(()=>window.calls.length===5);await page.evaluate(()=>window.ok(4,{canRecover:false,stale:true}));await page.getByText('HP helper has not checked in recently.',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'Restart Watchdog',exact:true}).count(),0);
  await page.evaluate(()=>window.ok(3));assert.equal(await page.getByRole('button',{name:'Restart Watchdog',exact:true}).count(),0,'Old company response must not restore recovery access');
  await page.clock.fastForward(600000);assert.equal(await page.evaluate(()=>window.calls.length),5,'No idle refresh loop');
  console.log('Watchdog health UI: manual refresh, install state, role visibility, scoped actions, pending lock and stale-response isolation PASSED');
 }finally{await browser.close();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
