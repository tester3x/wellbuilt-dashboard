import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';

// Mount the actual chat page. Only authentication and server transport are mocked.
const transport = `
const profiles=location.search.includes('missing')?[]:[{id:'fixture-profile',name:'Fixture monitor',gridLayout:'2x2',slots:[null,null,null,null]},{id:'second',name:'Second monitor',gridLayout:'2x2',slots:[null,{threadId:'dispatch_D',threadTitle:'Driver D'},null,null]}];
const threads=['A','B','C','D','E'].map(letter=>({id:'dispatch_'+letter,title:'Driver '+letter,type:'direct',audience:'dispatch_team',status:'active',participants:['driver:'+letter],participantNames:{['driver:'+letter]:'Driver '+letter},lastMessage:{text:'Fixture message',senderId:'driver:'+letter,timestamp:new Date().toISOString()},updatedAt:new Date().toISOString()}));
window.fixtureSaves=[];
export const chatIntentId=()=> 'created-profile';
export const sendStaffChat=async()=>{};
export function watchStaffChatCompany(cb){setTimeout(()=>cb('fixture-company'),0);return()=>{};}
export function watchStaffChat(data,cb){
 if(data.action==='profiles'){window.profileSnapshot=()=>cb(structuredClone(profiles));setTimeout(window.profileSnapshot,0);}
 if(data.action==='threads')setTimeout(()=>cb(threads),0);
 if(data.action==='messages')setTimeout(()=>cb([]),0);
 return()=>{};
}
export async function staffChatCall(data){
 if(data.action==='directory')return {drivers:[]};
 if(data.action==='saveProfile')return new Promise((resolve,reject)=>{window.fixtureSaves.push(data);window.finishSave=ok=>{if(!ok){reject(Error('Fixture denied'));return;}const target=profiles.find(p=>p.id===data.profileId);if(target)Object.assign(target,data.record);else profiles.push({id:data.profileId,...data.record});resolve({ok:true});};});
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
const slot=(p,i)=>p.locator(`[data-chat-slot="${i}"]`),header=(p,id)=>p.locator(`[data-chat-drag-header="dispatch_${id}"]`),list=(p,id)=>p.locator(`[data-chat-list-thread="dispatch_${id}"]`);
const center=async locator=>{const b=await locator.boundingBox();assert.ok(b);return {x:b.x+b.width/2,y:b.y+b.height/2};};
async function mouseDrag(p,from,to){const a=await center(from),b=await center(to);await p.mouse.move(a.x,a.y);await p.mouse.down();await p.mouse.move(a.x+9,a.y+3);await p.mouse.move(b.x,b.y,{steps:8});await p.mouse.up();}
async function touchDrag(p,from,to,hold=520){const cdp=await p.context().newCDPSession(p),a=await center(from),b=await center(to);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a]});await p.waitForTimeout(hold);await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[b]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}
async function page(scenario='',touch=false){const p=await browser.newPage({viewport:{width:1440,height:1000},hasTouch:touch});p.setDefaultTimeout(8000);await p.goto(`http://127.0.0.1:${server.address().port}/?${scenario}`);await list(p,'A').waitFor();return p;}
async function save(p,ok=true){await p.getByRole('button',{name:'Save and lock',exact:true}).click();await p.waitForFunction(()=>!!window.finishSave);await p.evaluate(ok=>window.finishSave(ok),ok);}
try {
 const p=await page();
 await list(p,'A').click();await list(p,'B').click();assert.equal(await slot(p,0).locator('[data-chat-drag-header]').getAttribute('data-chat-drag-header'),'dispatch_A');assert.equal(await slot(p,1).locator('[data-chat-drag-header]').getAttribute('data-chat-drag-header'),'dispatch_B');
 await slot(p,0).locator('textarea').fill('Unsent draft stays with A');
 const cancelStart=await center(header(p,'A')),cancelEnd=await center(slot(p,3));await p.mouse.move(cancelStart.x,cancelStart.y);await p.mouse.down();await p.mouse.move(cancelEnd.x,cancelEnd.y,{steps:8});await p.keyboard.press('Escape');await p.mouse.up();assert.equal(await slot(p,0).locator('[data-chat-drag-header]').getAttribute('data-chat-drag-header'),'dispatch_A');
 await mouseDrag(p,header(p,'A'),slot(p,3));await header(p,'A').waitFor();assert.equal(await slot(p,3).locator('textarea').inputValue(),'Unsent draft stays with A');assert.equal(await slot(p,0).locator('textarea').count(),0);
 await mouseDrag(p,header(p,'B'),slot(p,3));assert.equal(await slot(p,1).locator('textarea').inputValue(),'Unsent draft stays with A');assert.equal(await slot(p,3).locator('[data-chat-drag-header]').getAttribute('data-chat-drag-header'),'dispatch_B');
 await mouseDrag(p,list(p,'C'),slot(p,0));assert.equal(await slot(p,0).locator('[data-chat-drag-header]').getAttribute('data-chat-drag-header'),'dispatch_C');
 await mouseDrag(p,list(p,'D'),slot(p,1));assert.equal(await slot(p,2).locator('textarea').inputValue(),'Unsent draft stays with A');assert.equal(await slot(p,1).locator('[data-chat-drag-header]').getAttribute('data-chat-drag-header'),'dispatch_D');
 await mouseDrag(p,list(p,'E'),slot(p,0));assert.equal(await p.locator('textarea').count(),4);assert.equal(await slot(p,0).locator('[data-chat-drag-header]').getAttribute('data-chat-drag-header'),'dispatch_C');
 await slot(p,3).getByTitle('Lock to this profile slot',{exact:true}).click();await save(p);await p.evaluate(()=>window.profileSnapshot());await slot(p,3).getByTitle('Unlock (temporary)',{exact:true}).waitFor();
 await mouseDrag(p,header(p,'B'),slot(p,0));assert.equal(await slot(p,3).locator('[data-chat-drag-header]').getAttribute('data-chat-drag-header'),'dispatch_B');
 await mouseDrag(p,header(p,'C'),slot(p,3));assert.equal(await slot(p,3).locator('[data-chat-drag-header]').getAttribute('data-chat-drag-header'),'dispatch_B');
 await p.close();
 const fresh=await page('missing');await list(fresh,'A').click();await slot(fresh,0).getByTitle('Lock to this profile slot',{exact:true}).click();await fresh.getByRole('textbox',{name:'Profile name',exact:true}).fill('Created from lock');await save(fresh);assert.equal(await fresh.locator('textarea').count(),1);await fresh.evaluate(()=>window.profileSnapshot());await fresh.getByRole('dialog').waitFor({state:'hidden'});await fresh.getByText('Created from lock',{exact:true}).filter({visible:true}).first().waitFor();assert.equal(await slot(fresh,0).getByTitle('Unlock (temporary)',{exact:true}).count(),1);await fresh.close();
 const other=await page();await list(other,'A').click();await slot(other,0).getByTitle('Lock to this profile slot',{exact:true}).click();await other.getByRole('combobox',{name:'Monitor profile',exact:true}).selectOption('second');await other.waitForFunction(()=>document.querySelector('[aria-label="Position"] option[value="1"]').disabled);await save(other);await other.evaluate(()=>window.profileSnapshot());await other.getByRole('dialog').waitFor({state:'hidden'});assert.equal(await slot(other,0).getByTitle('Unlock (temporary)',{exact:true}).count(),1);assert.equal(await slot(other,1).locator('[data-chat-drag-header]').getAttribute('data-chat-drag-header'),'dispatch_D');await other.close();
 const touch=await page('',true);await list(touch,'A').tap();await touchDrag(touch,header(touch,'A'),slot(touch,3));assert.equal(await slot(touch,3).locator('[data-chat-drag-header]').getAttribute('data-chat-drag-header'),'dispatch_A');await touchDrag(touch,list(touch,'B'),slot(touch,0));assert.equal(await slot(touch,0).locator('[data-chat-drag-header]').getAttribute('data-chat-drag-header'),'dispatch_B');assert.equal(await touch.locator('textarea').count(),2);await touchDrag(touch,list(touch,'C'),slot(touch,1),0);assert.equal(await touch.locator('[data-chat-drag-header="dispatch_C"]').count(),0,'scroll movement before hold never opens or drops a chat');await touch.close();
 console.log('Actual chat page: click fill order, mouse move/swap, list drops, full/locked protections, preserved drafts, inline profile creation/selection and real long-hold touchscreen drags passed.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
