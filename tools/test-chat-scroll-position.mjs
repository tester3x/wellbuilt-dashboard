import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';

// Mount the actual chat page. Only authentication and server transport are mocked.
const transport = `
const profile={id:'fixture-profile',name:'Only layout',gridLayout:'2x2',slots:[null,null,null,null]};
const threads=['A','B'].map(letter=>({id:'dispatch_'+letter,title:'Driver '+letter,type:'direct',audience:'dispatch_team',status:'active',participants:['driver:'+letter],participantNames:{},updatedAt:new Date().toISOString()}));
window.fixtureReads=[];window.updaters={};window.rows={};
export const chatIntentId=()=> 'fixture-id';export const sendStaffChat=async()=>{};
export function watchStaffChatCompany(cb){setTimeout(()=>cb('fixture-company'),0);return()=>{};}
export function watchStaffChat(data,cb){
 if(data.action==='profiles')setTimeout(()=>cb([profile]),0);
 if(data.action==='threads')setTimeout(()=>cb(threads),0);
 if(data.action==='messages'){
  const rows=window.rows[data.threadId]||Array.from({length:50},(_,i)=>({id:'m'+i,text:'Synthetic message '+i+' '+('reading material '.repeat(12)),senderId:'driver:fixture',senderName:'Fixture',type:'text',timestamp:new Date().toISOString()}));
  window.rows[data.threadId]=rows;window.updaters[data.threadId]=(next)=>{window.rows[data.threadId]=next;cb(structuredClone(next));};setTimeout(()=>cb(structuredClone(rows)),0);
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
 const context=await browser.newContext();
 for(const mode of ['grid','sidebar']){
  const page=await context.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(8000);
  await page.goto(`http://127.0.0.1:${server.address().port}/${mode==='sidebar'?'sidebar':''}`);
  if(mode==='grid'){
   await page.getByText('Layout: Only layout',{exact:true}).waitFor();
   assert.equal(await page.locator('#profile-menu').count(),0,'single profile has no useless menu');
  }
  await page.getByRole('button').filter({hasText:'Driver A'}).first().click();
  const pane=page.locator('[data-chat-viewport-scope="fixture-company:dispatch_A"]'),scroll=pane.locator('[data-chat-scroll]');
  await pane.locator('[data-chat-message-id="m49"]').waitFor();
  await page.waitForFunction(()=>window.fixtureReads.length>0);
  const bottom=()=>scroll.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop);
  assert.ok(await bottom()<3,'initial open goes to latest');
  await scroll.evaluate(el=>{el.scrollTop=el.scrollHeight/2;el.dispatchEvent(new Event('scroll',{bubbles:true}));});
  await pane.getByRole('button',{name:'Go to latest messages',exact:true}).waitFor();
  const before=await scroll.evaluate(el=>el.scrollTop),reads=await page.evaluate(()=>window.fixtureReads.length);
  await page.evaluate(()=>window.updaters.dispatch_A(window.rows.dispatch_A));
  await page.waitForTimeout(250);assert.ok(Math.abs(await scroll.evaluate(el=>el.scrollTop)-before)<2,'unchanged poll never scrolls');
  await page.evaluate(()=>window.updaters.dispatch_A([...window.rows.dispatch_A,{...window.rows.dispatch_A.at(-1),id:'new1',text:'Incoming one'},{...window.rows.dispatch_A.at(-1),id:'new2',text:'Incoming two'}]));
  await pane.getByRole('button',{name:'2 new messages, go to latest',exact:true}).waitFor();
  assert.ok(Math.abs(await scroll.evaluate(el=>el.scrollTop)-before)<2,'new incoming leaves reader in place');
  assert.equal(await page.evaluate(()=>window.fixtureReads.length),reads,'hidden incoming messages not marked read');
  // Repeated snapshots and own outgoing messages cannot inflate received count.
  await page.evaluate(()=>window.updaters.dispatch_A([...window.rows.dispatch_A,{...window.rows.dispatch_A.at(-1),id:'own',senderId:'user:fixture-staff',text:'Own outgoing'}]));
  await pane.getByRole('button',{name:'2 new messages, go to latest',exact:true}).waitFor();
  if(mode==='grid'){
   await page.getByRole('button').filter({hasText:'Driver B'}).first().click();
   const second=page.locator('[data-chat-viewport-scope="fixture-company:dispatch_B"]');await second.locator('[data-chat-message-id="m49"]').waitFor();
   await page.evaluate(()=>window.updaters.dispatch_B([...window.rows.dispatch_B,{...window.rows.dispatch_B.at(-1),id:'b-new'}]));
   await second.locator('[data-chat-message-id="b-new"]').waitFor();
   assert.ok(await second.locator('[data-chat-scroll]').evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop)<3,'other pane follows independently');
   assert.ok(Math.abs(await scroll.evaluate(el=>el.scrollTop)-before)<2);
  }
  await pane.getByRole('button',{name:'2 new messages, go to latest',exact:true}).click();
  assert.ok(await bottom()<3);assert.equal(await pane.getByRole('button',{name:/go to latest/i}).count(),0);
  // Selection at the bottom is an explicit reading/copying pause.
  await pane.locator('[data-chat-message-text]').last().evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const s=window.getSelection();s.removeAllRanges();s.addRange(range);});
  const selectedTop=await scroll.evaluate(el=>el.scrollTop);
  await page.evaluate(()=>window.updaters.dispatch_A([...window.rows.dispatch_A,{...window.rows.dispatch_A.at(-1),id:'selection-new',senderId:'driver:fixture',text:'Arrived during selection'}]));
  await pane.getByRole('button',{name:'1 new message, go to latest',exact:true}).waitFor();
  assert.ok(Math.abs(await scroll.evaluate(el=>el.scrollTop)-selectedTop)<2,'selection is not pulled away');
  await page.evaluate(()=>window.getSelection().removeAllRanges());await pane.getByRole('button',{name:'1 new message, go to latest',exact:true}).click();
  await page.evaluate(()=>window.updaters.dispatch_A([...window.rows.dispatch_A,{...window.rows.dispatch_A.at(-1),id:'following-new',text:'Arrived at bottom'}]));
  await pane.locator('[data-chat-message-id="following-new"]').waitFor();assert.ok(await bottom()<3,'follow resumes after explicit jump');
  await page.close();
 }
 await context.close();console.log('PASS actual grid/sidebar: initial bottom, unchanged polls stable, incoming/own counts, read only at bottom, independent panes, explicit jump, selection pause, following resumes and single-profile label.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
