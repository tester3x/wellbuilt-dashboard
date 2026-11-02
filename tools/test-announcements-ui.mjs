import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';

// Mount the actual chat page. Only authentication and server transport are mocked.

const transport=`
const thread={id:'announcements_fixture',title:'Dispatch Announcements',permanent:true,broadcast:true,type:'announcements',status:'active',participants:['user:fixture-staff'],participantNames:{},unreadCount:0,updatedAt:new Date().toISOString(),lastRead:{}};
const regular={...thread,id:'dispatch_regular',title:'Regular Driver',permanent:false,type:'direct',audience:'dispatch_team',lastMessage:{text:'Level',senderId:'driver:regular',timestamp:new Date().toISOString()}};
const message={id:'c_notice',text:'Synthetic announcement',senderId:'user:fixture-staff',senderName:'Real Dispatcher',type:'text',timestamp:new Date().toISOString(),requiresAcknowledgement:true,receiptSummary:[{driverId:'one',name:'First Real Driver',acknowledgedAt:null},{driverId:'two',name:'Off Shift Real Driver',acknowledgedAt:null}]};
window.fixtureSends=[];
export const chatIntentId=()=> 'fixture-id';
export const sendStaffChat=async(...args)=>{window.fixtureSends.push(args);};
export function watchStaffChatCompany(cb){setTimeout(()=>cb('fixture-company'),0);return()=>{};}
export function watchStaffChat(data,cb){
 if(data.action==='profiles')setTimeout(()=>cb([]),0);
 if(data.action==='threads')setTimeout(()=>cb([regular,thread]),0);
 if(data.action==='messages'){window.receiptSnapshot=()=>{message.receiptSummary[0].acknowledgedAt=new Date().toISOString();cb([structuredClone(message)]);};setTimeout(()=>cb([message]),0);}
 return()=>{};
}
export async function staffChatCall(){return {ok:true,drivers:[]};}
`;
const bundle = await build({stdin:{contents:`
import React from 'react';import {createRoot} from 'react-dom/client';import ChatPage from './src/app/chat/page';
createRoot(document.getElementById('root')).render(<ChatPage/>);
`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'fixture-ports',setup(b){
 b.onResolve({filter:/^@\/(contexts\/AuthContext|lib\/(auth|firebase|staffChatClient))$/},args=>({path:args.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.endsWith('AuthContext')?`const user={uid:'fixture-staff',companyId:'fixture-company',role:'admin'};export const useAuth=()=>({user,userCompany:{},loading:false});`:args.path.endsWith('/auth')?'export const hasCapability=()=>true;':args.path.endsWith('/firebase')?'export const getFirestoreDb=()=>({});':transport,loader:'js'}));
}}]});
const css=fs.readdirSync('out/_next/static/css').filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync('out/_next/static/css/'+n,'utf8')).join('\n');
const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle.outputFiles[0].contents:`<style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const entry=page.getByRole('button').filter({hasText:'Dispatch Announcements'}).first();await entry.waitFor();
 const order=await page.getByRole('button').filter({hasText:/Dispatch Announcements|Regular Driver/}).allTextContents();assert.ok(order[0].includes('Dispatch Announcements'),'empty announcements room stays pinned above normal conversations');
 await entry.click();await page.locator('[data-announcement="c_notice"]').waitFor();
 assert.equal(await page.getByTitle('Archive chat',{exact:true}).count(),0);assert.equal(await page.getByTitle('Manage members',{exact:true}).count(),0);
 await page.getByText('0/2 acknowledged · 2 pending',{exact:true}).click();assert.ok(await page.getByText('Off Shift Real Driver — Pending acknowledgement',{exact:true}).isVisible());
 await page.evaluate(()=>window.receiptSnapshot());await page.getByText('1/2 acknowledged · 1 pending',{exact:true}).waitFor();
 assert.ok(await page.getByText('Real Dispatcher · Dispatch announcement',{exact:true}).isVisible());
 const input=page.getByPlaceholder('Announcement to all drivers');await input.fill('Synthetic all-driver notice');await input.press('Enter');
 await page.screenshot({path:'C:/dev/tmp/dispatch-announcements-dashboard-fixture.png',fullPage:true});
 assert.deepEqual(await page.evaluate(()=>window.fixtureSends),[['announcements_fixture','Synthetic all-driver notice','fixture-company']]);
 assert.equal(errors.length,0,errors.join('\n'));await page.close();
 console.log('PASS actual Dashboard announcements: permanent empty entry, no archive/member toggle, real authors, off-shift pending roster, live receipts and company-wide composer.');
}finally{await browser.close();server.close();}
