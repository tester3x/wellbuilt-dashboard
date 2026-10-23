import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
// Exercise the production component's hooks with deterministic Firebase/road fixtures.
let slots=[], cursor=0, pending=[], dirty=true, tree, comparisons=0, selected='',accountReads=0,signalsFail=false;
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
const React={
 createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),
 useState(initial){const id=cursor++;if(!(id in slots))slots[id]=typeof initial==='function'?initial():initial;return [slots[id],value=>{const next=typeof value==='function'?value(slots[id]):value;if(!Object.is(next,slots[id])){slots[id]=next;dirty=true;}}];},
 useRef(value){const id=cursor++;return slots[id]??(slots[id]={current:value});},
 useMemo(fn,deps){const id=cursor++;if(!same(slots[id]?.deps,deps))slots[id]={deps,value:fn()};return slots[id].value;},
 useEffect(fn,deps){const id=cursor++;if(!same(slots[id]?.deps,deps)){const prev=slots[id];slots[id]={deps,cleanup:prev?.cleanup};pending.push(()=>{prev?.cleanup?.();slots[id].cleanup=fn();});}}
};
const firestore={collection:()=>({}),doc:()=>({}),query:()=>({}),where:()=>({}),orderBy:()=>({}),limit:()=>({}),Timestamp:{fromMillis:x=>x},getDocs:async()=>({docs:[],size:0}),onSnapshot:(_q,cb)=>{cb({docs:[]});return ()=>{};}};
const modules={'@/lib/dispatchDriverSignals':{getDispatchDriverSignals:async()=>{accountReads++;if(signalsFail)throw Error('status offline');return {'canonical-one':{state:'recently_active',verifiedAt:Date.now()},'canonical-two':{state:'signed_out'}};}},react:React,'firebase/firestore':firestore,'@/lib/firebase':{getFirestoreDb:()=>({})},'@/lib/operationalDriverName':{operationalDriverName:d=>d.name},'@/lib/driverRoadTimes':{createDriverRoadComparison:()=>({roadTime:async()=>null,usage:()=>({lookups:1,failures:0,configured:true})})},'@/lib/driverArrivalRecommendations':{arrivalPoint:(lat,lng)=>lat&&lng?{lat,lng}:null,buildArrivalHistory:()=>[],recommendDriverArrivals:async input=>{comparisons++;assert.equal(input.accountPresence(input.drivers[0]),signalsFail?'unknown':'logged_in');assert.equal(input.accountPresence(input.drivers[1]),signalsFail?'unknown':'logged_out');return input.drivers.map((d,i)=>({driverKey:d.key,arrivalMinutes:i?null:20,queueCount:0,workState:i?'busy':'idle',reasons:['Fixture reason']}));}}};
const module={exports:{}};
const js=ts.transpileModule(fs.readFileSync('src/components/DriverArrivalRecommendations.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
vm.runInNewContext(js,{module,exports:module.exports,require:name=>{assert.ok(modules[name],name);return modules[name];},React,Date,Map,Set,AbortController,console});
const Component=module.exports.DriverArrivalRecommendations;
let props={drivers:[{key:'one',driverId:'canonical-one',name:'First Driver'},{key:'two',driverId:'canonical-two',name:'Unknown Driver'}],jobs:[],companyId:'fixture',targetName:'Fixture well',locations:[{well_name:'Fixture well',latitude:48,longitude:-103}],jobsComplete:true,selectedKeys:new Set(),shiftForDriver:d=>d.key==='one'?{symbol:'🟢',title:'On shift'}:{symbol:'🔴',title:'Off shift'},onSelect:key=>{selected=key;}};
async function flush(){for(let n=0;n<30;n++){if(dirty){dirty=false;cursor=0;tree=Component(props);const effects=pending;pending=[];effects.forEach(fn=>fn());}await Promise.resolve();if(!dirty&&!pending.length){await Promise.resolve();if(!dirty)break;}}}
function elements(node){if(!node||typeof node!=='object')return [];return [node,...node.children.flatMap(elements)];}
function text(node){return typeof node==='object'&&node?node.children.map(text).join(''):String(node??'');}
function button(label){const found=elements(tree).find(n=>n.type==='button'&&text(n).includes(label));assert.ok(found,label);return found;}
await flush();assert.equal(comparisons,0);
button('Driver arrival recommendations').props.onClick();await flush();assert.equal(comparisons,1);
assert.ok(text(tree).includes('Google Maps'));assert.ok(text(tree).includes('Arrival unknown'));
assert.ok(text(tree).includes('Account active · verified'));assert.ok(text(tree).includes('Account signed out · last recorded'));assert.ok(text(tree).includes('On shift'));assert.ok(text(tree).includes('Off shift'));assert.ok(text(tree).includes('No active job'));assert.ok(text(tree).includes('On a job'));
button('Unknown Driver').props.onClick();assert.equal(selected,'two');
props={...props,jobs:[{id:'updated',status:'pending'}]};dirty=true;await flush();assert.equal(comparisons,1,'live jobs must not trigger Google refresh');assert.equal(accountReads,1,'no background account-status polling');
button('Refresh estimates').props.onClick();await flush();assert.equal(comparisons,2,'explicit refresh runs one comparison');
button('Driver arrival recommendations').props.onClick();await flush();assert.equal(comparisons,2);
button('Driver arrival recommendations').props.onClick();await flush();assert.equal(comparisons,3);
console.log('PASS: production panel open/refresh only, no feed polling, unknown driver selectable, Google attribution');

// Same production component now owns the actual single-driver selector.
slots=[];cursor=0;pending=[];dirty=true;comparisons=0;
props={...props,picker:'single',selectedKeys:new Set()};
await flush();assert.ok(button('Select driver'));
button('Select driver').props.onClick();await flush();assert.equal(comparisons,1);
button('Unknown Driver').props.onClick();await flush();assert.equal(selected,'two');
assert.equal(button('Select driver').props['aria-expanded'],false);
props={...props,selectedKeys:new Set(['two'])};dirty=true;await flush();
assert.equal(button('Unknown Driver').props['aria-expanded'],false);
button('Unknown Driver').props.onClick();await flush();
assert.equal(comparisons,2);
console.log('PASS: ranked single-driver selector selects unknown drivers, collapses, and retains the chosen label');
signalsFail=true;button('Refresh estimates').props.onClick();await flush();assert.equal(comparisons,3);assert.ok(text(tree).includes('Account status unverified'));assert.ok(!text(tree).includes('Account signed out · last recorded'));assert.ok(text(tree).includes('On shift'));
assert.match(fs.readFileSync('src/app/dispatch/page.tsx','utf8'),/shiftForDriver=\{driverShiftDot\}/);
console.log('PASS: canonical account signals, separate shift/work labels, no status polling and unavailable-status fallback');
import { createElement as element } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import path from 'node:path';
const toElement=node=>node&&typeof node==='object'?element(node.type,node.props,...node.children.map(toElement)):node;
const markup=renderToStaticMarkup(toElement(tree));
const css=fs.readdirSync('out/_next/static/css').filter(f=>f.endsWith('.css')).map(f=>fs.readFileSync(path.join('out/_next/static/css',f),'utf8')).join('\n');
const browser=await chromium.launch({headless:true});
try {for(const width of [320,344,768,1280]){
 const page=await browser.newPage({viewport:{width,height:700}});
 await page.setContent(`<style>${css}</style><main style="padding:12px;background:#111827">${markup}</main>`);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`selector overflow at ${width}`);
 assert.equal(await page.getByRole('button',{name:/Unknown Driver/}).count(),2);
 await page.close();
}} finally {await browser.close();}
console.log('PASS: actual selector markup fits 320/344/768/1280px');
