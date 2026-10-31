// Actual shipped React pages/panel in Chromium; Firebase/Auth are mocked.
// No real invitations, accounts, grants, emails or company records are created.
import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const stubs = {
  'next/link': `import React from 'react'; export default function Link(p){return React.createElement('a',p,p.children)}`,
  '@/contexts/AuthContext': `import {useEffect,useState} from 'react';export const useAuth=()=>{const [,refresh]=useState(0);useEffect(()=>{const changed=()=>refresh(n=>n+1);window.addEventListener('auth-fixture-change',changed);return()=>window.removeEventListener('auth-fixture-change',changed)},[]);return {user:window.__mode==='admin'?(window.__adminUser||{uid:'owner',companyId:'company-a'}):window.__user,userCompany:{},operatingCompanyId:window.__company}}`,
  '@/lib/firebase': `export const getFirebaseFunctions=()=>({})`,
  'firebase/functions': `export const httpsCallable=(_,name)=>async payload=>({data:await window.__call(name,payload)})`,
  '@/lib/auth': `export const isPlatformAdmin=user=>user?.uid==='platform-owner';export const hasCapability=()=>window.__allowed!==false;export const DEFAULT_ROLE_LABELS={driver:'Driver',dispatch:'Dispatch',payroll:'Payroll',safety:'Safety',lead:'Lead',manager:'Manager',admin:'Admin',viewer:'Viewer'};export const registerEmployeeWithEmail=payload=>window.__call('registerEmployeeWithEmail',payload)`,
  './CompanyJoinCodeCard': `import React from 'react';export const CompanyJoinCodeCard=()=>React.createElement('div',null,'Reusable code fallback')`,
};
const bundle = await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Join from './src/app/join/page';import {EmployeeOnboardingPanel as Panel} from './src/components/admin/EmployeeOnboardingPanel';createRoot(document.getElementById('root')).render(window.__mode==='admin'?React.createElement(Panel):React.createElement(Join));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'mock-external-services',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(stubs,a.path)?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:stubs[a.path],loader:'js',resolveDir:process.cwd()}));}}]});
const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle.outputFiles[0].contents:'<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();
async function open(mode='join',extra={},hash=''){
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.addInitScript(({mode,extra})=>{
    window.__mode=mode;window.__calls=[];window.__user=extra.user||null;window.__allowed=extra.allowed;
    window.__adminUser=extra.adminUser;window.__company=extra.company;window.__readFails=extra.readFails;window.__deferLists=extra.deferLists;window.__pendingLists=[];window.__status=extra.status||{status:'none'};window.__requests=extra.requests||[];
    if(extra.manualIntervals){
      window.__activeIntervals=new Map();let nextId=90000;
      const nativeInterval=window.setInterval.bind(window),nativeClear=window.clearInterval.bind(window);
      window.setInterval=(fn,ms,...args)=>{if(ms===5000){const id=++nextId;window.__activeIntervals.set(id,fn);return id;}return nativeInterval(fn,ms,...args);};
      window.clearInterval=id=>{window.__activeIntervals.delete(id);nativeClear(id);};
      window.__visibility='visible';window.__isOnline=true;
      Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__visibility});
      Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>window.__isOnline});
    }
    window.__call=async(name,payload)=>{
      window.__calls.push({name,payload});
      if(name==='getEmployeeInvitation'){if(extra.expired)throw Error('expired');return {companyName:'Employer A'};}
      if(name==='registerEmployeeWithEmail')return {status:'pending',companyName:'Employer A',displayName:payload.displayName};
      if(name==='getEmployeeJoinStatus')return window.__status;
      if(name==='listEmployeeJoinRequests'){if(window.__deferLists)return new Promise(resolve=>window.__pendingLists.push(resolve));if(window.__readFails)throw Object.assign(Error('denied'),{code:'functions/permission-denied'});return {requests:window.__requests};}
      if(name==='createEmployeeInvitation')return {url:'https://wellbuilt-sync.web.app/join/#invite=private-token-'+window.__calls.filter(call=>call.name==='createEmployeeInvitation').length};
      if(name==='resolveEmployeeJoin'){if(extra.deferResolve)await new Promise(resolve=>window.__finishApproval=resolve);window.__requests=[];return {status:payload.action==='approve'?'complete':'rejected'};}
      throw Error('Unexpected callable '+name);
    };
  },{mode,extra});
  await page.goto(base+'/join/'+hash);return page;
}
async function fill(page){
  for(const [label,value] of [['Full name','Employee Legal'],['App sign-in name','New Employee'],['Email','employee@example.test'],['Password','private-test-password'],['Confirm password','private-test-password']])await page.getByLabel(label,{exact:true}).fill(value);
}
try{
  let page=await open();await page.getByLabel('Company code',{exact:true}).fill('VALIDCODE');await fill(page);
  await page.getByRole('button',{name:'Request to join company'}).click();await page.getByRole('heading',{name:'Waiting for company approval'}).waitFor();
  let calls=await page.evaluate(()=>window.__calls);let input=calls.find(x=>x.name==='registerEmployeeWithEmail').payload;
  assert.equal(input.companyCode,'VALIDCODE');assert.ok(!('roles' in input)&&!('companyId' in input));
  assert.equal(await page.locator('input[type=checkbox]').count(),0);assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  await page.evaluate(()=>window.__status={status:'complete',companyName:'Employer A',displayName:'New Employee'});await page.getByRole('button',{name:'Check approval'}).click();await page.getByRole('heading',{name:'You’re approved'}).waitFor();assert.equal(await page.getByRole('link',{name:'Open Dashboard'}).getAttribute('href'),'/');await page.close();

  page=await open('join',{},'#invite=opaque');await page.getByText('Invitation to Employer A',{exact:true}).waitFor();assert.equal(await page.getByLabel('Company code',{exact:true}).count(),0);await fill(page);await page.getByRole('button',{name:'Request to join company'}).click();await page.getByRole('heading',{name:'Waiting for company approval'}).waitFor();input=(await page.evaluate(()=>window.__calls)).find(x=>x.name==='registerEmployeeWithEmail').payload;assert.equal(input.invitationToken,'opaque');assert.ok(!('companyCode' in input));await page.close();

  page=await open('join',{expired:true},'#invite=expired');await page.getByRole('alert').waitFor();await page.getByRole('button',{name:'Use a company code instead'}).click();await page.getByLabel('Company code',{exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'');
  await page.evaluate(()=>{location.hash='invite=expired-again';});await page.getByRole('alert').waitFor();assert.equal(await page.getByLabel('Company code',{exact:true}).count(),0,'same-tab invitation hash navigation must be observed');await page.close();

  page=await open('join',{user:{uid:'employee'},status:{status:'rejected',companyName:'Employer A',displayName:'New Employee'}});await page.getByRole('heading',{name:'Request declined'}).waitFor();assert.ok((await page.locator('body').innerText()).includes('Contact your employer'));await page.close();

  const request={uid:'employee',legalName:'Employee Legal',displayName:'New Employee',email:'employee@example.test',status:'pending',roles:['driver']};
  page=await open('admin',{requests:[request]});await page.getByRole('button',{name:'Invite Employee',exact:true}).click();await page.getByLabel('Private signup link').waitFor();assert.ok((await page.getByRole('link',{name:'Email link'}).getAttribute('href')).includes('mailto:'));
  await page.getByRole('checkbox',{name:'Driver',exact:true}).uncheck();await page.getByRole('checkbox',{name:'Dispatch',exact:true}).check();await page.getByRole('button',{name:'Approve employee'}).click();await page.getByText('Employee approved. They can check approval on the signup page or sign in.').waitFor();
  input=(await page.evaluate(()=>window.__calls)).find(x=>x.name==='resolveEmployeeJoin').payload;assert.deepEqual(input,{uid:'employee',action:'approve',roles:['dispatch']});await page.close();

  page=await open('admin',{requests:[{...request,status:'ready',roles:['dispatch']}]});await page.getByRole('checkbox',{name:'Dispatch',exact:true}).waitFor();assert.equal(await page.getByRole('checkbox',{name:'Dispatch',exact:true}).isChecked(),true);assert.equal(await page.getByRole('checkbox',{name:'Dispatch',exact:true}).isDisabled(),true);await page.getByRole('button',{name:'Approve employee'}).click();await page.getByText('Employee approved. They can check approval on the signup page or sign in.').waitFor();await page.close();

  page=await open('admin',{adminUser:{uid:'platform-owner'},company:'company-a',requests:[request]});
  await page.getByRole('checkbox',{name:'Dispatch',exact:true}).waitFor();
  assert.deepEqual((await page.evaluate(()=>window.__calls)).find(x=>x.name==='listEmployeeJoinRequests').payload,{viewedCompanyId:'company-a'});
  await page.getByRole('button',{name:'Invite Employee',exact:true}).click();await page.getByLabel('Private signup link').waitFor();
  assert.deepEqual((await page.evaluate(()=>window.__calls)).find(x=>x.name==='createEmployeeInvitation').payload,{viewedCompanyId:'company-a'});
  await page.getByRole('button',{name:'Approve employee'}).click();await page.getByText('Employee approved. They can check approval on the signup page or sign in.').waitFor();
  assert.equal((await page.evaluate(()=>window.__calls)).find(x=>x.name==='resolveEmployeeJoin').payload.viewedCompanyId,'company-a');await page.close();
  page=await open('admin',{adminUser:{uid:'platform-owner'}});await page.getByText('Select a company in the header to manage employee onboarding.').waitFor();assert.equal((await page.evaluate(()=>window.__calls)).length,0);assert.equal(await page.getByRole('button',{name:'Invite Employee',exact:true}).isDisabled(),true);await page.close();
  page=await open('admin',{readFails:true});await page.getByRole('alert').waitFor();await page.getByRole('heading',{name:'New employee requests (unavailable)'}).waitFor();assert.equal(await page.getByRole('heading',{name:'New employee requests (0)'}).count(),0);
  await page.evaluate(()=>window.__readFails=false);await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('heading',{name:'New employee requests (0)'}).waitFor();assert.equal(await page.getByRole('alert').count(),0);await page.close();
  page=await open('admin',{adminUser:{uid:'platform-owner'},company:'company-a',deferLists:true});
  await page.waitForFunction(()=>window.__pendingLists.length===1);
  await page.evaluate(()=>{window.__company='company-b';window.dispatchEvent(new Event('auth-fixture-change'));});await page.waitForFunction(()=>window.__pendingLists.length===2);
  await page.evaluate(()=>window.__pendingLists[1]({requests:[]}));await page.getByRole('heading',{name:'New employee requests (0)'}).waitFor();
  await page.evaluate(request=>window.__pendingLists[0]({requests:[request]}),request);await page.waitForTimeout(100);
  assert.equal(await page.getByRole('checkbox',{name:'Dispatch',exact:true}).count(),0,'old company results must never replace the selected company');
  assert.equal(await page.getByRole('heading',{name:'New employee requests (0)'}).count(),1);await page.close();
  page=await open('admin');
  assert.equal(await page.getByText('Reusable code fallback',{exact:true}).isVisible(),false,'reusable code must stay out of the primary invite flow');
  await page.getByRole('button',{name:'Invite Employee',exact:true}).click();await page.getByLabel('Private signup link').waitFor();
  const firstLink=await page.getByLabel('Private signup link').inputValue();
  await page.getByText('New private invitation ready. This link is for one employee and expires in seven days.').waitFor();
  assert.equal(await page.getByText('Reusable code fallback',{exact:true}).isVisible(),false);
  await page.getByRole('button',{name:'Invite Employee',exact:true}).click();await page.waitForFunction(first=>document.querySelector('input[readonly]')?.value!==first,firstLink);
  assert.notEqual(await page.getByLabel('Private signup link').inputValue(),firstLink,'the displayed invitation must be replaced by each newly generated link');
  const beforeFallback=(await page.evaluate(()=>window.__calls)).length;
  await page.getByText('Other ways to join',{exact:true}).click();assert.equal(await page.getByText('Reusable code fallback',{exact:true}).isVisible(),true);
  assert.equal((await page.evaluate(()=>window.__calls)).length,beforeFallback,'opening the fallback must not generate another invitation');await page.close();
  page=await open('admin',{manualIntervals:true});await page.getByRole('heading',{name:'New employee requests (0)'}).waitFor();
  await page.evaluate(request=>{window.__requests=[request];for(const tick of window.__activeIntervals.values())tick();},request);
  await page.getByRole('heading',{name:'New employee requests (1)'}).waitFor();
  await page.getByRole('checkbox',{name:'Driver',exact:true}).uncheck();await page.getByRole('checkbox',{name:'Dispatch',exact:true}).check();
  const listCalls=()=>page.evaluate(()=>window.__calls.filter(call=>call.name==='listEmployeeJoinRequests').length);
  let callCount=await listCalls();
  await page.evaluate(()=>{window.__deferLists=true;for(const tick of window.__activeIntervals.values()){tick();tick();}});
  await page.waitForFunction(()=>window.__pendingLists.length===1);
  assert.equal(await listCalls(),callCount+1,'slow automatic reads must not overlap');
  assert.equal(await page.getByRole('heading',{name:'New employee requests (1)'}).count(),1,'background reads must keep the loaded list visible');
  assert.equal(await page.getByRole('checkbox',{name:'Dispatch',exact:true}).isChecked(),true);
  await page.evaluate(request=>{window.__deferLists=false;window.__requests=[request,{...request,uid:'employee-2',legalName:'Another Employee'}];window.__pendingLists[0]({requests:window.__requests});},request);
  await page.getByRole('heading',{name:'New employee requests (2)'}).waitFor();
  assert.equal(await page.getByRole('checkbox',{name:'Dispatch',exact:true}).first().isChecked(),true,'automatic updates must preserve selected responsibilities');
  assert.equal(await page.getByRole('checkbox',{name:'Driver',exact:true}).first().isChecked(),false);
  callCount=await listCalls();await page.evaluate(()=>{window.__visibility='hidden';for(const tick of window.__activeIntervals.values())tick();});assert.equal(await listCalls(),callCount,'hidden tabs do not poll');
  await page.evaluate(()=>{window.__requests=[];window.__visibility='visible';document.dispatchEvent(new Event('visibilitychange'));});await page.getByRole('heading',{name:'New employee requests (0)'}).waitFor();assert.equal(await listCalls(),callCount+1,'returning to the tab refreshes without a button click');
  callCount=await listCalls();await page.evaluate(()=>{window.__isOnline=false;for(const tick of window.__activeIntervals.values())tick();});assert.equal(await listCalls(),callCount,'offline tabs do not poll');
  await page.evaluate(request=>{window.__requests=[request];window.__isOnline=true;window.dispatchEvent(new Event('online'));},request);await page.getByRole('heading',{name:'New employee requests (1)'}).waitFor();
  callCount=await listCalls();await page.evaluate(()=>{window.__allowed=false;window.dispatchEvent(new Event('auth-fixture-change'));});await page.waitForFunction(()=>window.__activeIntervals.size===0);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal(await listCalls(),callCount,'losing access cleans up timers and event listeners');await page.close();
  page=await open('admin',{manualIntervals:true,requests:[request],deferResolve:true});await page.getByRole('button',{name:'Approve employee'}).waitFor();
  const beforeApproval=await page.evaluate(()=>window.__calls.filter(call=>call.name==='listEmployeeJoinRequests').length);
  await page.getByRole('button',{name:'Approve employee'}).click();await page.waitForFunction(()=>typeof window.__finishApproval==='function');
  await page.evaluate(()=>{for(const tick of window.__activeIntervals.values())tick();});
  assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call.name==='listEmployeeJoinRequests').length),beforeApproval,'automatic reads pause during approval');
  await page.evaluate(()=>window.__finishApproval());await page.getByText('Employee approved. They can check approval on the signup page or sign in.').waitFor();await page.getByRole('heading',{name:'New employee requests (0)'}).waitFor();await page.close();
  page=await open('admin',{manualIntervals:true});await page.getByRole('heading',{name:'New employee requests (0)'}).waitFor();
  await page.evaluate(()=>{window.__readFails=true;for(const tick of window.__activeIntervals.values())tick();});await page.getByRole('alert').waitFor();
  const failedReadCount=await page.evaluate(()=>window.__calls.filter(call=>call.name==='listEmployeeJoinRequests').length);
  await page.evaluate(()=>{for(const tick of window.__activeIntervals.values())tick();});assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call.name==='listEmployeeJoinRequests').length),failedReadCount,'failed automatic reads back off');
  await page.evaluate(()=>window.__readFails=false);await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('heading',{name:'New employee requests (0)'}).waitFor();assert.equal(await page.getByRole('alert').count(),0,'manual recovery is allowed during backoff');await page.close();
  page=await open('admin',{allowed:false});assert.equal(await page.getByRole('button',{name:'Invite Employee',exact:true}).count(),0);await page.close();
  console.log('PASS actual React DOM: automatic request pickup, stable role selections, serialized reads, visibility/online resume, cleanup and retry backoff; code/invite signup, pending/approved/declined states, expired-link fallback, no applicant role injection, Invite/Email controls, dispatch approval, retry locked to approved responsibilities, unauthorized controls hidden. No production data or email operations.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
