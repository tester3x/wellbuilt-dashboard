import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';

// Mount the actual chat page. Only authentication and server transport are mocked.
const transport = `
const full=location.search.includes('full');
const profiles=[{id:'fixture-profile',name:'Dispatch Only',gridLayout:'2x2',slots:full?['A','B','C','D'].map(letter=>({threadId:'dispatch_'+letter,threadTitle:'Driver '+letter})):[{threadId:'dispatch_A',threadTitle:'Driver A'},null,null,null]},{id:'second',name:'Other profile',gridLayout:'2x2',slots:[null,null,null,null]}];
const threads=['A','B','C','D','E'].map(letter=>({id:'dispatch_'+letter,title:'Driver '+letter,type:'direct',audience:'dispatch_team',status:'active',participants:['driver:'+letter],participantNames:{},lastMessage:{text:'Fixture message',senderId:'driver:'+letter,timestamp:new Date().toISOString()},updatedAt:new Date().toISOString()}));
window.starts=[];window.pendingStarts=[];
export const chatIntentId=()=> 'fixture-id';export const sendStaffChat=async()=>{};
export function watchStaffChatCompany(cb){setTimeout(()=>cb('fixture-company'),0);return()=>{};}
export function watchStaffChat(data,cb){if(data.action==='profiles')setTimeout(()=>cb(structuredClone(profiles)),0);if(data.action==='threads')setTimeout(()=>cb(threads),0);if(data.action==='messages')setTimeout(()=>cb([]),0);return()=>{};}
export async function staffChatCall(data){
 if(data.action==='directory')return {drivers:['A','E','X','Y'].map(hash=>({hash,name:'Driver '+hash}))};
 if(data.action==='dispatch'||data.action==='private')return new Promise(resolve=>{window.starts.push(data);window.pendingStarts.push(()=>resolve({threadId:data.action+'_'+data.driverId}));});
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
const driver=(p,id)=>p.locator(`[data-chat-driver="${id}"]`);
const positions=p=>p.locator('[data-chat-slot]').evaluateAll(els=>els.map(el=>el.querySelector('[data-chat-drag-header]')?.getAttribute('data-chat-drag-header')||null));
const picker=async p=>{await p.getByRole('button',{name:'New conversation',exact:true}).click();await driver(p,'X').waitFor();};
const dismiss=async p=>{await p.getByRole('alertdialog',{name:'This profile grid is full',exact:true}).waitFor();await p.getByRole('button',{name:'Got it',exact:true}).click();};
try{
 const full=await page('full');await full.getByRole('button',{name:'Lock tab layout',exact:true}).click();
 const before=await positions(full);await slot(full,0).locator('textarea').fill('Keep this draft');
 await picker(full);await driver(full,'X').click();await dismiss(full);
 assert.deepEqual(await positions(full),before);assert.equal(await full.evaluate(()=>window.starts.length),0,'full directory selection cannot even create a new conversation');
 await driver(full,'A').click();assert.deepEqual(await positions(full),before,'existing visible driver focuses instead');
 await list(full,'E').click();await dismiss(full);assert.deepEqual(await positions(full),before);
 await picker(full);await mouseDrag(full,driver(full,'X'),slot(full,0));await dismiss(full);
 assert.deepEqual(await positions(full),before);assert.equal(await full.evaluate(()=>window.starts.length),0);
 assert.equal(await slot(full,0).locator('textarea').inputValue(),'Keep this draft');await full.close();
 const normal=await page();await picker(normal);await driver(normal,'X').click();await driver(normal,'Y').click();
 await normal.waitForFunction(()=>window.pendingStarts.length===2);
 await normal.evaluate(()=>window.pendingStarts.forEach(resolve=>resolve()));
 await normal.locator('[data-chat-drag-header="dispatch_Y"]').waitFor();assert.deepEqual(await positions(normal),['dispatch_A','dispatch_X','dispatch_Y',null],'concurrent lookups reserve distinct empty positions');
 await list(normal,'B').click();const filled=await positions(normal);await list(normal,'C').click();await dismiss(normal);assert.deepEqual(await positions(normal),filled,'click cannot silently replace unlocked temporary chats');await normal.close();
 const race=await page();await picker(race);await driver(race,'X').click();await race.getByRole('button',{name:'Close conversation list',exact:true}).click();
 for(const id of ['B','C','E'])await list(race,id).click();const raced=await positions(race);await race.evaluate(()=>window.pendingStarts[0]());await dismiss(race);assert.deepEqual(await positions(race),raced,'lookup arriving after last free slot is consumed cannot replace it');await race.close();
 for(const touch of [false,true]){
  const p=await page('',touch);await picker(p);if(touch)await touchDrag(p,driver(p,'X'),slot(p,3));else await mouseDrag(p,driver(p,'X'),slot(p,3));
  await p.waitForFunction(()=>window.pendingStarts.length===1);await p.evaluate(()=>window.pendingStarts[0]());await p.locator('[data-chat-drag-header="dispatch_X"]').waitFor();assert.deepEqual(await positions(p),['dispatch_A',null,null,'dispatch_X'],'directory drop respects chosen square');await p.close();
 }
 const editing=await page();await picker(editing);await driver(editing,'X').click();await editing.getByTitle('Setup grid',{exact:true}).click();await editing.evaluate(()=>window.pendingStarts[0]());await editing.locator('[data-chat-drag-header="dispatch_X"]').waitFor();await editing.getByTitle('Exit setup',{exact:true}).click();assert.deepEqual(await positions(editing),['dispatch_A','dispatch_X',null,null],'Settings open permits safe placement in an empty square');await editing.close();
 const changed=await page();await picker(changed);await driver(changed,'X').click();await changed.locator('[data-chat-header-controls] .relative > button').click();await changed.locator('#profile-menu').getByRole('button',{name:'Other profile',exact:true}).click();await changed.evaluate(()=>window.pendingStarts[0]());await changed.getByText('The grid changed while opening this chat. Select it again from the list.',{exact:true}).waitFor();assert.deepEqual(await positions(changed),[null,null,null,null]);await changed.close();
 console.log('PASS actual full-grid safeguard: locked 2x2 picker/list/drop preserve all slots/drafts, no unnecessary create, existing driver focus, no implicit temporary replacement, concurrent/late/profile-switched lookup fences, picker mouse and long-hold touch drops');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
