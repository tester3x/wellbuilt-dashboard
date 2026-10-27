import {readSavedJobJsa,type SavedJobDeps} from '../jsaSavedJob';
const scope={companyId:'c',driverId:'d'},id='A'.repeat(43);
const auth={uid:'u',claims:{kind:'driver',app:'wbt',...scope}};
const snapshot={prepared:{trained:true},locationAcks:{},locations:['Original well'],stepsAcknowledged:true,stepAcks:{one:true},ppeSelected:{gloves:true},ppeOtherItems:[],notes:'Saved note',pusher:'',otherInfo:'',printedName:'Driver',signature:{mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')}};
const read={...scope,requestId:id,jobRef:'first-job',state:'completed',action:'read_and_acknowledged',completedAtMs:100,binding:{periodId:'old-shift'}};
const ack={...scope,jobRef:'job',method:'acknowledged',recordedAtMs:200,periodId:'old-shift'};
function deps(extra:Partial<SavedJobDeps>={}):SavedJobDeps{return {invoice:async()=>({...scope,wellName:'Current well'}),list:async c=>c==='jsa_governed_requests'?[read]:c==='jsa_job_acknowledgments'?[ack]:[],artifact:async()=>({...read,snapshot,receiptHandle:'private',actorUidHash:'private'}),...extra};}
const body={protocolVersion:1,jobRef:'job'};
test('legacy acknowledgement opens the same-shift earlier full read without current-shift checks',async()=>{
 const out=await readSavedJobJsa(deps(),auth,body);expect(out.acknowledgement?.method).toBe('acknowledged');expect(out.fullRead?.requestId).toBe(id);expect(out.fullRead?.snapshot.notes).toBe('Saved note');expect(JSON.stringify(out)).not.toContain('private');
});
test.each(['companyId','driverId'])('refuses foreign invoice %s',async field=>{await expect(readSavedJobJsa(deps({invoice:async()=>({...scope,wellName:'Well',[field]:'foreign'})}),auth,body)).rejects.toThrow('not_authorized');});
test('refuses wrong audience and injected identity',async()=>{
 await expect(readSavedJobJsa(deps(),{...auth,claims:{...auth.claims,app:'jsa'}},body)).rejects.toThrow('not_authorized');
 await expect(readSavedJobJsa(deps(),auth,{...body,driverId:'other'})).rejects.toThrow('invalid_job');
});
test('never substitutes another shift, later read, or pending read',async()=>{
 for(const change of [{binding:{periodId:'other'}},{completedAtMs:300},{state:'pending'}]){
 const out=await readSavedJobJsa(deps({list:async c=>c==='jsa_governed_requests'?[{...read,...change}]:c==='jsa_job_acknowledgments'?[ack]:[]}),auth,body);expect(out.acknowledgement).not.toBeNull();expect(out.fullRead).toBeNull();}
});
test('an explicit full-read reference never falls back to another read',async()=>{
 const out=await readSavedJobJsa(deps({list:async c=>c==='jsa_governed_requests'?[read]:c==='jsa_job_acknowledgments'?[{...ack,fullReadId:'B'.repeat(43)}]:[]}),auth,body);expect(out.fullRead).toBeNull();
});
test('off-shift policy-day acknowledgement remains viewable',async()=>{
 const out=await readSavedJobJsa(deps({list:async c=>c==='jsa_governed_requests'?[{...read,binding:{shiftState:'independent',policyDay:'2026-10-18'}}]:c==='jsa_job_acknowledgments'?[{...ack,periodId:null,policyDay:'2026-10-18',fullReadId:id}]:[]}),auth,body);expect(out.fullRead?.requestId).toBe(id);
});
test('direct read and once-per-scope coverage resolve exact saved records',async()=>{
 const direct=await readSavedJobJsa(deps({list:async c=>c==='jsa_governed_requests'?[{...read,jobRef:'job'}]:[],artifact:async()=>({...read,jobRef:'job',snapshot})}),auth,body);expect(direct.fullRead?.jobRef).toBe('job');
 const covered=await readSavedJobJsa(deps({list:async c=>c==='jsa_governed_requests'?[read]:c==='jsa_job_read_coverage'?[{...scope,jobRef:'job',method:'scope_read',fullReadId:id,recordedAtMs:200}]:[]}),auth,body);expect(covered.fullRead?.requestId).toBe(id);
});
test('missing or foreign artifacts never expose signed data',async()=>{
 for(const artifact of [null,{...read,companyId:'foreign',snapshot},{...read,jobRef:'wrong',snapshot},{...read,snapshot:{...snapshot,signature:null}}]){
 const out=await readSavedJobJsa(deps({artifact:async()=>artifact}),auth,body);expect(out.fullRead).toBeNull();}
});
test('unscoped acknowledgements and foreign adapter rows fail closed',async()=>{
 const out=await readSavedJobJsa(deps({list:async c=>c==='jsa_governed_requests'?[{...read,binding:{}}]:c==='jsa_job_acknowledgments'?[{...ack,periodId:null}]:[]}),auth,body);expect(out.fullRead).toBeNull();
 await expect(readSavedJobJsa(deps({list:async()=>[{...read,driverId:'foreign'}]}),auth,body)).rejects.toThrow('scope_or_size');
});

test('explicit references use one exact request lookup and job-scoped lists',async()=>{
 const list=jest.fn(async(c:string,_company:string,_driver:string,jobRef?:string)=>{
  expect(jobRef).toBe('job');return c==='jsa_job_acknowledgments'?[{...ack,fullReadId:id}]:[];
 });
 const request=jest.fn(async()=>read);
 const out=await readSavedJobJsa(deps({list,request}),auth,body);
 expect(out.fullRead?.requestId).toBe(id);expect(request).toHaveBeenCalledWith(id);
 expect(list).toHaveBeenCalledTimes(2);
 await expect(readSavedJobJsa(deps({list,request:async()=>({...read,driverId:'other'})}),auth,body)).rejects.toThrow('scope_or_size');
});

test('current locations include recorded stops linked to the same read, never unrelated reads',async()=>{
 const linked={...ack,fullReadId:id,job:{wellName:'Second well',jobType:'Service Work',dropOff:'Disposal'}};
 const out=await readSavedJobJsa(deps({linkedStops:async()=>[linked,{...linked,fullReadId:'other',job:{wellName:'Wrong read'}},{...linked,recordedAtMs:50,job:{wellName:'Before read'}}]}),auth,body);
 expect(out.coveredJobs?.map(x=>x.wellName)).toEqual(['Original well','Second well']);
 expect(out.coveredJobs?.[1]).toMatchObject({jobType:'Service Work',dropOff:'Disposal'});
 await expect(readSavedJobJsa(deps({linkedStops:async()=>[{...linked,companyId:'foreign'}]}),auth,body)).rejects.toThrow('scope_or_size');
});

test('saved acknowledged job displays its signed document number without rewriting its receipt',async()=>{
 const numberedRead={...read,jsaNumber:'JSA-20261018-180000-000042'};
 const oldAck={...ack,fullReadId:id,jsaNumber:'JSA-20261018-190000-100001'};
 const before=JSON.stringify(oldAck);
 const out=await readSavedJobJsa(deps({request:async()=>numberedRead,list:async c=>c==='jsa_job_acknowledgments'?[oldAck]:[],artifact:async()=>({...numberedRead,snapshot})}),auth,body);
 expect(out.jsaNumber).toBe(numberedRead.jsaNumber);expect(out.fullRead?.requestId).toBe(id);
 expect(out.acknowledgement).toMatchObject({method:'acknowledged'});expect(JSON.stringify(oldAck)).toBe(before);
});
