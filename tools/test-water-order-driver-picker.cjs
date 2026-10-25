const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),http=require('http'),assert=require('node:assert/strict');const {chromium}=require('playwright');
(async()=>{
 const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'water-driver-picker-'));
 const component=path.join(root,'src/components/WaterOrderDriverPicker.tsx').replaceAll('\\','/');
 assert.match(fs.readFileSync('src/components/WaterOrderBuilder.tsx','utf8'),/<DispatchDriverPicker drivers=\{scopeDrivers\}/,'Water orders must use scoped shared picker');
 assert.match(fs.readFileSync('src/app/dispatch/page.tsx','utf8'),/<WaterOrderBuilder[\s\S]*?shiftForDriver=\{driverShiftDot\}/);
 fs.writeFileSync(path.join(dir,'entry.jsx'),`
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{WaterOrderDriverPicker}from ${JSON.stringify(component)};
 const drivers=Array.from({length:42},(_,i)=>({key:'fixture-'+i,driverId:'canonical-'+i,displayName:'Driver '+String(i+1).padStart(2,'0'),companyId:'fixture'}));drivers[0]={...drivers[0],displayName:'private-login',loginAlias:'private-login',legalName:'Driver 01'};
 const shiftForDriver=d=>Number(d.key.split('-')[1])<35?{dot:'green',symbol:'🟢',title:'On shift'}:{dot:'red',symbol:'🔴',title:'Off shift'};
 function App(){const[selected,setSelected]=useState([]);window.select=keys=>setSelected(keys);window.chosen=selected;return <WaterOrderDriverPicker drivers={drivers} selectedKeys={selected} onChange={setSelected} shiftForDriver={shiftForDriver}/>;}createRoot(document.getElementById('root')).render(<App/>);`);
 let esbuild;try{esbuild=require('esbuild');}catch{const fixed=command=>cp.execFileSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',command],{encoding:'utf8'});const cache=path.join(fixed('npm config get cache').trim(),'_npx');const all=fs.readdirSync(cache).map(n=>path.join(cache,n,'node_modules/esbuild/lib/main.js')).filter(fs.existsSync);all.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);esbuild=require(all[0]);}
 esbuild.buildSync({entryPoints:[path.join(dir,'entry.jsx')],bundle:true,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},nodePaths:[path.join(root,'node_modules')],outfile:path.join(dir,'bundle.js'),alias:{'@/lib/operationalDriverName':path.join(root,'src/lib/operationalDriverName.ts')},logLevel:'silent'});
 const css=fs.readdirSync('out/_next/static/css').filter(f=>f.endsWith('.css')).map(f=>fs.readFileSync(path.join('out/_next/static/css',f),'utf8')).join('\n');
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?fs.readFileSync(path.join(dir,'bundle.js')):'<style>'+css+'</style><main style="padding:12px;max-width:760px;background:#111827;color:white"><div id="root"></div></main><script src="/bundle.js"></script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:768,height:900}});await page.goto('http://127.0.0.1:'+server.address().port);
  const section=page.getByRole('region',{name:'Water order drivers'}); // section has an accessible name
  const toggle=page.getByRole('button',{name:/Drivers.*selected/});await toggle.waitFor();assert.equal(await page.getByRole('checkbox').count(),0,'Roster starts collapsed');assert.ok((await section.boundingBox()).height<110);
  await toggle.click();assert.equal(await page.getByRole('checkbox').count(),42);assert.equal(await page.getByText('private-login',{exact:true}).count(),0);
  await page.getByRole('button',{name:'On shift (35)',exact:true}).click();assert.equal(await page.getByRole('checkbox').count(),35);
  await page.getByRole('button',{name:'Select shown (35)',exact:true}).click();assert.equal(await page.evaluate(()=>window.chosen.length),35);
  const before=await page.evaluate(()=>window.chosen);
  await page.getByRole('searchbox',{name:'Search drivers'}).fill('Driver 40');assert.equal(await page.getByRole('checkbox').count(),0,'On-shift filter stays in effect');
  await page.getByRole('button',{name:'All (42)',exact:true}).click();await page.getByRole('checkbox',{name:/Driver 40/}).check();assert.equal(await page.evaluate(()=>window.chosen.length),36);assert.deepEqual((await page.evaluate(()=>window.chosen)).slice(0,35),before,'Search must preserve hidden selected drivers and their planning order');
  await page.getByRole('searchbox',{name:'Search drivers'}).fill('');await page.getByRole('button',{name:'Selected (36)',exact:true}).click();assert.equal(await page.getByRole('checkbox').count(),36);
  await page.getByRole('checkbox',{name:/Driver 01/}).click();assert.equal(await page.evaluate(()=>window.chosen.includes('fixture-0')),false);
  await page.getByRole('button',{name:'Done',exact:true}).click();assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await page.getByRole('checkbox').count(),0);assert.ok((await section.boundingBox()).height<135,'35 selected drivers must not produce a wall of chips');assert.match(await section.innerText(),/\+33 more/);
  for(const width of [320,344,768,1280]){
   await page.setViewportSize({width,height:800});await toggle.click();await page.getByRole('button',{name:'All (42)',exact:true}).click();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No horizontal overflow at '+width);
   const roster=page.getByRole('list',{name:'Driver roster'});const box=await roster.boundingBox();assert.ok(box.height<=270,'Driver list is bounded at '+width);
   assert.equal(await roster.evaluate(el=>el.scrollHeight>el.clientHeight),true,'Full roster scrolls internally');
   await page.getByRole('searchbox',{name:'Search drivers'}).press('Escape');assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await toggle.evaluate(el=>el===document.activeElement),true);
  }
  await toggle.click();await page.getByRole('button',{name:'Clear selection',exact:true}).click();assert.equal(await page.evaluate(()=>window.chosen.length),0);
  await page.evaluate(()=>window.select(['missing-roster-key']));await page.getByRole('alert').filter({hasText:'no longer in this roster'}).waitFor();assert.deepEqual(await page.evaluate(()=>window.chosen),['missing-roster-key'],'Unavailable selection cannot silently disappear');
  console.log('Water-order driver picker PASSED: 42-driver roster, 35-driver shift, compact summary, search/filter selection retention, planning order, bulk selection, keyboard, unavailable selection and four responsive widths');
 }finally{await browser.close();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
