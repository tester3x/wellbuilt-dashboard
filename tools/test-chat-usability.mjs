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
 if(data.action==='messages')setTimeout(()=>cb([{id:'body',text:'Whole card\\nsecond line',senderId:'driver:fixture',senderName:'Real Driver',type:'text',timestamp:new Date().toISOString()}]),0);
 return()=>{};
}
export async function staffChatCall(data){
 if(data.action==='directory')return {drivers:[{hash:'new-driver',name:'New Real Driver'}]};
 if(data.action==='saveProfile' && data.record.threadType){window.fixtureSaves.push(data);profile.threadType=data.record.threadType;window.profileSnapshot();return {ok:true};}
 if(data.action==='saveProfile')return new Promise((resolve,reject)=>{window.fixtureSaves.push(data);window.finishSave=(ok)=>{if(ok){profile.slots=data.record.slots;resolve({ok:true});}else reject(new Error('Fixture denied'));};});
 return {ok:true};
}
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
 const page=await context.newPage();page.setDefaultTimeout(8000);
 const base=`http://127.0.0.1:${server.address().port}`;
 await page.goto(base);
 await page.getByTitle('Setup grid',{exact:true}).click();
 const well=page.getByRole('button',{name:'Well',exact:true});
 await well.click();assert.equal(await well.evaluate(e=>e.className.includes('border-[#FFD700]')),true);
 await well.click();assert.equal(await well.evaluate(e=>e.className.includes('border-[#FFD700]')),false);
 assert.equal(await page.evaluate(()=>window.fixtureSaves.at(-1).record.threadType),'all');
 await page.getByRole('button',{name:'+ Assign Chat',exact:true}).first().click();
 await page.getByText('New Real Driver',{exact:true}).waitFor();
 await page.getByRole('button',{name:'✕ Close',exact:true}).click();
 await page.getByRole('button',{name:'Done',exact:true}).click();
 await page.getByRole('button').filter({hasText:'Fixture Driver'}).first().click();
 await page.getByRole('button',{name:'Copy whole message',exact:true}).click();
 assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replaceAll('\r\n','\n'),'Whole card\nsecond line');
 await page.getByRole('status').filter({hasText:'Copied'}).waitFor();
 const selection=await page.locator('[data-chat-message-text]').first().evaluate(e=>getComputedStyle(e).userSelect);assert.equal(selection,'text');
 // Real same-origin named windows: repeated open focuses the same page and does not reload its draft.
 const firstPromise=context.waitForEvent('page');await page.getByRole('button',{name:'Focus fixture workspace',exact:true}).click();const first=await firstPromise;await first.waitForURL('**/chat/');await first.getByTitle('New chat window',{exact:true}).waitFor();
 await first.evaluate(()=>{window.retainedDraft='keep this grid';});
 const count=context.pages().length;await page.getByRole('button',{name:'Focus fixture workspace',exact:true}).click();
 assert.equal(context.pages().length,count);assert.equal(await first.evaluate(()=>window.retainedDraft),'keep this grid');
 const extraPromise=context.waitForEvent('page');await first.getByTitle('New chat window',{exact:true}).click();const extra=await extraPromise;await extra.waitForURL('**/chat/');await extra.getByTitle('New chat window',{exact:true}).waitFor();assert.equal(context.pages().length,count+1);
 await first.close();const replacementPromise=context.waitForEvent('page');await page.getByRole('button',{name:'Focus fixture workspace',exact:true}).click();const replacement=await replacementPromise;await replacement.waitForURL('**/chat/');await replacement.getByTitle('New chat window',{exact:true}).waitFor();
 // Sidebar uses the same whole-card copy control.
 await page.goto(base+'/sidebar');await page.getByRole('button').filter({hasText:'Fixture Driver'}).first().click();await page.getByRole('button',{name:'Copy whole message',exact:true}).click();
 assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replaceAll('\r\n','\n'),'Whole card\nsecond line');
 await context.close();
 console.log('PASS actual Dashboard chat: optional profile type toggles to all, mixed slot choices, exact whole-card copy in sidebar/grid with native selection, reusable main window without draft reload, explicit extra windows and closed-window recovery.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
