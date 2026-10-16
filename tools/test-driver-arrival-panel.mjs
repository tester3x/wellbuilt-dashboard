import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
// Exercise the production component's hooks with deterministic Firebase/road fixtures.
let slots=[], cursor=0, pending=[], dirty=true, tree, comparisons=0, selected='';
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
const React={
 createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),
 useState(initial){const id=cursor++;if(!(id in slots))slots[id]=typeof initial==='function'?initial():initial;return [slots[id],value=>{const next=typeof value==='function'?value(slots[id]):value;if(!Object.is(next,slots[id])){slots[id]=next;dirty=true;}}];},
 useRef(value){const id=cursor++;return slots[id]??(slots[id]={current:value});},
 useMemo(fn,deps){const id=cursor++;if(!same(slots[id]?.deps,deps))slots[id]={deps,value:fn()};return slots[id].value;},
 useEffect(fn,deps){const id=cursor++;if(!same(slots[id]?.deps,deps)){const prev=slots[id];slots[id]={deps,cleanup:prev?.cleanup};pending.push(()=>{prev?.cleanup?.();slots[id].cleanup=fn();});}}
};
const firestore={collection:()=>({}),doc:()=>({}),query:()=>({}),where:()=>({}),orderBy:()=>({}),limit:()=>({}),Timestamp:{fromMillis:x=>x},getDocs:async()=>({docs:[],size:0}),onSnapshot:(_q,cb)=>{cb({docs:[]});return ()=>{};}};
const modules={react:React,'firebase/firestore':firestore,'@/lib/firebase':{getFirestoreDb:()=>({})},'@/lib/operationalDriverName':{operationalDriverName:d=>d.name},'@/lib/driverRoadTimes':{createDriverRoadComparison:()=>({roadTime:async()=>null,usage:()=>({lookups:1,failures:0,configured:true})})},'@/lib/driverArrivalRecommendations':{arrivalPoint:(lat,lng)=>lat&&lng?{lat,lng}:null,buildArrivalHistory:()=>[],recommendDriverArrivals:async input=>{comparisons++;return input.drivers.map((d,i)=>({driverKey:d.key,arrivalMinutes:i?null:20,queueCount:0,reasons:['Fixture reason']}));}}};
const module={exports:{}};
const js=ts.transpileModule(fs.readFileSync('src/components/DriverArrivalRecommendations.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
vm.runInNewContext(js,{module,exports:module.exports,require:name=>{assert.ok(modules[name],name);return modules[name];},React,Date,Map,Set,AbortController,console});
const Component=module.exports.DriverArrivalRecommendations;
let props={drivers:[{key:'one',name:'First Driver'},{key:'two',name:'Unknown Driver'}],jobs:[],companyId:'fixture',targetName:'Fixture well',locations:[{well_name:'Fixture well',latitude:48,longitude:-103}],jobsComplete:true,selectedKeys:new Set(),onSelect:key=>{selected=key;}};
async function flush(){for(let n=0;n<30;n++){if(dirty){dirty=false;cursor=0;tree=Component(props);const effects=pending;pending=[];effects.forEach(fn=>fn());}await Promise.resolve();if(!dirty&&!pending.length){await Promise.resolve();if(!dirty)break;}}}
function elements(node){if(!node||typeof node!=='object')return [];return [node,...node.children.flatMap(elements)];}
function text(node){return typeof node==='object'&&node?node.children.map(text).join(''):String(node??'');}
function button(label){const found=elements(tree).find(n=>n.type==='button'&&text(n).includes(label));assert.ok(found,label);return found;}
await flush();assert.equal(comparisons,0);
button('Driver arrival recommendations').props.onClick();await flush();assert.equal(comparisons,1);
assert.ok(text(tree).includes('Google Maps'));assert.ok(text(tree).includes('Arrival unknown'));
button('Unknown Driver').props.onClick();assert.equal(selected,'two');
props={...props,jobs:[{id:'updated',status:'pending'}]};dirty=true;await flush();assert.equal(comparisons,1,'live jobs must not trigger Google refresh');
button('Refresh estimates').props.onClick();await flush();assert.equal(comparisons,2,'explicit refresh runs one comparison');
button('Driver arrival recommendations').props.onClick();await flush();assert.equal(comparisons,2);
button('Driver arrival recommendations').props.onClick();await flush();assert.equal(comparisons,3);
console.log('PASS: production panel open/refresh only, no feed polling, unknown driver selectable, Google attribution');
