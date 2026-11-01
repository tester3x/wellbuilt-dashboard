import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';

// Mount the actual chat page. Only authentication and server transport are mocked.
const transport = `
const profile={id:'fixture-profile',name:'Fixture monitor',gridLayout:'2x2',slots:[null,null,null,null]};
const thread={id:'dispatch_fixture',title:'Fixture Driver',type:'direct',audience:'dispatch_team',status:'active',participants:['driver:fixture'],participantNames:{'driver:fixture':'Fixture Driver'},lastMessage:{text:'Fixture message',senderId:'driver:fixture',timestamp:new Date().toISOString()},updatedAt:new Date().toISOString()};
window.fixtureSaves=[];
export const chatIntentId=()=> 'fixture-id';
export const sendStaffChat=async()=>{};
export function watchStaffChatCompany(cb){setTimeout(()=>cb('fixture-company'),0);return()=>{};}
export function watchStaffChat(data,cb){
 if(data.action==='profiles') {window.profileSnapshot=()=>cb([structuredClone(profile)]);setTimeout(()=>cb(location.search.includes('missing')?[]:[structuredClone(profile)]),0);}
 if(data.action==='threads')setTimeout(()=>cb([thread]),0);
 if(data.action==='messages')setTimeout(()=>cb([]),0);
 return()=>{};
}
export async function staffChatCall(data){
 if(data.action==='directory')return {drivers:[]};
 if(data.action==='saveProfile')return new Promise((resolve,reject)=>{window.fixtureSaves.push(data);window.finishSave=(ok)=>{if(ok){profile.slots=data.record.slots;resolve({ok:true});}else reject(new Error('Fixture denied'));};});
 return {ok:true};
}
`;
const bundle = await build({stdin:{contents:`
import React from 'react';import {createRoot} from 'react-dom/client';import ChatPage from './src/app/chat/page';
localStorage.setItem('wb-chat-profile-stack',JSON.stringify(location.search.includes('missing')?[]:['fixture-profile']));
createRoot(document.getElementById('root')).render(<ChatPage/>);
`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'fixture-ports',setup(b){
 b.onResolve({filter:/^@\/(contexts\/AuthContext|lib\/(auth|firebase|staffChatClient))$/},args=>({path:args.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.endsWith('AuthContext')?`const user={uid:'fixture-staff',companyId:'fixture-company',role:'admin'};export const useAuth=()=>({user,userCompany:{},loading:false});`:args.path.endsWith('/auth')?'export const hasCapability=()=>true;':args.path.endsWith('/firebase')?'export const getFirestoreDb=()=>({});':transport,loader:'js'}));
}}]});
const css=fs.readdirSync('out/_next/static/css').filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync('out/_next/static/css/'+n,'utf8')).join('\n');
const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle.outputFiles[0].contents:`<style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch();
try {
 for(const scenario of ['success','failure','missing']) {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.goto(`http://127.0.0.1:${server.address().port}/?${scenario}`);
  const picker=page.getByRole('button',{name:'New conversation',exact:true});
  await picker.click();
  assert.equal(await page.getByRole('button',{name:'Close conversation list',exact:true}).getAttribute('aria-expanded'),'true');
  await page.getByRole('button',{name:'Close conversation list',exact:true}).click();
  assert.equal(await picker.getAttribute('aria-expanded'),'false');
  await page.getByRole('button').filter({hasText:'Fixture Driver'}).first().click();
  const lock=page.getByTitle('Lock to this profile slot',{exact:true});
  await lock.click();
  if(scenario==='missing') {
   await page.getByText('Select a monitor profile before locking a chat position.',{exact:true}).waitFor();
   assert.equal(await page.getByTitle('Close temporary chat').count(),1,'no profile keeps the chat open');
   assert.equal(await page.evaluate(()=>window.fixtureSaves.length),0);
  } else {
   await page.waitForFunction(()=>!!window.finishSave);
   assert.equal(await page.locator('textarea').count(),1,'pending save keeps the pane');
   await page.evaluate(ok=>window.finishSave(ok),scenario==='success');
   if(scenario==='failure') {
    await page.getByText('Could not update profile layout. Check your access.',{exact:true}).waitFor();
    assert.equal(await page.getByTitle('Close temporary chat').count(),1,'failed save preserves temporary chat');
   } else {
    await page.getByTitle('Saving chat position').waitFor();
    assert.equal(await page.locator('textarea').count(),1,'acknowledged save retains overlay until subscription confirms');
    const saved=await page.evaluate(()=>window.fixtureSaves[0]);
    assert.equal(saved.record.slots[0].threadId,'dispatch_fixture','lock saves the same grid position');
    await page.evaluate(()=>window.profileSnapshot());
    await page.getByTitle('Unlock (temporary)',{exact:true}).waitFor();
    assert.equal(await page.locator('textarea').count(),1,'confirmed lock keeps chat visible');
    assert.equal(await page.getByTitle('Close temporary chat').count(),0);
    await page.getByTitle('Unlock (temporary)',{exact:true}).click();
    await page.getByTitle('Saving chat position').waitFor();
    await page.evaluate(()=>window.finishSave(true));
    await page.getByTitle('Lock to this profile slot',{exact:true}).waitFor();
    await page.evaluate(()=>window.profileSnapshot());
    assert.equal(await page.locator('textarea').count(),1,'unlock keeps chat visible');
   }
  }
  await page.close();
 }
 console.log('Actual chat page: picker toggle labels; pending, successful, failed and missing-profile locks; same position; unlock retains chat.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
