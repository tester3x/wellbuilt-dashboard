import {deriveOffShiftGrant,offlineHash,validateOfflineEvent,type OfflineGrant} from '../jsaOfflineCore';
const hour=3600000,root:OfflineGrant={version:1,id:'a'.repeat(64),companyId:'c',driverId:'d',issuedAtMs:1000,expiresAtMs:1000+14*hour,shiftId:null,binding:{jsaPeriodId:'b'.repeat(48),shiftState:'independent',requiresActiveShift:false},requirementKey:'old',policyDay:'2026-11-24',mode:'per_job',allowAcknowledge:true,operators:['XTO'],assessments:[],fullReadId:'old-read',offShiftPreparation:{validUntilMs:1000+72*hour,windowMs:14*hour}};
const period={rootGrantId:root.id,periodId:'c'.repeat(48),startedAtMs:1000+14*hour};
test('off-shift renewal keeps permissions frozen and requires a new read after fourteen elapsed hours',()=>{
 const g=deriveOffShiftGrant(root,period);expect(g.id).toBe(offlineHash(['off-shift',root.id,period.periodId,period.startedAtMs]));expect(g.fullReadId).toBeNull();expect(g.shiftId).toBeNull();expect(g.expiresAtMs-period.startedAtMs).toBe(14*hour);expect(g.operators).toEqual(root.operators);expect(g.binding.jsaPeriodId).toBe(period.periodId);
});
test.each([{rootGrantId:'foreign'},{periodId:'bad/path'},{startedAtMs:999+72*hour+2},{startedAtMs:-999999},{operators:['injected']}])('malformed/expanded renewal is refused %p',patch=>{expect(()=>deriveOffShiftGrant(root,{...period,...patch})).toThrow('off_shift_preparation');});
test('a new off-shift period drops the old shift association and read',()=>{const g=deriveOffShiftGrant({...root,shiftId:'old-shift',binding:{...root.binding,associatedPeriodId:'old-shift'}},period);expect(g.binding.associatedPeriodId).toBeUndefined();expect(g.fullReadId).toBeNull();});
test('ack cannot substitute for reading the new period; midnight does not affect validity',()=>{
 const g=deriveOffShiftGrant(root,period),e:any={version:1,id:'E'.repeat(43),grantId:g.id,jobRef:'job',operator:'XTO',kind:'acknowledged',fullReadId:'old-read',occurredAtMs:g.issuedAtMs+100};
 const job={companyId:'c',driverId:'d',operator:'XTO'},p={id:g.binding.jsaPeriodId,companyId:'c',driverId:'d',shiftId:null,state:'open'};
 expect(()=>validateOfflineEvent(g,e,job,p,{requestId:'old-read',companyId:'c',driverId:'d',binding:root.binding,state:'completed',action:'read_and_acknowledged',completedAtMs:1000},e.occurredAtMs+48*hour)).toThrow('qualifying_read');
});
