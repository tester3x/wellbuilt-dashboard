import { readWeeklyJsaForms, type WeeklyJsaDeps } from '../jsaWeeklyForms';
const auth={uid:'u1',claims:{kind:'driver',app:'jsa',companyId:'c1',driverId:'d1'}};
const body={startDate:'2026-10-12',endDate:'2026-10-18',timezone:'America/Chicago'};
const ms=Date.parse('2026-10-12T15:00:00Z');
const scope={companyId:'c1',driverId:'d1'};
function deps(extra:Partial<WeeklyJsaDeps>={}):WeeklyJsaDeps{return{list:async c=>c==='jsa_governed_requests'?[{...scope,requestId:'r1',state:'completed',action:'read_and_acknowledged',completedAtMs:ms,jobRef:'job1',binding:{periodId:'2026-10-12_080000'}}]:[],artifact:async()=>({...scope,requestId:'r1',jobRef:'job1',action:'read_and_acknowledged',snapshot:{signature:{data:'example'},printedName:'Driver'}}),...extra};}
test('completed past-shift read retains exact job/shift identity without changing duty records',async()=>{
 const out=await readWeeklyJsaForms(deps(),auth,body);expect(out.records).toHaveLength(1);expect(out.records[0]).toMatchObject({shiftId:'2026-10-12_080000',jobRef:'job1',kind:'jsa_read'});expect(out.records[0]).not.toHaveProperty('actorUidHash');
});
test('incomplete artifacts are disclosed, not emitted as signed forms',async()=>{
 const out=await readWeeklyJsaForms(deps({artifact:async()=>null}),auth,body);expect(out.records).toEqual([]);expect(out.missing).toHaveLength(1);
});
test.each(['wbt','wbs','admin'])('refuses wrong app audience %s',async app=>{await expect(readWeeklyJsaForms(deps(),{...auth,claims:{...auth.claims,app}},body)).rejects.toThrow('not_authorized');});
test('client cannot choose another owner',async()=>{await expect(readWeeklyJsaForms(deps(),auth,{...body,driverId:'d2'})).rejects.toThrow('invalid_period');});
test('cross-company rows cannot leak, even if the storage adapter returns them',async()=>{await expect(readWeeklyJsaForms(deps({list:async()=>[{...scope,companyId:'other'}]}),auth,body)).rejects.toThrow('scope_or_size');});
test('pending requests never become completion evidence',async()=>{
 const out=await readWeeklyJsaForms(deps({list:async()=>[{...scope,state:'pending',completedAtMs:ms}]}),auth,body);expect(out.records).toEqual([]);
});
test('WB T job acknowledgements are retained as acknowledgements',async()=>{
 const out=await readWeeklyJsaForms(deps({list:async c=>c==='jsa_job_acknowledgments'?[{...scope,id:'ack1',recordedAtMs:ms,periodId:'2026-10-12_080000',jobRef:'job2',method:'acknowledged'}]:[]}),auth,body);
 expect(out.records[0]).toMatchObject({kind:'jsa_ack',jobRef:'job2',source:'job_acknowledgment'});
});
test('first full JSA reference matches the exact shift, not the nearest date or another shift',async()=>{
 const out=await readWeeklyJsaForms(deps({list:async c=>c==='jsa_governed_requests'?[
  {...scope,requestId:'wrong-shift',state:'completed',action:'read_completed',completedAtMs:ms-2000,jobRef:'other',binding:{periodId:'2026-10-12_070000'}},
  {...scope,requestId:'right-read',state:'completed',action:'read_completed',completedAtMs:ms-1000,jobRef:'job1',binding:{periodId:'2026-10-12_080000'}},
 ]:c==='jsa_job_acknowledgments'?[{...scope,id:'ack1',recordedAtMs:ms,periodId:'2026-10-12_080000',jobRef:'job2',method:'acknowledged'}]:[],artifact:async id=>({...scope,requestId:id,jobRef:id==='right-read'?'job1':'other',action:'read_completed',snapshot:{signature:{data:'example'}}})}),auth,body);
 expect(out.records.find(r=>r.id==='ack1')).toMatchObject({fullReadId:'right-read'});
});

test('off-shift workday acknowledgements retain the exact first full read and no invented shift',async()=>{
 const out=await readWeeklyJsaForms(deps({list:async c=>c==='jsa_governed_requests'?[{...scope,requestId:'day-read',state:'completed',action:'read_and_acknowledged',completedAtMs:ms-1000,jobRef:'job1',binding:{shiftState:'independent',policyDay:'2026-10-12'}}]:c==='jsa_job_acknowledgments'?[{...scope,id:'day-ack',recordedAtMs:ms,policyDay:'2026-10-12',jobRef:'job2',method:'acknowledged'}]:[],artifact:async()=>({...scope,requestId:'day-read',jobRef:'job1',action:'read_and_acknowledged',snapshot:{signature:{data:'example'}}})}),auth,body);
 expect(out.records.find(r=>r.id==='day-ack')).toMatchObject({shiftId:null,fullReadId:'day-read',kind:'jsa_ack'});
});

test('overnight acknowledgement retains the server-selected full read even when its policy day differs',async()=>{
 const out=await readWeeklyJsaForms(deps({list:async c=>c==='jsa_governed_requests'?[{...scope,requestId:'night-read',state:'completed',action:'read_and_acknowledged',completedAtMs:ms-1000,jobRef:'job1',binding:{shiftState:'independent',policyDay:'2026-10-11',associatedPeriodId:'2026-10-11_210000'}}]:c==='jsa_job_acknowledgments'?[{...scope,id:'night-ack',recordedAtMs:ms,policyDay:'2026-10-12',periodId:'2026-10-11_210000',fullReadId:'night-read',jobRef:'job2',method:'acknowledged'}]:[],artifact:async()=>({...scope,requestId:'night-read',jobRef:'job1',action:'read_and_acknowledged',snapshot:{signature:{data:'example'}}})}),auth,body);
 expect(out.records.find(r=>r.id==='night-ack')).toMatchObject({fullReadId:'night-read'});
});
