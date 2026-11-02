import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';

// Mount the actual chat page. Only authentication and server transport are mocked.
const transport = `
const profile={id:'fixture-profile',name:'Only layout',gridLayout:'2x2',slots:[null,null,null,null]};
const threads=[{id:'whatsapp_levels_fixture',title:'WhatsApp Levels',type:'whatsapp_levels',permanent:true,readOnly:true,status:'active',participants:[],participantNames:{},unreadCount:0},{id:'dispatch_A',title:'Driver A',type:'direct',audience:'dispatch_team',status:'active',participants:['driver:A'],participantNames:{}}];
const pull=(id,wellName,wellKey,driverKey,senderName)=>({id,text:wellName+' full copy body',wellName,wellKey,driverKey,senderName,senderId:'whatsapp:'+driverKey,type:'level_report',channel:'North Area',top:12,reportedBottom:8,after:8,bbls:140,provisional:false,timestamp:'2026-11-02T01:00:00Z'});
window.rows=[pull('a','Olson','olson','tag:adam','Adam tag'),pull('b','Dwyer','dwyer','tag:adam','Adam tag'),pull('c','Dwyer','dwyer','tag:luiz','Luiz tag'),pull('u','Well needs identification','__unidentified__','tag:unknown','Unknown tag')];window.feedCallbacks=[];window.fixtureReads=[];
window.publishFeed=next=>{window.rows=next;window.feedCallbacks.forEach(cb=>cb(structuredClone(next)));};
export const chatIntentId=()=> 'fixture-id';export const sendStaffChat=async()=>{throw Error('Must not send');};
export function watchStaffChatCompany(cb){setTimeout(()=>cb('fixture-company'),0);return()=>{};}
export function watchStaffChat(data,cb){
 if(data.action==='profiles')setTimeout(()=>cb([profile]),0);
 if(data.action==='threads')setTimeout(()=>cb(threads),0);
 if(data.action==='messages'){
  if(data.threadId.startsWith('whatsapp_levels_')){window.feedCallbacks.push(cb);setTimeout(()=>cb(structuredClone(window.rows)),0);return()=>{window.feedCallbacks=window.feedCallbacks.filter(x=>x!==cb);};}
  setTimeout(()=>cb([{id:'normal',text:'Normal chat remains separate',senderId:'driver:A',senderName:'Driver A',type:'text',timestamp:new Date().toISOString()}]),0);
 }
 return()=>{};
}
export async function staffChatCall(data){if(data.action==='read')window.fixtureReads.push(data.threadId);return {ok:true,drivers:[]};}
`;
const bundle = await build({stdin:{contents:`
import React from 'react';import {createRoot} from 'react-dom/client';import ChatPage from './src/app/chat/page';import {ChatSidebar} from './src/components/chat/ChatSidebar';import {openChatWorkspace} from './src/lib/chatWindows';window.openFixtureChat=openChatWorkspace;
localStorage.setItem('wb-chat-profile-stack',JSON.stringify(location.search.includes('missing')?[]:['fixture-profile']));
createRoot(document.getElementById('root')).render(<><button onClick={()=>openChatWorkspace()}>Focus fixture workspace</button>{location.pathname==='/sidebar' ? <ChatSidebar visible={true} onClose={()=>{}} userId="fixture-staff"/> : <ChatPage/>}</>);
`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'fixture-ports',setup(b){
 b.onResolve({filter:/^@\/(contexts\/AuthContext|lib\/(auth|firebase|staffChatClient))$/},args=>({path:args.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.endsWith('AuthContext')?`const user={uid:'fixture-staff',companyId:'fixture-company',role:'admin'};export const useAuth=()=>({user,userCompany:{},loading:false});`:args.path.endsWith('/auth')?'export const hasCapability=()=>true;':args.path.endsWith('/firebase')?'export const getFirestoreDb=()=>({});':transport,loader:'js'}));
}}]});
const css=fs.readdirSync('out/_next/static/css').filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync('out/_next/static/css/'+n,'utf8')).join('\n');
const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle.outputFiles[0].contents:`<style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch();
try {
 const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
 for(const mode of ['grid','sidebar']){
  const page=await context.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(8000);
  await page.goto(`http://127.0.0.1:${server.address().port}/${mode==='sidebar'?'sidebar':''}`);
  await page.getByRole('button').filter({hasText:'WhatsApp Levels'}).filter({hasNot:page.locator('[role="option"]')}).last().click();
  const feed=page.locator('[data-whatsapp-levels-feed]');await feed.locator('[data-pull-card]').first().waitFor();
  assert.equal(await feed.locator('[data-pull-card]').count(),4);
  assert.equal(await page.locator('textarea,input[placeholder="Type a message..."]').count(),0,'read-only feed has no composer');
  await feed.getByRole('combobox',{name:'Wells',exact:true}).fill('ols');
  await feed.getByRole('option',{name:'Olson',exact:true}).click();
  assert.equal(await feed.locator('[data-pull-card]').count(),1);
  await feed.getByRole('combobox',{name:'Drivers',exact:true}).fill('luiz');
  await feed.getByRole('option',{name:'Luiz tag',exact:true}).click();
  assert.equal(await feed.locator('[data-pull-card]').count(),0,'filters intersect');
  await feed.getByRole('button',{name:'Clear drivers filter'}).click();
  await page.evaluate(()=>window.publishFeed([...window.rows,{...window.rows[1],id:'new-dwyer'}]));
  await feed.getByRole('button',{name:/1 new pull outside/}).waitFor();
  assert.equal(await feed.locator('[data-pull-card]').count(),1,'filtered view does not change');
  await page.evaluate(()=>window.publishFeed(window.rows));
  assert.equal(await feed.getByRole('button',{name:/1 new pull outside/}).count(),1,'repeat snapshots do not inflate count');
  await feed.getByRole('button',{name:/1 new pull outside/}).click();
  assert.equal(await feed.locator('[data-pull-card]').count(),5);
  await feed.getByRole('combobox',{name:'Wells',exact:true}).fill('identification');
  await feed.getByRole('option',{name:'Needs identification'}).click();
  await feed.getByText('Well needs identification',{exact:true}).waitFor();
  assert.equal(await feed.locator('[data-pull-card]').count(),1);
  await feed.getByRole('button',{name:'Copy whole message'}).click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'Well needs identification full copy body');
  assert.equal(await page.evaluate(()=>window.fixtureReads.filter(id=>id.startsWith('whatsapp_levels_')).length),0,'feed never marks or mutates pulls');
  if(mode==='grid')await page.getByRole('button').filter({hasText:'Driver A'}).first().click();
  else {await page.getByTitle('Back to threads',{exact:true}).click();await page.getByRole('button').filter({hasText:'Driver A'}).first().click();}
  await page.getByText('Normal chat remains separate',{exact:true}).waitFor();
  assert.ok(await page.locator(mode==='grid'?'textarea':'input[placeholder="Type a message..."]').count()>0,'ordinary chat retains composer');
  if(mode==='grid'){
   await feed.getByRole('button',{name:'Clear wells filter'}).click();
   await page.evaluate(()=>window.publishFeed(Array.from({length:350},(_,i)=>({...window.rows[0],id:'history-'+i}))));
   await feed.getByRole('combobox',{name:'Wells',exact:true}).fill('ols');
   await feed.getByRole('option',{name:'Olson',exact:true}).click();
   await feed.getByRole('button',{name:/Show older pulls/}).waitFor();
   assert.ok(await feed.locator('[data-pull-card]').count()<200,'large archive renders a bounded initial window');
   const count=await feed.locator('[data-pull-card]').count();await feed.getByRole('button',{name:/Show older pulls/}).click();
   assert.equal(await feed.locator('[data-pull-card]').count(),count+100,'older pulls remain accessible');
  }
  await page.screenshot({path:'C:/dev/tmp/whatsapp-levels-'+mode+'-fixture.png'});
  await page.close();
 }
 await context.close();console.log('PASS actual grid/sidebar WhatsApp feed: searchable intersecting filters, clear, unknown well, hidden arrivals/retry, copy, no composer/writes, ordinary chats retained');
} finally {await browser.close();server.close();}
