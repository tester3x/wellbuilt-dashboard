const mockRead=jest.fn();
const mockWrite=jest.fn(()=>{throw Error('Feed must never write');});
let mockDispatch=true;
const mockProfiles=new Map<string,any>();
const mockProfileSave=jest.fn((id:string,value:any)=>{mockProfiles.set(id,{...mockProfiles.get(id),...value});});
jest.mock('firebase-functions/v2/https',()=>({onCall:(_:unknown,handler:unknown)=>handler,HttpsError:class extends Error{constructor(public code:string,message:string){super(message);}}}));
jest.mock('../trustedStaffAuthority',()=>({requireTrustedCompanyCapability:async(uid:string,capability:string)=>{if(!uid)throw Error('unauthenticated');if(uid==='reader'&&capability==='manageCompany')throw Error('profile_management_denied');return {uid,companyId:'company-a'};},decideTrustedCompanyCapability:()=>({ok:mockDispatch,companyId:'company-a'})}));
jest.mock('firebase-admin',()=>({database:()=>({ref:(path:string)=>{if(path.startsWith('users/'))return {once:async()=>({val:()=>null})};expect(path).toBe('packets/processed');const query:any={orderByChild:(field:string)=>{expect(field).toBe('companyId');return query;},equalTo:(company:string)=>{expect(company).toBe('company-a');return query;},once:mockRead,set:mockWrite,update:mockWrite};return query;}}),firestore:Object.assign(()=>({doc:()=>({get:async()=>({data:()=>({})})}),collection:(name:string)=>({doc:(id:string)=>{
 if(name!=='chat_monitors')throw Error('Virtual feed must not look up a stored conversation');
 return {get:async()=>({exists:mockProfiles.has(id),get:(field:string)=>mockProfiles.get(id)?.[field]}),set:async(value:any)=>mockProfileSave(id,value)};
}})}),{FieldValue:{serverTimestamp:()=>''}})}));
import {projectWhatsappLevels,whatsappLevelsId} from '../whatsappLevels';
import {staffChat} from '../staffChat';
const pull=(overrides:any={})=>({companyId:'company-a',packetId:'pull-a',source:'whatsapp_watchdog',canonicalProcessingComplete:true,requestType:'pull',wellName:'Olson',dateTimeUTC:'2026-11-02T01:00:00Z',tankLevelFeet:12,tankAfterInches:96,bblsTaken:140,watchdogProvenance:{author:'WhatsApp Adam',reportedBottomFeet:8,channelName:'North Area'},...overrides});
const invoke=(data:any,uid='staff')=>(staffChat as any)({auth:uid?{uid}:null,data});
test('projection scopes tenant, deduplicates packet IDs, includes original app pulls, excludes audit/incomplete rows and hides private fields',()=>{
 const rows=projectWhatsappLevels('company-a',{a:pull({token:'private',driverId:'canonical'}),copy:pull({driverId:'canonical'}),foreign:pull({companyId:'company-b',packetId:'foreign'}),partial:pull({packetId:'partial',canonicalProcessingComplete:false}),edit_a:pull({packetId:'edit'}),deleted:pull({packetId:'deleted',isDelete:true}),app:pull({packetId:'app',source:'wbm'}),stop:pull({packetId:'stop',source:'whatsapp_watchdog_stop'}),old:pull({source:undefined,packetId:'old',watchdogProvenance:undefined,historicalImport:{source:'whatsapp',author:'Legacy tag',reportedBottomFeet:7}}),unknown:pull({packetId:'unknown',wellName:'',tankLevelFeet:null,tankAfterInches:null,watchdogProvenance:{}}),case:pull({packetId:'case',wellName:' OLSON ',dateTimeUTC:'2026-11-02T02:00:00Z'})});
 expect(rows).toHaveLength(5);expect(rows.find(r=>r.id==='pull-a')).toMatchObject({wellKey:'olson',driverKey:'driver:canonical',senderName:'WhatsApp Adam',channel:'North Area'});expect(rows.find(r=>r.id==='case').wellKey).toBe('olson');expect(rows.find(r=>r.id==='app').sourceLabel).toBe('WB M');expect(rows.find(r=>r.id==='old').senderName).toBe('Legacy tag');expect(rows.find(r=>r.id==='unknown')).toMatchObject({wellKey:'__unidentified__',top:null,after:null});expect(JSON.stringify(rows)).not.toContain('private');
});
test('real callable rejects anonymous, non-dispatch, foreign room/company and all writes',async()=>{
 const threadId=whatsappLevelsId('company-a');await expect(invoke({action:'messages',threadId},'')).rejects.toThrow('unauthenticated');mockDispatch=false;await expect(invoke({action:'messages',threadId})).rejects.toMatchObject({code:'permission-denied'});mockDispatch=true;await expect(invoke({action:'messages',threadId:whatsappLevelsId('company-b')})).rejects.toMatchObject({code:'permission-denied'});await expect(invoke({action:'messages',threadId,companyId:'company-b'})).rejects.toMatchObject({code:'permission-denied'});for(const action of ['send','read','archive','clear','members','broadcast'])await expect(invoke({action,threadId})).rejects.toMatchObject({code:'permission-denied'});expect(mockRead).not.toHaveBeenCalled();expect(mockWrite).not.toHaveBeenCalled();
});
test('real callable reads only company query and never writes or duplicates on retry',async()=>{
 mockRead.mockResolvedValue({val:()=>({a:pull(),foreign:pull({companyId:'company-b'})})});const data={action:'messages',threadId:whatsappLevelsId('company-a')};const first=await invoke(data);expect(first.rows).toHaveLength(1);expect(await invoke(data)).toEqual(first);expect(mockRead).toHaveBeenCalledTimes(1);expect(mockWrite).not.toHaveBeenCalled();
});

