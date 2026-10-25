const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),http=require('http'),assert=require('node:assert/strict');const {chromium}=require('playwright');
(async()=>{
 const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-shift-picker-'));
 const component=path.join(root,'src/components/DispatchDriverPicker.tsx').replaceAll('\\','/');

 fs.writeFileSync(path.join(dir,'entry.jsx'),`
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{DispatchDriverPicker}from ${JSON.stringify(component)};
 import{parseShiftResolveEnvelope,shiftDotForDriver}from ${JSON.stringify(path.join(root,'src/lib/shiftDotCore.ts').replaceAll('\\','/'))};
 const drivers=Array.from({length:42},(_,i)=>({key:'legacy-'+i,driverId:'canonical-'+i,displayName:'Driver '+String(i+1).padStart(2,'0'),companyId:'fixture',shiftPlan:{'2026-10-24':i%2?'night':'day'}}));
 const resolved=parseShiftResolveEnvelope({companyId:'fixture',results:drivers.map((d,i)=>({driverId:d.driverId,state:i<35?'open':'none'}))});
 const dot=d=>shiftDotForDriver({canonicalDriverId:d.driverId,companyId:d.companyId,resolvedCompanyId:resolved.companyId,resultsByDriverId:resolved.resultsByDriverId});
 function App(){const[selected,setSelected]=useState(new Set());const[selection,setMode]=useState('single');window.mode=setMode;window.chosen=[...selected];return <DispatchDriverPicker drivers={drivers} selectedKeys={selected} onSelect={key=>setSelected(prev=>selection==='single'?new Set(key?[key]:[]):new Set(prev.has(key)?[...prev].filter(k=>k!==key):[...prev,key]))} selection={selection} shiftDate="2026-10-24" onShiftDateChange={()=>{}} onShiftChange={async()=>{}} shiftDot={dot} onSelectMany={keys=>setSelected(new Set(keys))}/>;}createRoot(document.getElementById('root')).render(<App/>);`);
 let esbuild;try{esbuild=require('esbuild');}catch{const fixed=command=>cp.execFileSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',command],{encoding:'utf8'});const cache=path.join(fixed('npm config get cache').trim(),'_npx');const all=fs.readdirSync(cache).map(n=>path.join(cache,n,'node_modules/esbuild/lib/main.js')).filter(fs.existsSync);all.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);esbuild=require(all[0]);}
 esbuild.buildSync({entryPoints:[path.join(dir,'entry.jsx')],bundle:true,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},nodePaths:[path.join(root,'node_modules')],outfile:path.join(dir,'bundle.js'),alias:{'@':path.join(root,'src')},logLevel:'silent'});
 const css=fs.readdirSync('out/_next/static/css').filter(f=>f.endsWith('.css')).map(f=>fs.readFileSync(path.join('out/_next/static/css',f),'utf8')).join('\n');
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?fs.readFileSync(path.join(dir,'bundle.js')):'<style>'+css+'</style><main style="padding:12px;max-width:760px;background:#111827;color:white"><div id="root"></div></main><script src="/bundle.js"></script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});

 try{
  const page=await browser.newPage({viewport:{width:768,height:900}});await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByRole('checkbox',{name:'Choose Driver 01 for job',exact:true}).waitFor();
  assert.equal(await page.getByRole('img',{name:'On shift',exact:true}).count(),35);
  assert.equal(await page.getByRole('img',{name:'Off shift',exact:true}).count(),7);
  await page.getByRole('checkbox',{name:'Choose Driver 01 for job',exact:true}).check();
  assert.deepEqual(await page.evaluate(()=>window.chosen),['legacy-0']);
  await page.evaluate(()=>window.mode('multiple'));
  assert.equal(await page.getByRole('img',{name:'On shift',exact:true}).count(),35,'Queue builder retains the same canonical live status');
  await page.getByRole('button',{name:'Select shown',exact:true}).click();
  assert.equal((await page.evaluate(()=>window.chosen)).length,42);
  await page.getByRole('searchbox',{name:'Search drivers'}).fill('Driver 40');
  assert.equal(await page.getByRole('checkbox').count(),1);
  assert.equal((await page.evaluate(()=>window.chosen)).length,42,'Filtering preserves hidden selections');
  await page.getByRole('searchbox',{name:'Search drivers'}).fill('');
  for(const width of [320,344,768,1280]){
   await page.setViewportSize({width,height:800});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No horizontal overflow '+width);
  }
  console.log('PASS shared PW/queue picker: canonical 35 open / 7 closed dots, single/multiple selection, 42-driver search retention, four widths');
 }finally{await browser.close();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
