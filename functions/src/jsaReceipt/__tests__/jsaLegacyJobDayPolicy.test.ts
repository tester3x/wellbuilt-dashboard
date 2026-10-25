import {resolveJobDayPolicy} from '../jsaLegacyJobDayPolicy';
const day='2026-10-18',p={uid:'u',app:'wbt',driverId:'d',companyId:'c',kind:'driver'};
function deps(mode='per_job',style='acknowledge',rows:any[]=[]):any{return {
 nowMs:()=>Date.parse('2026-10-18T15:00:00Z'),company:async()=>({jsaMode:mode,jsaJobPolicy:style}),
 sso:{getDriver:async()=>({driverId:'d',companyId:'c',active:true}),getCompanyContract:async()=>({state:'active',contract:{planId:'p',contractEnforced:true}}),getPlan:async()=>({planId:'p',status:'active',capabilities:['jsa'],apps:{'wellbuilt-jsa':{included:true,requiresActiveShift:true}}})},
 shift:async()=>({state:'open',periodId:'2026-10-18_080000',originLocalDate:day}),records:async()=>rows};}
const read={requestId:'A'.repeat(43),jobRef:'j',companyId:'c',driverId:'d',binding:{shiftState:'independent',policyDay:day,associatedPeriodId:'2026-10-18_080000',requiresActiveShift:false,jsaEnabled:true},state:'completed',action:'read_and_acknowledged'};
test('installed per-job clients retain date-shaped response and existing read/ack policy',async()=>{
 const scope=await resolveJobDayPolicy(deps('per_job','acknowledge',[read]),p);
 expect(scope).toMatchObject({hasRead:true,requirementKey:day,policy:{allowAcknowledge:true,minimumIntent:'read'}});
 expect(scope.binding).not.toHaveProperty('jsaPeriodId');
 expect((await resolveJobDayPolicy(deps('per_job','read',[read]),p)).policy.allowAcknowledge).toBe(false);
});
test('installed once-per-shift clients retain their original shift key',async()=>{
 expect(await resolveJobDayPolicy(deps('per_shift','acknowledge',[read]),p)).toMatchObject({requirementKey:'shift:2026-10-18_080000',hasRead:true});
});
test('installed off-shift clients can still read without creating a JSA shift context',async()=>{
 const d=deps();d.shift=async()=>({state:'none'});
 expect(await resolveJobDayPolicy(d,p)).toMatchObject({requirementKey:day,binding:{requiresActiveShift:false},hasRead:false});
});
