import {readShiftJsaSummary,parseShiftSummaryInput,type ShiftJsaSummaryDeps} from '../jsaShiftSummary';
import {shiftJsaSummaryStore} from '../jsaShiftSummaryStore';
const subject={companyId:'c',driverId:'d'},shift='2026-10-18_230000',period='a'.repeat(48),id='A'.repeat(43);
const snapshot={prepared:{trained:true},locationAcks:{},locations:['Well'],stepsAcknowledged:true,stepAcks:{one:true},ppeSelected:{gloves:true},ppeOtherItems:[],notes:'PRIVATE NOTE',pusher:'',otherInfo:'',printedName:'Driver',signature:{mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')}};
const read={...subject,requestId:id,jobRef:'first',state:'completed',action:'read_and_acknowledged',completedAtMs:100,binding:{jsaPeriodId:period,policyDay:'2026-10-18'}};
function deps(rows:Record<string,any[]>={},artifact:any={...read,snapshot}):ShiftJsaSummaryDeps{return {list:async c=>rows[c]||[],artifact:async()=>artifact};}
const base={jsa_work_periods:[{...subject,id:period,shiftId:shift,state:'finalized'}],jsa_governed_requests:[read]};
test('closed shift includes pre-shift read after context attachment, independent of date',async()=>{
 const out=await readShiftJsaSummary(deps(base),subject,shift);expect(out.status).toBe('recorded');expect(out.lifecycle).toBe('finalized');expect(out.fullReadCount).toBe(1);expect(out.shiftId).toBe(shift);expect(JSON.stringify(out)).not.toContain('PRIVATE');expect(JSON.stringify(out)).not.toContain('signature');
});
test('split/multi job acknowledgements and once-per-shift coverage link to signed evidence, deduplicated',async()=>{
 const ack=(jobRef:string)=>({...subject,jobRef,requirementKey:'jsa:'+period,fullReadId:id,method:'acknowledged',recordedAtMs:200});
 const out=await readShiftJsaSummary(deps({...base,jsa_job_acknowledgments:[ack('second'),ack('third'),ack('third')],jsa_job_read_coverage:[{...ack('fourth'),method:'scope_read'}]}),subject,shift);
 expect(out.acknowledgementCount).toBe(2);expect(out.coveredJobCount).toBe(1);expect(out.jobCount).toBe(4);
});
test.each([{fullReadId:'missing'},{recordedAtMs:50},{requirementKey:'jsa:'+'b'.repeat(48),periodId:shift}])('bad acknowledgement reference is partial, never fulfilled: %j',async change=>{
 const out=await readShiftJsaSummary(deps({...base,jsa_job_acknowledgments:[{...subject,jobRef:'second',periodId:shift,requirementKey:'jsa:'+period,fullReadId:id,method:'acknowledged',recordedAtMs:200,...change}]}),subject,shift);
 expect(out.status).toBe('partial');expect(out.acknowledgementCount).toBe(0);
});
test.each([null,{...read,snapshot:{...snapshot,signature:null}},{...read,companyId:'other',snapshot}])('unverified artifact never counts',async a=>{
 const out=await readShiftJsaSummary(deps(base,a),subject,shift);expect(out.status).toBe('partial');expect(out.fullReadCount).toBe(0);
});
test('other shift and pending request never substitute for a full read',async()=>{
 const out=await readShiftJsaSummary(deps({jsa_governed_requests:[{...read,binding:{periodId:'2026-10-19_230000'}},{...read,state:'pending'}]}),subject,shift);expect(out.status).toBe('no_evidence');
});
test('legacy exact-shift governed artifact works; day-status flags and Sept22 standalone do not count',async()=>{
 const r={...read,binding:{associatedPeriodId:shift}};
 const out=await readShiftJsaSummary(deps({jsa_governed_requests:[r]}, {...r,snapshot}),subject,shift);expect(out.fullReadCount).toBe(1);expect(out.lifecycle).toBe('unknown');
 expect((await readShiftJsaSummary(deps(),subject,shift)).status).toBe('no_evidence');
});
test('legacy acknowledgement without a read ID uses earlier verified evidence from that exact shift only',async()=>{
 const r={...read,binding:{associatedPeriodId:shift}};
 const ack={...subject,jobRef:'legacy',periodId:shift,method:'acknowledged',recordedAtMs:200};
 const out=await readShiftJsaSummary(deps({jsa_governed_requests:[r],jsa_job_acknowledgments:[ack]},{...r,snapshot}),subject,shift);
 expect(out.status).toBe('recorded');expect(out.acknowledgementCount).toBe(1);
 const newer=await readShiftJsaSummary(deps({jsa_governed_requests:[r],jsa_job_acknowledgments:[{...ack,requirementKey:'jsa:'+period}]},{...r,snapshot}),subject,shift);
 expect(newer.status).toBe('partial');expect(newer.acknowledgementCount).toBe(0);
});
test.each(['companyId','driverId'])('rejects foreign %s rows',async key=>{await expect(readShiftJsaSummary(deps({jsa_work_periods:[{...subject,[key]:'foreign'}]}),subject,shift)).rejects.toThrow('scope_or_size');});
test('bounded read fails instead of returning partial history',async()=>{await expect(readShiftJsaSummary(deps({jsa_work_periods:Array(2001).fill(subject)}),subject,shift)).rejects.toThrow('scope_or_size');});
test('no shift makes no history reads and never creates a new period',async()=>{expect((await readShiftJsaSummary({list:async()=>{throw Error('must not read')},artifact:async()=>null},subject,null)).status).toBe('no_shift');});
test('request permits only an exact explicit shift and never client identity/date scope',()=>{
 expect(parseShiftSummaryInput({protocolVersion:1})).toBeNull();expect(parseShiftSummaryInput({protocolVersion:1,shiftId:shift})).toBe(shift);
 for(const b of [null,[],{protocolVersion:1,driverId:'foreign'},{protocolVersion:1,shiftId:'2026-10-18'},{protocolVersion:1,date:'2026-10-18'}])expect(()=>parseShiftSummaryInput(b)).toThrow('invalid_input');
});
test('production store queries only exact owner + shift/context and deduplicates query hits',async()=>{
 const queries:any[]=[];
 const db={collection:(collection:string)=>{
  const filters:any[]=[];
  const q={where:(...args:any[])=>{filters.push(args);return q;},limit:(n:number)=>{expect(n).toBe(2001);return q;},get:async()=>{queries.push({collection,filters});return {docs:[{id:'same',data:()=>subject}]};}};return q;
 }};
 const rows=await shiftJsaSummaryStore(db as any).list('jsa_governed_requests','c','d',{shiftId:shift,periodIds:[period]});
 expect(rows.length).toBe(1);expect(queries.length).toBe(3);
 for(const q of queries){expect(q.filters).toContainEqual(['companyId','==','c']);expect(q.filters).toContainEqual(['driverId','==','d']);expect(q.filters.length).toBe(3);}
 expect(queries.map(q=>q.filters[2])).toContainEqual(['binding.jsaPeriodId','==',period]);
});

test('one signed read has one document number across acknowledgements, including old per-job numbers',async()=>{
 const numberedRead={...read,jsaNumber:'JSA-20261018-180000-000042'};
 const acks=['second','third','fourth'].map((jobRef,i)=>({...subject,jobRef,requirementKey:'jsa:'+period,fullReadId:id,method:'acknowledged',recordedAtMs:200+i,jsaNumber:`JSA-20261018-190000-10000${i}`}));
 const rows={...base,jsa_governed_requests:[numberedRead],jsa_job_acknowledgments:acks};
 const before=JSON.stringify(rows);
 const out=await readShiftJsaSummary(deps(rows,{...numberedRead,snapshot}),subject,shift);
 expect(out.jsaNumbers).toEqual([numberedRead.jsaNumber]);
 expect(out.fullReadCount).toBe(1);expect(out.acknowledgementCount).toBe(3);expect(out.jobCount).toBe(4);
 expect(JSON.stringify(rows)).toBe(before);
});

test('separately signed read-every-job documents keep separate numbers',async()=>{
 const reads=[{...read,jsaNumber:'JSA-20261018-180000-000042'},{...read,requestId:'B'.repeat(43),jobRef:'second',completedAtMs:150,jsaNumber:'JSA-20261018-190000-000043'}];
 const out=await readShiftJsaSummary({list:async c=>c==='jsa_work_periods'?base.jsa_work_periods:c==='jsa_governed_requests'?reads:[],artifact:async requestId=>({...reads.find(r=>r.requestId===requestId),snapshot})},subject,shift);
 expect(out.jsaNumbers).toEqual(reads.map(r=>r.jsaNumber));expect(out.fullReadCount).toBe(2);expect(out.jobCount).toBe(2);
});