test('actual profile saver creates, retries and updates a virtual-feed slot without requiring a chat document',async()=>{
 mockProfiles.clear();mockProfileSave.mockClear();
 const threadId=whatsappLevelsId('company-a'),slot={threadId,threadTitle:'WhatsApp Levels'};
 const data={action:'saveProfile',profileId:'new-monitor',record:{name:'Dispatch Only',gridLayout:'2x2',threadType:'all',slots:[null,slot,null,null]}};
 expect(await invoke(data)).toEqual({ok:true,profileId:'new-monitor'});
 expect(mockProfiles.get('new-monitor')).toMatchObject({companyId:'company-a',slots:[null,slot,null,null]});
 expect(await invoke(data)).toEqual({ok:true,profileId:'new-monitor'});expect(mockProfiles.size).toBe(1);
 await invoke({...data,record:{slots:[null,null,slot,null]}});
 expect(mockProfiles.get('new-monitor')).toMatchObject({name:'Dispatch Only',gridLayout:'2x2',slots:[null,null,slot,null]});
 await invoke({...data,record:{slots:[null,null,null,null]}});
 expect(mockProfiles.get('new-monitor').slots).toEqual([null,null,null,null]);
 expect(mockWrite).not.toHaveBeenCalled();
});
test('virtual feed profile slots retain tenant, dispatch and profile-management fences',async()=>{
 const data={action:'saveProfile',profileId:'safe-monitor',record:{slots:[{threadId:whatsappLevelsId('company-a')}]}};
 mockProfileSave.mockClear();
 await expect(invoke({...data,record:{slots:[{threadId:whatsappLevelsId('company-b')}]}})).rejects.toMatchObject({code:'permission-denied'});
 await expect(invoke({...data,record:{slots:[{threadId:'whatsapp_levels_forged'}]}})).rejects.toMatchObject({code:'permission-denied'});
 mockDispatch=false;try{await expect(invoke(data)).rejects.toMatchObject({code:'permission-denied'});}finally{mockDispatch=true;}
 await expect(invoke(data,'reader')).rejects.toThrow('profile_management_denied');
 mockProfiles.set('foreign-monitor',{companyId:'company-b',slots:[]});
 await expect(invoke({...data,profileId:'foreign-monitor'})).rejects.toMatchObject({code:'permission-denied'});
 expect(mockProfileSave).not.toHaveBeenCalled();expect(mockProfiles.get('foreign-monitor')).toEqual({companyId:'company-b',slots:[]});
});
