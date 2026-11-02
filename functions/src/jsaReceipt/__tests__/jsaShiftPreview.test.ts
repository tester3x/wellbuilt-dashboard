import {readShiftJsaPreview,type ShiftPreviewDeps} from '../jsaShiftPreview';
import {readJsaHomeState} from '../jsaHomeState';
const owner={companyId:'company',driverId:'driver'},shiftId='2026-11-01_100747',period='a'.repeat(48),id='A'.repeat(43);
const snapshot={prepared:{trained:true},locationAcks:{},locations:[],stepsAcknowledged:true,stepAcks:{one:true},ppeSelected:{gloves:true},ppeOtherItems:[],notes:'Signed notes',pusher:'',otherInfo:'',printedName:'Real Driver',signature:{mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')}};
const read={...owner,requestId:id,jobRef:'gabriel2',binding:{jsaPeriodId:period,associatedPeriodId:shiftId},state:'completed',action:'read_and_acknowledged',completedAtMs:100};
const ack={...owner,fullReadId:id,jobRef:'burger',method:'acknowledged',recordedAtMs:200,job:{wellName:'Burger 1',jobType:'Production Water',dropOff:'SWD'}};
const body={protocolVersion:1};
const deps=(extra:Partial<ShiftPreviewDeps>={}):ShiftPreviewDeps=>({
 shift:async()=>({state:'open',periodId:shiftId}),
 list:async c=>c==='jsa_work_periods'?[{...owner,id:period,shiftId,state:'open'}]:c==='jsa_governed_requests'?[read]:c==='jsa_job_acknowledgments'?[ack]:[],
 artifact:async()=>({...read,snapshot,receiptHandle:'secret'}),job:async()=>({...owner,wellName:'Gabriel 2',commodityType:'Production Water',hauledTo:'SWD'}),
 history:async()=>({requests:[read],standalone:[]}),linkedStops:async()=>[ack],...extra,
});
test('current preview equals WB JSA record, includes first job with empty snapshot locations and later stops',async()=>{
 const d=deps(),preview=await readShiftJsaPreview(d,owner,body),home=await readJsaHomeState(d,owner,{protocolVersion:1,operation:'read'});
 expect(preview.record).toEqual((home as any).record);expect((preview.record as any).coveredJobs.map((r:any)=>r.wellName)).toEqual(['Gabriel 2','Burger 1']);
 expect(preview).toMatchObject({shiftState:'open',viewOnly:true,shiftId});expect(JSON.stringify(preview)).not.toContain('secret');
});
test('new shift without a signed JSA never borrows old history',async()=>{
 const history=jest.fn(async()=>({requests:[read],standalone:[]}));
 const out=await readShiftJsaPreview(deps({list:async()=>[],history}),owner,body);expect(out.record).toBeNull();expect(history).not.toHaveBeenCalled();
});
test('off shift reads most recent signed document, not ticket or calendar day, without resuming WB JSA',async()=>{
 const d=deps({shift:async()=>({state:'none'}),history:async()=>({requests:[{...read,completedAtMs:50},{...read,requestId:id,completedAtMs:100}],standalone:[]})});
 const out=await readShiftJsaPreview(d,owner,body);expect(out).toMatchObject({shiftState:'none',viewOnly:true,shiftId});expect(out.record?.id).toBe(id);
 expect((await readJsaHomeState(d,owner,{protocolVersion:1,operation:'status'})).action).toBe('new');
});
test('off shift can show a more recent closed standalone JSA with additions',async()=>{
 const r={...owner,id:'B'.repeat(43),state:'closed',signedAtMs:300,snapshot,job:{activity:'Service Work',wells:[{name:'Site'}]},additions:[{wells:[{name:'Second site'}]}]};
 const out=await readShiftJsaPreview(deps({shift:async()=>({state:'none'}),history:async()=>({requests:[read],standalone:[r]})}),owner,body);
 expect(out.record).toMatchObject({id:r.id,state:'closed',additions:r.additions});
});
test('unknown shift and missing selected artifact fail instead of silently using an older JSA',async()=>{
 await expect(readShiftJsaPreview(deps({shift:async()=>({state:'unverifiable'})}),owner,body)).rejects.toThrow('shift_unavailable');
 await expect(readShiftJsaPreview(deps({shift:async()=>({state:'none'}),artifact:async()=>null}),owner,body)).rejects.toThrow('record_unavailable');
});
test.each(['companyId','driverId'])('foreign historical %s is rejected',async field=>{
 await expect(readShiftJsaPreview(deps({shift:async()=>({state:'none'}),history:async()=>({requests:[{...read,[field]:'foreign'}],standalone:[]})}),owner,body)).rejects.toThrow('scope_or_size');
});
test('rejects caller-selected shift/job/owner and oversized history',async()=>{
 for(const b of [null,[],{...body,jobRef:'burger'},{...body,shiftId},{...body,driverId:'other'}])await expect(readShiftJsaPreview(deps(),owner,b)).rejects.toThrow('invalid_input');
 await expect(readShiftJsaPreview(deps({shift:async()=>({state:'none'}),history:async()=>({requests:Array(2001).fill(read),standalone:[]})}),owner,body)).rejects.toThrow('scope_or_size');
});
