/* Exact client modules execute with test-only transport/session/storage adapters.
 * Storage here is browser IndexedDB, NOT native AsyncStorage or installed-app UI.
 */
(async()=>{
const output=document.querySelector('#status');const lines=[];
function log(s){lines.push(s);output.textContent=lines.join('\n');}
function check(x,s){if(!x)throw Error(s);log('PASS '+s);}
const boot=await fetch('/bootstrap').then(r=>r.json()),prefix='audit/'+boot.run+'/';
let owner={...boot.identities.a.jsa},offline=false,drop=false,switchAfter=false,calls=0;
const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('wellbuilt-synthetic-audit',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const disk=(mode,key,value)=>new Promise((resolve,reject)=>{const tx=db.transaction('kv',mode),store=tx.objectStore('kv');const req=mode==='readonly'?store.get(prefix+key):value===undefined?store.delete(prefix+key):store.put(value,prefix+key);let result;req.onsuccess=()=>{result=req.result;};tx.oncomplete=()=>resolve(result??null);tx.onerror=()=>reject(tx.error);});
const storage={getItem:k=>disk('readonly',k),setItem:(k,v)=>disk('readwrite',k,v),removeItem:k=>disk('readwrite',k)};
async function rpc(name,data,identity=owner){
 if(offline)throw Error('offline_test');calls++;
 const headers={'Content-Type':'application/json',Authorization:'Bearer '+identity.token};if(drop)headers['X-Test-Drop-Receipt']='once';
 const r=await fetch('/rpc/'+name,{method:'POST',headers,body:JSON.stringify(data)});const result=await r.json();if(!r.ok)throw Error(result.error);
 if(switchAfter){switchAfter=false;owner={...boot.identities.b.jsa};}
 return result;
}
function load(code,ports){const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,n=>{if(!(n in ports))throw Error('Unexpected dependency '+n);return ports[n];});return m.exports;}
const evidence=load(boot.sources.evidence.code,{'./sso/jsaGovernedAuthLive':{loadUsableGovernedSession:async()=>({...owner})},'./firebase':{app:{}},'firebase/functions':{getFunctions:()=>({}),httpsCallable:(_f,n)=>async data=>rpc(n,data)}});
const invoice=load(boot.sources.invoice.code,{'@react-native-async-storage/async-storage':{default:storage},'expo-crypto':{randomUUID:()=>crypto.randomUUID()}}).createInvoiceAllocation({read:storage.getItem,write:storage.setItem,remove:storage.removeItem,owner:async c=>{if(c&&c!==owner.companyId)throw Error('owner_changed');return {uid:owner.uid,driverId:owner.driverId,companyId:owner.companyId};},mint:()=>crypto.randomUUID(),call:async(o,requestId)=>(await rpc('assignInvoiceBlock',{companyId:o.companyId,requestId})).data});
async function rejects(fn,label){let refused=false;try{await fn();}catch{refused=true;}check(refused,label);}
async function finish(fn){try{await fn();}catch(e){log('FAIL '+e.message);await fetch('/result',{method:'POST',body:JSON.stringify({status:'failed',lines})});}}
document.querySelector('#offline').onclick=()=>finish(async()=>{
 const original=JSON.stringify(boot.record);await storage.setItem('original',original);await storage.setItem('pending',boot.record.id);
 const before=calls;offline=true;await rejects(()=>evidence.persistLegacyJsaEvidence(JSON.parse(original)),'offline archive refuses to claim delivery');
 check(calls===before,'offline save made no transport call');check(await storage.getItem('original')===original,'signed original unchanged');check(await storage.getItem('pending')===boot.record.id,'pending work retained');offline=false;
 log('Ready to reload page, then retry.');await fetch('/result',{method:'POST',body:JSON.stringify({status:'offline-saved',lines,sourceHashes:{evidence:boot.sources.evidence.sha256,invoice:boot.sources.invoice.sha256}})});
});
document.querySelector('#retry').onclick=()=>finish(async()=>{
 const raw=await storage.getItem('original');check(raw===JSON.stringify(boot.record),'original and pending survived page restart');owner={...boot.identities.a.jsa};drop=true;
 await rejects(()=>evidence.persistLegacyJsaEvidence(JSON.parse(raw)),'lost receipt response stays pending');drop=false;
 check(await storage.getItem('original')===raw,'lost response did not alter signature or time');
 await evidence.persistLegacyJsaEvidence(JSON.parse(raw));await evidence.persistLegacyJsaEvidence(JSON.parse(raw));log('PASS receipt retry and identical replay confirmed');
 const before=calls;owner={...boot.identities.b.jsa};await rejects(()=>evidence.persistLegacyJsaEvidence(JSON.parse(raw)),'company B cannot adopt A signed original');check(calls===before,'foreign original refused before transport');
 await rejects(()=>rpc('jsaLegacyEvidence',{operation:'get_receipt',requestId:boot.record.legacyReceiptBinding.requestId}),'server denies foreign receipt');
 owner={...boot.identities.a.jsa};switchAfter=true;await rejects(()=>evidence.persistLegacyJsaEvidence(JSON.parse(raw)),'account switch during response cannot confirm A upload');owner={...boot.identities.a.jsa};await evidence.persistLegacyJsaEvidence(JSON.parse(raw));
 const saved=await rpc('jsaLegacyEvidence',{operation:'get_receipt',requestId:boot.record.legacyReceiptBinding.requestId});check(saved.data.receipt.completedAt===boot.record.timestamp,'receipt preserves original signed timestamp');
 owner={...boot.identities.a.wbt};const a=await invoice.allocate(owner.companyId);await invoice.save({...a,current:a.current+1,used:1});
 const onlineCalls=calls;offline=true;check((await invoice.read(owner.companyId)).current===a.start+1,'cached A number block works offline');check(calls===onlineCalls,'cached access makes no Firebase request');offline=false;
 owner={...boot.identities.b.wbt};check(await invoice.read(owner.companyId)===null,'B cannot consume A cache');const b=await invoice.allocate(owner.companyId);check(b.prefix==='B'&&b.companyId===owner.companyId,'B receives only B attribution');
 await rejects(()=>rpc('assignInvoiceBlock',{companyId:a.companyId,requestId:crypto.randomUUID()}),'forged company rejected server-side');
 owner={...boot.identities.a.wbt};check((await invoice.read(owner.companyId)).current===a.start+1,'A to B to A preserves consumed progress');await invoice.save(a);check((await invoice.read(owner.companyId)).current===a.start+1,'stale cache cannot roll numbers back');
 const proof=await fetch('/verify').then(r=>r.json());check(proof.originalUnchanged&&proof.signedCount===1,'exactly one unchanged signed record in emulator');check(proof.receiptCount===1&&proof.receiptTimeUnchanged,'exactly one original-time receipt');check(proof.companyABlocks===1,'exactly one company A allocation');check(await storage.getItem('original')===raw,'local signed evidence still intact');
 document.body.className='pass';log('COMPLETE — browser logic/transport validation only; native app acceptance remains.');
 await fetch('/result',{method:'POST',body:JSON.stringify({status:'passed',lines,proof,sourceHashes:{evidence:boot.sources.evidence.sha256,invoice:boot.sources.invoice.sha256}})});
});
log('Ready. No production configuration loaded.');
if(await storage.getItem('original'))log('A saved synthetic original is waiting for retry.');
})();
