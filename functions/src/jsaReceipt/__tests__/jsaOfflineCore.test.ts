import {validateOfflineEvent,type OfflineGrant,type OfflineEvent} from '../jsaOfflineCore';
const grant:OfflineGrant={version:1,id:'g',companyId:'c',driverId:'d',issuedAtMs:1000,expiresAtMs:1000000,shiftId:'shift',binding:{jsaPeriodId:'p'},requirementKey:'jsa:p',policyDay:'2026-10-23',mode:'per_job',allowAcknowledge:true,operators:['Operator A','Operator B'],assessments:[{name:'JSA',contentHash:'h',packageId:null,tasks:[],steps:[{id:'s'}],ppeItems:[],preparedItems:[{id:'r'}]}],fullReadId:'R'.repeat(43)};
const event:OfflineEvent={version:1,id:'E'.repeat(43),grantId:'g',jobRef:'j',operator:'Operator A',occurredAtMs:2000,kind:'acknowledged',fullReadId:'R'.repeat(43)};
const job={companyId:'c',driverHash:'d',operator:'Operator A'};
const period={id:'p',companyId:'c',driverId:'d',shiftId:'shift',state:'open'};
const read={requestId:'R'.repeat(43),companyId:'c',driverId:'d',binding:{jsaPeriodId:'p'},state:'completed',action:'read_and_acknowledged',completedAtMs:1500};
const run=(g:any=grant,e:any=event,j:any=job,p:any=period,r:any=read)=>validateOfflineEvent(g,e,j,p,r,5000);
test('ack binds exact original owner, operator, full read and persistent work period',()=>{expect(run().method).toBe('acknowledged');});
test.each([{companyId:'other'},{driverId:'other'},null])('foreign or absent qualifying read is rejected: %p',patch=>{expect(()=>run(grant,event,job,period,patch?{...read,...patch}:null)).toThrow('qualifying_read');});
test.each([{companyId:'other'},{driverHash:'other'},{operator:'Unassigned'},null])('foreign or absent job is rejected: %p',patch=>{expect(()=>run(grant,event,patch?{...job,...patch}:null)).toThrow();});
test.each([{state:'pending'},{action:'read_completed'},{completedAtMs:2500},{binding:{jsaPeriodId:'other'}}])('unqualified evidence cannot be claimed offline: %p',patch=>{expect(()=>run(grant,event,job,period,{...read,...patch})).toThrow('qualifying_read');});
test('shift end before upload allows actions that actually occurred before end; late actions are refused',()=>{
 expect(run(grant,event,job,{...period,state:'finalized',finalizedAtMs:3000}).method).toBe('acknowledged');
 expect(()=>run(grant,event,job,{...period,state:'finalized',finalizedAtMs:1900})).toThrow('shift_ended');
});
test('new current calendar date is irrelevant to the frozen persistent period',()=>{expect(validateOfflineEvent(grant,event,job,period,read,86400000).method).toBe('acknowledged');});
test.each([{occurredAtMs:1000001},{occurredAtMs:200000},{grantId:'other'},{jobRef:'bad/path'},{id:'bad'},{kind:'off'},{snapshot:{}}])('malformed, expired and fabricated actions are refused: %p',patch=>{expect(()=>run(grant,{...event,...patch})).toThrow();});
test('per-shift coverage cannot be substituted for an explicit per-job acknowledgment',()=>{expect(()=>run(grant,{...event,kind:'scope_read'})).toThrow('policy_mismatch');expect(run({...grant,mode:'per_shift'},{...event,kind:'scope_read'}).method).toBe('scope_read');});
test('full read requires authored signature and all frozen assessment switches',()=>{
 const snapshot={prepared:{r:true},locationAcks:{},locations:[],stepsAcknowledged:true,stepAcks:{s:true},ppeSelected:{},ppeOtherItems:[],notes:'',pusher:'',otherInfo:'',printedName:'Test Driver',signature:{mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')}};
 const e={...event,kind:'read',fullReadId:undefined,assessmentHash:'h',snapshot};delete e.fullReadId;
 expect(run(grant,e).method).toBe('read');
 expect(()=>run(grant,{...e,snapshot:{...snapshot,prepared:{r:false}}})).toThrow('incomplete_read');
 expect(()=>run(grant,{...e,snapshot:{...snapshot,stepAcks:{}}})).toThrow('incomplete_read');
 expect(()=>run(grant,{...e,snapshot:{...snapshot,signature:{mimeType:'image/png',data:'not-a-png'}}})).toThrow('invalid_signed_read');
 expect(()=>run(grant,{...e,assessmentHash:'foreign'})).toThrow('assessment_scope');
 expect(()=>run({...grant,assessments:[{...grant.assessments[0],packageId:'foreign'}]},e)).toThrow('assessment_scope');
});
