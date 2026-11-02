import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';

// Mount the actual chat page. Only authentication and server transport are mocked.
const transport = `
const profiles=['Alpha','Beta','Gamma','Delta'].map((name,i)=>({id:name.toLowerCase(),name,gridLayout:'2x2',threadType:'all',slots:[null,null,null,null],locked:i%2===0}));
window.fixtureSaves=[];
export const chatIntentId=()=> 'fixture-id';export const sendStaffChat=async()=>{};
export function watchStaffChatCompany(cb){setTimeout(()=>cb(location.search.includes('other')?'other-company':'fixture-company'),0);return()=>{};}
export function watchStaffChat(data,cb){if(data.action==='profiles')setTimeout(()=>cb(structuredClone(profiles)),0);if(data.action==='threads'||data.action==='messages')setTimeout(()=>cb([]),0);return()=>{};}
export async function staffChatCall(data){window.fixtureSaves.push(data);return {ok:true,drivers:[]};}
`;
const bundle = await build({stdin:{contents:`
import React from 'react';import {createRoot} from 'react-dom/client';import ChatPage from './src/app/chat/page';
if(!localStorage.getItem('wb-chat-profile-stack'))localStorage.setItem('wb-chat-profile-stack',JSON.stringify(['alpha']));
createRoot(document.getElementById('root')).render(<ChatPage/>);
`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'fixture-ports',setup(b){
 b.onResolve({filter:/^@\/(contexts\/AuthContext|lib\/(auth|firebase|staffChatClient))$/},args=>({path:args.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.endsWith('AuthContext')?`const user={uid:location.search.includes('account')?'other-staff':'fixture-staff',companyId:'fixture-company',role:'admin'};export const useAuth=()=>({user,userCompany:{},loading:false});`:args.path.endsWith('/auth')?'export const hasCapability=()=>true;':args.path.endsWith('/firebase')?'export const getFirestoreDb=()=>({});':transport,loader:'js'}));
}}]});
const css=fs.readdirSync('out/_next/static/css').filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync('out/_next/static/css/'+n,'utf8')).join('\n');
const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle.outputFiles[0].contents:`<style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch();
try {
 const context=await browser.newContext();
 const base=`http://127.0.0.1:${server.address().port}`;
 const open=async()=>{const page=await context.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(8000);await page.goto(base);await page.getByRole('tab',{name:'Alpha',exact:true}).waitFor();return page;};
 const pick=async(page,name)=>{await page.locator('[data-chat-header-controls] .relative > button').click();await page.locator('#profile-menu').getByRole('button',{name,exact:true}).click();};
 const ids=page=>page.locator('[data-window-profile]').evaluateAll(els=>els.map(el=>el.getAttribute('data-window-profile')));
 const a=await open();
 await a.getByRole('button',{name:'Lock tab layout',exact:true}).click();
 await a.getByRole('button',{name:'Unlock tab layout',exact:true}).waitFor();
 const b=await open();
 assert.equal(await b.getByRole('button',{name:'Lock tab layout',exact:true}).count(),1,'another tab remains unlocked despite shared saved profile.locked');
 await pick(b,'Beta');await b.getByRole('button',{name:'Remove Alpha from this tab'}).click();
 await b.getByRole('button',{name:'Lock tab layout',exact:true}).click();
 assert.deepEqual(await ids(a),['alpha']);assert.deepEqual(await ids(b),['beta']);
 // Locking a single-profile window blocks additions but not another window.
 await a.locator('[data-chat-header-controls] .relative > button').click();
 assert.equal(await a.locator('#profile-menu').getByRole('button',{name:'Beta',exact:true}).isDisabled(),true);
 await a.locator('[data-chat-header-controls] .relative > button').click();
 await a.getByRole('button',{name:'Unlock tab layout',exact:true}).click();
 await pick(a,'Beta');await pick(a,'Gamma');await a.getByRole('button',{name:'Lock tab layout',exact:true}).click();
 assert.deepEqual(await ids(a),['alpha','beta','gamma']);
 for(const name of ['Alpha','Gamma','Beta']){await a.getByRole('tab',{name,exact:true}).click();assert.equal(await a.getByRole('tab',{name,exact:true}).getAttribute('aria-selected'),'true');}
 assert.deepEqual(await ids(a),['alpha','beta','gamma'],'switching preserves tab order');
 await a.locator('[data-chat-header-controls] .relative > button').click();assert.equal(await a.locator('#profile-menu').getByRole('button',{name:'Delta',exact:true}).isDisabled(),true);await a.locator('[data-chat-header-controls] .relative > button').click();
 assert.equal(await a.getByRole('button',{name:'Remove Beta from this tab'}).isDisabled(),true);
 await a.getByRole('button',{name:'Unlock Beta in this tab'}).click();await a.getByRole('button',{name:'Remove Beta from this tab'}).click();
 assert.deepEqual(await ids(a),['alpha','gamma']);assert.equal(await a.getByRole('button',{name:'Unlock tab layout',exact:true}).count(),1);
 assert.deepEqual(await ids(b),['beta']);assert.equal(await b.getByRole('button',{name:'Unlock Beta in this tab'}).count(),1,'per-profile pin change also stays local');
 await a.getByRole('tab',{name:'Gamma',exact:true}).click();await a.reload();await a.getByRole('button',{name:'Unlock tab layout',exact:true}).waitFor();
 assert.deepEqual(await ids(a),['alpha','gamma']);assert.equal(await a.getByRole('tab',{name:'Gamma',exact:true}).getAttribute('aria-selected'),'true');
 await b.reload();await b.getByRole('button',{name:'Unlock tab layout',exact:true}).waitFor();assert.deepEqual(await ids(b),['beta']);
 // Explicit New window starts with an empty, unlocked layout even with a locked opener.
 const popupPromise=context.waitForEvent('page');await a.getByTitle('New chat window',{exact:true}).click();const popup=await popupPromise;await popup.waitForURL('**/chat/');await popup.getByText('No profiles open',{exact:true}).waitFor();assert.equal(await popup.getByRole('button',{name:'Lock tab layout',exact:true}).count(),1);await pick(popup,'Alpha');await popup.getByRole('button',{name:'Remove Alpha from this tab'}).click();await popup.reload();await popup.getByText('No profiles open',{exact:true}).waitFor();await popup.close();
 await a.getByRole('button',{name:'Unlock tab layout',exact:true}).click();await a.getByRole('button',{name:'Remove Alpha from this tab'}).click();await pick(a,'Delta');
 assert.deepEqual(await ids(a),['gamma','delta'],'unlock restores free add/remove without changing saved profiles');
 assert.equal(await a.evaluate(()=>window.fixtureSaves.length),0,'window/profile protection never writes shared monitor docs');assert.equal(await b.evaluate(()=>window.fixtureSaves.length),0);
 assert.equal(await a.evaluate(()=>localStorage.getItem('wb-chat-profile-stack')),'["alpha"]','legacy shared key is read once, never overwritten');
 await a.goto(base+'/?other');await a.getByText('No profiles open',{exact:true}).waitFor();assert.equal(await a.getByRole('button',{name:'Lock tab layout',exact:true}).count(),1,'company scope has independent local state');
 await a.goto(base+'/?account');await a.getByText('No profiles open',{exact:true}).waitFor();
 await a.goto(base);await a.getByRole('tab',{name:'Delta',exact:true}).waitFor();assert.deepEqual(await ids(a),['gamma','delta'],'original account state retained independently');
 await context.close();console.log('PASS actual multi-window layouts: independent locks/stacks/pins, 1 and 3 profiles, stable order and switching, local unpin/remove while locked, unlock add/remove, reload, fresh new window, account/company scope, no shared writes');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
