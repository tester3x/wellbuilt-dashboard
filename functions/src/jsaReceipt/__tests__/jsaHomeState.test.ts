import {readJsaHomeState,type HomeDeps} from '../jsaHomeState';
const owner={companyId:'c',driverId:'d'},shiftId='2026-10-19_080000',period='a'.repeat(48),requestId='A'.repeat(43);
const snapshot={prepared:{trained:true},locationAcks:{},locations:['Well'],stepsAcknowledged:true,stepAcks:{one:true},ppeSelected:{gloves:true},ppeOtherItems:[],notes:'signed note',pusher:'',otherInfo:'',printedName:'Driver',signature:{mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')}};
const request={...owner,requestId,jobRef:'job',binding:{jsaPeriodId:period},state:'completed',action:'read_and_acknowledged',completedAtMs:100};
const rows:Record<string,any[]>={jsa_work_periods:[{...owner,id:period,shiftId,state:'open'}],jsa_governed_requests:[request]};
const deps=(extra:Partial<HomeDeps>={}):HomeDeps=>({shift:async()=>({state:'open',periodId:shiftId}),list:async c=>rows[c]||[],artifact:async()=>({...request,snapshot,receiptHandle:'secret',actorUidHash:'secret'}),...extra});
const body={protocolVersion:1,operation:'status'};
test('off shift always New without consulting stale open rows',async()=>{
 const out=await readJsaHomeState(deps({shift:async()=>({state:'none'}),list:async()=>{throw Error('must not read history')}}),owner,body);expect(out.action).toBe('new');expect(out.active).toBeNull();
});
test('current shift signed read gives Resume and status omits signed content',async()=>{
 const out=await readJsaHomeState(deps(),owner,body);expect(out.action).toBe('resume');expect(out.active?.id).toBe(requestId);expect(JSON.stringify(out)).not.toContain('signed note');expect(JSON.stringify(out)).not.toContain('secret');
 const read=await readJsaHomeState(deps(),owner,{...body,operation:'read'});expect((read as any).record.signatureImage).toMatch(/^data:image\/png/);expect(JSON.stringify(read)).not.toContain('secret');
});
test('current shift without a JSA gives New',async()=>{expect((await readJsaHomeState(deps({list:async()=>[]}),owner,body)).action).toBe('new');});
test('unknown shift cannot become New or Resume',async()=>{await expect(readJsaHomeState(deps({shift:async()=>({state:'unverifiable'})}),owner,body)).rejects.toThrow('shift_unavailable');});
test('closed context and another shift never resume even if date or associated shift looks similar',async()=>{
 const d=deps({list:async c=>c==='jsa_work_periods'?[{...owner,id:period,shiftId,state:'finalized'}]:c==='jsa_governed_requests'?[{...request,binding:{jsaPeriodId:period,associatedPeriodId:shiftId}}]:[]});expect((await readJsaHomeState(d,owner,body)).action).toBe('new');
});
test.each(['companyId','driverId'])('foreign %s records refused',async key=>{await expect(readJsaHomeState(deps({list:async()=>[{...owner,[key]:'other'}]}),owner,body)).rejects.toThrow('scope_or_size');});
test('bad signed artifact is unavailable rather than silently starting another JSA',async()=>{await expect(readJsaHomeState(deps({artifact:async()=>null}),owner,body)).rejects.toThrow('record_unavailable');});
test('pre-shift standalone record resumes only after its live context attaches to this shift',async()=>{
 const out=await readJsaHomeState(deps({list:async c=>c==='jsa_work_periods'?rows[c]:c==='standalone'?[{...owner,id:'S'.repeat(43),jsaPeriodId:period,state:'open',snapshot,signedAtMs:200,job:{activity:'Service Work',wells:[]}}]:[]}),owner,body);expect(out.active?.kind).toBe('standalone');expect(out.action).toBe('resume');
});
test('closed Sept22 standalone cannot make Resume',async()=>{
 const out=await readJsaHomeState(deps({list:async c=>c==='standalone'?[{...owner,id:'old',date:'2026-09-22',state:'closed',shiftId}]:[]}),owner,body);expect(out.action).toBe('new');
});
test('rejects caller-selected owner, shift, date and operation',async()=>{
 for(const b of [null,[],{...body,driverId:'other'},{...body,shiftId},{...body,date:'2026-10-19'},{...body,operation:'close'}])await expect(readJsaHomeState(deps(),owner,b)).rejects.toThrow('invalid_input');
});

test('Resume includes owned original job, company and linked acknowledgements only',async()=>{
 const d=deps({companyName:async()=> 'Test Hauler',job:async()=>({...owner,wellName:'Original Well',commodityType:'Production Water'}),list:async c=>c==='jsa_job_acknowledgments'?[
 {...owner,id:'ack',fullReadId:requestId,jobRef:'second',method:'acknowledged',recordedAtMs:200,job:{wellName:'Second Well',jobType:'Service Work'}},
 {...owner,id:'unrelated',fullReadId:'other',jobRef:'no',method:'acknowledged',recordedAtMs:201,job:{wellName:'Wrong Well'}}
 ]:rows[c]||[]});
 const out:any=await readJsaHomeState(d,owner,{...body,operation:'read'});
 expect(out.record.companyName).toBe('Test Hauler');expect(out.record.coveredJobs.map((j:any)=>j.wellName)).toEqual(['Original Well','Second Well']);
 expect(out.record.assessmentArchiveUnavailable).toBe(true);expect(out.record.signatureImage).toMatch(/^data:image/);
});
test('foreign original job cannot enrich Resume',async()=>{
 await expect(readJsaHomeState(deps({job:async()=>({companyId:'other',driverId:'d'})}),owner,{...body,operation:'read'})).rejects.toThrow('scope_or_size');
});
