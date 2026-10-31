// Actual shipped React pages/panel in Chromium; Firebase/Auth are mocked.
// No real invitations, accounts, grants, emails or company records are created.
import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const stubs = {
  'next/link': `import React from 'react'; export default function Link(p){return React.createElement('a',p,p.children)}`,
  '@/contexts/AuthContext': `export const useAuth=()=>({user:window.__mode==='admin'?{uid:'owner',companyId:'company-a'}:window.__user,userCompany:{}})`,
  '@/lib/firebase': `export const getFirebaseFunctions=()=>({})`,
  'firebase/functions': `export const httpsCallable=(_,name)=>async payload=>({data:await window.__call(name,payload)})`,
  '@/lib/auth': `export const hasCapability=()=>window.__allowed!==false;export const DEFAULT_ROLE_LABELS={driver:'Driver',dispatch:'Dispatch',payroll:'Payroll',safety:'Safety',lead:'Lead',manager:'Manager',admin:'Admin',viewer:'Viewer'};export const registerEmployeeWithEmail=payload=>window.__call('registerEmployeeWithEmail',payload)`,
  './CompanyJoinCodeCard': `export const CompanyJoinCodeCard=()=>null`,
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
    window.__status=extra.status||{status:'none'};window.__requests=extra.requests||[];
    window.__call=async(name,payload)=>{
      window.__calls.push({name,payload});
      if(name==='getEmployeeInvitation'){if(extra.expired)throw Error('expired');return {companyName:'Employer A'};}
      if(name==='registerEmployeeWithEmail')return {status:'pending',companyName:'Employer A',displayName:payload.displayName};
      if(name==='getEmployeeJoinStatus')return window.__status;
      if(name==='listEmployeeJoinRequests')return {requests:window.__requests};
      if(name==='createEmployeeInvitation')return {url:'https://wellbuilt-sync.web.app/join/#invite=private-token'};
      if(name==='resolveEmployeeJoin'){window.__requests=[];return {status:payload.action==='approve'?'complete':'rejected'};}
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

  page=await open('join',{expired:true},'#invite=expired');await page.getByRole('alert').waitFor();await page.getByRole('button',{name:'Use a company code instead'}).click();await page.getByLabel('Company code',{exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'');await page.close();

  page=await open('join',{user:{uid:'employee'},status:{status:'rejected',companyName:'Employer A',displayName:'New Employee'}});await page.getByRole('heading',{name:'Request declined'}).waitFor();assert.ok((await page.locator('body').innerText()).includes('Contact your employer'));await page.close();

  const request={uid:'employee',legalName:'Employee Legal',displayName:'New Employee',email:'employee@example.test',status:'pending',roles:['driver']};
  page=await open('admin',{requests:[request]});await page.getByRole('button',{name:'Invite Employee',exact:true}).click();await page.getByLabel('Private signup link').waitFor();assert.ok((await page.getByRole('link',{name:'Email link'}).getAttribute('href')).includes('mailto:'));
  await page.getByRole('checkbox',{name:'Driver',exact:true}).uncheck();await page.getByRole('checkbox',{name:'Dispatch',exact:true}).check();await page.getByRole('button',{name:'Approve employee'}).click();await page.getByText('Employee approved. They can check approval on the signup page or sign in.').waitFor();
  input=(await page.evaluate(()=>window.__calls)).find(x=>x.name==='resolveEmployeeJoin').payload;assert.deepEqual(input,{uid:'employee',action:'approve',roles:['dispatch']});await page.close();

  page=await open('admin',{requests:[{...request,status:'ready',roles:['dispatch']}]});await page.getByRole('checkbox',{name:'Dispatch',exact:true}).waitFor();assert.equal(await page.getByRole('checkbox',{name:'Dispatch',exact:true}).isChecked(),true);assert.equal(await page.getByRole('checkbox',{name:'Dispatch',exact:true}).isDisabled(),true);await page.getByRole('button',{name:'Approve employee'}).click();await page.getByText('Employee approved. They can check approval on the signup page or sign in.').waitFor();await page.close();

  page=await open('admin',{allowed:false});assert.equal(await page.getByRole('button',{name:'Invite Employee',exact:true}).count(),0);await page.close();
  console.log('PASS actual React DOM: code/invite signup, pending/approved/declined states, expired-link fallback, no applicant role injection, Invite/Email controls, dispatch approval, retry locked to approved responsibilities, unauthorized controls hidden. No production data or email operations.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
