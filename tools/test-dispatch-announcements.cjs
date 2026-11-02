// Real callable handlers, in-memory Firestore/RTDB ports. No production data.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const root=process.cwd(),dashboard=fs.existsSync('functions/src/security/staffChat.ts');
const source=dashboard?'functions/src/security/':'functions/src/';
const docs=new Map();let writes=0,clock=Date.parse('2026-11-02T08:00:00Z');
const snapshot=(p)=>({id:p.split('/').at(-1),exists:docs.has(p),data:()=>docs.get(p),get:k=>docs.get(p)?.[k]});
function ref(p){return {id:p.split('/').at(-1),path:p,get:async()=>snapshot(p),collection:n=>query(p+'/'+n),set:async row=>{docs.set(p,row);writes++;},update:async row=>{docs.set(p,{...docs.get(p),...row});writes++;}};}
function query(p,filters=[]){return {doc:id=>ref(p+'/'+id),where:(...f)=>query(p,[...filters,f]),get:async()=>({docs:[...docs.keys()].filter(k=>k.startsWith(p+'/')&&k.slice(p.length+1).indexOf('/')<0).filter(k=>filters.every(([field,op,v])=>op==='array-contains'?docs.get(k)[field]?.includes(v):docs.get(k)[field]===v)).map(snapshot)})};}
const db={collection:n=>query(n),doc:p=>ref(p),runTransaction:async fn=>fn({get:r=>r.get(),create:(r,data)=>{assert.ok(!docs.has(r.path));docs.set(r.path,data);writes++;},set:(r,data)=>{docs.set(r.path,{...docs.get(r.path),...data});writes++;},update:(r,data)=>{docs.set(r.path,{...docs.get(r.path),...data});writes++;}})};
const profiles={on:{companyId:'co',active:true,legalName:'Real On Shift',onShift:true},off:{companyId:'co',active:true,legalName:'Real Off Shift',onShift:false},inactive:{companyId:'co',active:false,legalName:'Inactive'},foreign:{companyId:'other',active:true,legalName:'Foreign'}};
const users={dispatch:{companyId:'co',legalName:'Real Dispatcher'},second:{companyId:'co',legalName:'Second Dispatcher'},viewer:{companyId:'co',legalName:'Viewer'}};
const records={'drivers/profiles':profiles,'drivers/approved':{},'drivers/identityBindings/byDriver':{},'drivers/identityBindings/byApproved':{},users};
const rt={ref:p=>{let child,eq;const q={orderByChild:k=>{child=k;return q;},equalTo:v=>{eq=v;return q;},once:async()=>{let row=records[p]??(p.startsWith('drivers/profiles/')?profiles[p.slice(17)]:p.startsWith('users/')?users[p.slice(6)]:null);if(child&&row)row=Object.fromEntries(Object.entries(row).filter(([,v])=>v[child]===eq));return {val:()=>row};}};return q;}};
const firestore=()=>db;firestore.FieldValue={serverTimestamp:()=>new Date(++clock).toISOString()};
const admin={firestore,database:()=>rt};
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
const fns={https:{HttpsError},runWith:()=>({https:{onCall:fn=>fn}}),logger:{warn:()=>{}}};
const cache=new Map();
const mock={
 'firebase-admin':admin,'firebase-functions/v1':fns,'firebase-functions/v1/https':{HttpsError},
 'firebase-functions/v2/https':{HttpsError,onCall:(_,fn)=>fn},
 './dispatchConversations':{CONVERSATIONS:'dispatch_conversations',governedId:()=>false,conversationCollection:()=> 'chat_threads',validConversation:()=>false,consolidateDispatchHistory:async()=> 'unused'},
 './driverChatPresentation':{presentDriverChat:row=>row},'./chatUnreadSummary':{readUnreadSummary:async()=>({unreadCount:0})},
 './chatMessageAuthors':{presentMessageAuthors:async rows=>rows},
 './trustedStaffAuthority':{requireTrustedCompanyCapability:async(uid,cap)=>{if(!users[uid])throw new HttpsError('unauthenticated','Sign in');if(uid==='viewer'&&cap==='sendChat')throw new HttpsError('permission-denied','Send denied');return {uid,companyId:'co'};},decideTrustedCompanyCapability:(uid,_row,cap)=>({ok:uid!=='viewer'&&cap!=='never',companyId:'co'})},
};
function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const m={exports:{}};cache.set(file,m.exports);const requireLocal=id=>mock[id]|| (id.startsWith('.')?load(path.resolve(path.dirname(file),id+'.ts')):require(id));vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{require:requireLocal,module:m,exports:m.exports,Date,Map,Set,console,Buffer});return m.exports;}
const core=load(source+'dispatchAnnouncements.ts');
const driver=dashboard?null:load(source+'driverChat.ts').handleDriverChat;
const staff=dashboard?load(source+'staffChat.ts').staffChat:null;
const actor=(id,office=false)=>({companyId:office?'co':profiles[id]?.companyId||'co',id,name:office?'Real Dispatcher':profiles[id]?.legalName,staff:office});
const threadId=core.announcementId('co');
const driverCall=(id,data)=>driver?driver(data,{auth:{uid:'auth-'+id,token:{kind:'driver',driverId:id,companyId:profiles[id].companyId}}}):core.handleAnnouncement(actor(id),data);
const staffCall=(data,uid='dispatch')=>staff?staff({auth:{uid},data}):core.handleAnnouncement({...actor(uid,true),name:uid==='second'?'Second Dispatcher':'Real Dispatcher'},data,async()=>Object.entries(profiles).filter(([,p])=>p.active!==false&&p.companyId==='co').map(([hash,p])=>({hash,name:p.legalName})));
const denied=async fn=>{await assert.rejects(fn,e=>e.code==='permission-denied'||e.code==='unauthenticated');};
(async()=>{
 const initial=await core.announcementThread(actor('off'));assert.equal(initial.permanent,true);assert.equal(initial.unreadCount,0);assert.equal(writes,0,'listing an empty permanent room must not write');
 for(const action of ['send','archive','clear','members','broadcast','photoUpload'])await denied(()=>driverCall('off',{action,threadId,clientId:'fake',text:'forged',staff:true,senderName:'Admin',base64:'notphoto'}));
 if(staff){await denied(()=>staffCall({action:'send',threadId,clientId:'denied',text:'No'},'viewer'));await denied(()=>staffCall({action:'threads',companyId:'other'}));await denied(()=>staffCall({action:'send',threadId,clientId:'forged',text:'No'},'not-staff'));}
 for(let i=0;i<3;i++){const result=await staffCall({action:'send',threadId,clientId:'notice'+i,text:'Announcement '+i,senderName:'FakeLogin',driverIds:['foreign']},i===2?'second':'dispatch');assert.equal(result.ok,true);}
 const msgPath='dispatch_announcements/'+threadId+'/messages/c_notice0';
 assert.deepEqual(Array.from(docs.get(msgPath).recipientIds).sort(),['off','on']);assert.equal(docs.get(msgPath).senderName,'Real Dispatcher');
 const beforeRetry=writes;assert.equal((await staffCall({action:'send',threadId,clientId:'notice0',text:'Announcement 0'})).duplicate,true);assert.equal(writes,beforeRetry);await denied(()=>staffCall({action:'send',threadId,clientId:'notice0',text:'Changed'}));
 const beforeRead=writes;await driverCall('off',{action:'read',threadId});assert.equal(writes,beforeRead);assert.equal((await core.announcementThread(actor('off'))).unreadCount,3);
 const offRows=(await driverCall('off',{action:'messages',threadId})).messages;assert.equal(offRows.length,3);assert.equal(offRows[0].receiptSummary,undefined,'driver cannot see coworkers receipts');assert.equal(offRows[2].senderName,'Second Dispatcher');
 await driverCall('off',{action:'acknowledge',threadId,messageId:'c_notice0',driverId:'on'});assert.equal((await core.announcementThread(actor('off'))).unreadCount,2);assert.equal((await core.announcementThread(actor('on'))).unreadCount,3,'cannot acknowledge another driver');
 const afterAck=writes;await driverCall('off',{action:'acknowledge',threadId,messageId:'c_notice0'});assert.equal(writes,afterAck,'retry preserves original receipt');
 await denied(()=>driverCall('off',{action:'acknowledge',threadId,messageId:'absent'}));
 await denied(()=>driverCall('foreign',{action:'messages',threadId}));await denied(()=>driverCall('off',{action:'messages',threadId:core.announcementId('other')}));
 const officeRows=(await staffCall({action:'messages',threadId})).rows;assert.equal(officeRows[0].receiptSummary.length,2);assert.equal(officeRows[0].receiptSummary.filter(r=>r.acknowledgedAt).length,1);assert.equal((await core.announcementThread(actor('dispatch',true))).unreadCount,0,'no outgoing announcement badge for dispatch');
 for(const action of ['archive','clear','broadcast','members'])await denied(()=>staffCall({action,threadId}));
 // Old notices remain pending beyond the ordinary 50-message chat window.
 for(let i=3;i<55;i++)await staffCall({action:'send',threadId,clientId:'notice'+i,text:'Announcement '+i});
 const pending=await core.announcementThread(actor('off'));assert.equal(pending.unreadCount,54);assert.equal(pending.lastUnreadMessage.text,'Announcement 54');
 const old=(await driverCall('off',{action:'messages',threadId,count:1})).messages;assert.ok(old.some(r=>r.id==='c_notice1'&&!r.acknowledgedAt),'ordinary chat limits must not bury pending announcements');
 if(staff){const list=await staffCall({action:'threads',ownOnly:true});assert.equal(list.rows[0].permanent,true);}
 if(driver){const list=await driverCall('off',{action:'threads'});assert.equal(list.threads[0].permanent,true);assert.equal(list.threads[0].unreadCount,54);}
 console.log('PASS '+(dashboard?'staff':'driver')+' announcements: off-shift roster, trusted authors, read/ack separation, immutable cohort, retries, tenant fences, forbidden mutations, individual receipts, permanent room and >50 pending notices.');
})().catch(e=>{console.error(e);process.exitCode=1;});
