import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';

// Mount the actual chat page. Only authentication and server transport are mocked.
const transport = `
const drivers=Array.from({length:24},(_,i)=>({hash:'d'+String(i+1).padStart(2,'0'),name:'Driver '+String(i+1).padStart(2,'0')}));
const profile={id:'fixture-profile',name:'Laptop profile',gridLayout:'2x2',threadType:'all',slots:[null,null,null,null]};
const threads=drivers.slice(0,12).map(d=>({id:'dispatch_'+d.hash,title:d.name,type:'direct',audience:'dispatch_team',status:'active',participants:['driver:'+d.hash],participantNames:{['driver:'+d.hash]:d.name},lastMessage:{text:'Fixture message',senderId:'driver:'+d.hash,timestamp:new Date().toISOString()}}));
window.fixtureSaves=[];window.profileCallbacks=[];
export const chatIntentId=()=> 'fixture-id';export const sendStaffChat=async()=>{};
export function watchStaffChatCompany(cb){setTimeout(()=>cb('fixture-company'),0);return()=>{};}
export function watchStaffChat(data,cb){if(data.action==='profiles'){window.profileCallbacks.push(cb);setTimeout(()=>cb([structuredClone(profile)]),0);}if(data.action==='threads')setTimeout(()=>cb(threads),0);if(data.action==='messages')setTimeout(()=>cb([]),0);return()=>{};}
export async function staffChatCall(data){
 if(data.action==='directory')return {drivers};
 if(data.action==='saveProfile'){window.fixtureSaves.push(structuredClone(data));Object.assign(profile,data.record);setTimeout(()=>window.profileCallbacks.forEach(cb=>cb([structuredClone(profile)])),50);return {ok:true};}
 if(data.action==='dispatch')return {threadId:'dispatch_'+data.driverId};return {ok:true};
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
const center=async locator=>{const b=await locator.boundingBox();assert.ok(b);return {x:b.x+b.width/2,y:b.y+b.height/2};};
async function drag(page,from,to,touch=false){const a=await center(from),b=await center(to);if(touch){const cdp=await page.context().newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a]});await page.waitForTimeout(520);await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[b]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}else{await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(a.x+10,a.y);await page.mouse.move(b.x,b.y,{steps:8});await page.mouse.up();}}
try{
 for(const [width,height] of [[1366,768],[1536,864],[1280,720]]){
  const page=await browser.newPage({viewport:{width,height},hasTouch:true});page.setDefaultTimeout(8000);await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button',{name:'New conversation',exact:true}).click();await page.locator('[data-chat-driver="d01"]').waitFor();
  const before=await page.locator('#new-conversation-list').boundingBox();await page.getByTitle('Setup grid',{exact:true}).click();const panel=page.getByRole('complementary',{name:'Profile settings'});await panel.waitFor();
  const after=await page.locator('#new-conversation-list').boundingBox(),settings=await panel.boundingBox(),sidebar=await page.locator('[data-chat-sidebar]').boundingBox();
  assert.ok(after.height>=before.height-8,'Settings does not shrink the driver list');assert.ok(after.height>250,'useful laptop roster height');assert.ok(settings.x>=sidebar.x+sidebar.width-1,'settings beside list');
  const visible=await page.locator('[data-chat-driver]').evaluateAll(rows=>rows.filter(row=>{const a=row.getBoundingClientRect(),b=row.parentElement.getBoundingClientRect();return a.top>=b.top&&a.bottom<=b.bottom&&a.bottom<=innerHeight;}).length);assert.ok(visible>=4,'multiple whole drivers visible at once');
  await page.locator('[data-chat-driver="d01"]').click();await page.locator('[data-chat-drag-header="dispatch_d01"]').waitFor();assert.equal(await panel.count(),1,'click works while Settings stays open');
  await page.getByRole('button',{name:'New conversation',exact:true}).click();await drag(page,page.locator('[data-chat-driver="d02"]'),page.locator('[data-chat-slot="3"]'));
  await page.locator('[data-chat-slot="3"] [data-chat-drag-header="dispatch_d02"]').waitFor();
  await page.getByRole('button',{name:'New conversation',exact:true}).click();await drag(page,page.locator('[data-chat-driver="d03"]'),page.locator('[data-chat-slot="1"]'),true);await page.locator('[data-chat-slot="1"] [data-chat-drag-header="dispatch_d03"]').waitFor();
  await page.locator('[data-chat-slot="0"]').getByTitle('Lock to this profile slot',{exact:true}).click();await page.getByRole('button',{name:'Save and lock',exact:true}).click();await page.locator('[data-chat-slot="0"]').getByTitle('Unlock (temporary)',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.fixtureSaves.at(-1).record.slots[0].threadId),'dispatch_d01','preview can be saved without closing Settings');
  await page.getByRole('button',{name:'Close profile settings',exact:true}).click();assert.equal(await panel.count(),0);
  assert.equal(await page.locator('[data-chat-drag-header]').count(),3);
  if(width===1366){await page.getByTitle('Setup grid',{exact:true}).click();await page.screenshot({path:'C:/dev/tmp/chat-settings-laptop-fixture.png'});}
  await page.close();
 }
 console.log('PASS actual laptop Settings: separate scroll column, unchanged usable roster height at 1280/1366/1536, click/mouse/touch placement while open, chat preview and save/lock, close preserves grid');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
