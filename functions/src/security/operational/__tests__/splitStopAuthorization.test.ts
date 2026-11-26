import {authorizeSplitDeliveryStop} from '../splitStopAuthorization';
import type {DispatchBinding} from '../dispatchPacketPin';
import type {ImmutableRevisionEnvelope} from '../jobPacketRevisionStore';
const binding: DispatchBinding = {packageId:'water',packetRevision:4,contentHash:'a',policyHash:'b'};
function fixture() {
  const caller={companyId:'company',driverId:'driver'};
  const anchor={...binding,companyId:'company',driverId:'driver',builderOwnership:{kind:'driver',actorId:'driver'},
    wellName:'Test source',operator:'Billing operator',jobTypeId:'service-work',status:'pending',splitGroupId:'family',splitSequence:1,splitTotal:3};
  const record={wellName:'Approved SWD',disposal:'Approved SWD',operator:'Billing operator',splitGroupId:'family',splitSequence:2,splitTotal:3};
  const envelope={jobTypes:[{jobTypeId:'service-work',capabilities:['splitTicket']}],capabilities:[{capabilityId:'splitTicket'}]} as unknown as ImmutableRevisionEnvelope;
  const family=[{id:'a',data:anchor}];
  let destinations=0;
  const input={dispatchId:'b',record,caller,binding,jobTypeId:'service-work',envelope,
    getFamily:async()=>family,getBirth:async()=>({dispatchId:'a',...caller}),sourceAllowed:()=>true,
    destinationAllowed:async()=>{destinations++;return true;}};
  return {input,anchor,record,family,get destinations(){return destinations;}};
}
test('a later catalog-approved stop can retain the pickup billing operator and cannot become a pickup',async()=>{
  const f=fixture(); const before=JSON.stringify(f.input);
  expect(await authorizeSplitDeliveryStop(f.input)).toEqual({ok:true,wellName:'Approved SWD'});
  expect(f.destinations).toBe(1); expect(JSON.stringify(f.input)).toBe(before);
  for(const seq of [undefined,0,1,'2',2.5]) {
    const f=fixture();(f.record as any).splitSequence=seq;
    expect((await authorizeSplitDeliveryStop(f.input)).ok).toBe(false);expect(f.destinations).toBe(0);
  }
});
test.each(['companyId','driverId','operator','jobTypeId','packageId','packetRevision','contentHash','policyHash'])(
  'foreign or changed anchor %s cannot authorize a stop',async key=>{
    const f=fixture();(f.anchor as any)[key]='foreign';
    expect((await authorizeSplitDeliveryStop(f.input)).ok).toBe(false);expect(f.destinations).toBe(0);
  });
test('missing, cancelled, staff-built or unconfirmed anchors fail before destination access',async()=>{
  for(const change of [(f:any)=>f.family.splice(0), (f:any)=>f.anchor.status='cancelled',
    (f:any)=>f.anchor.builderOwnership={kind:'staff',actorId:'driver'},(f:any)=>f.input.getBirth=async()=>null,
    (f:any)=>f.input.getBirth=async()=>({dispatchId:'a',companyId:'other',driverId:'driver'}),
    (f:any)=>f.input.sourceAllowed=()=>false]) {
    const f=fixture();change(f);expect((await authorizeSplitDeliveryStop(f.input)).ok).toBe(false);expect(f.destinations).toBe(0);
  }
});
test('unpublished split capability, duplicate sequence or invented destination is refused',async()=>{
  for(const change of [(f:any)=>f.input.envelope.jobTypes[0].capabilities=[],
    (f:any)=>f.input.envelope.capabilities=[],(f:any)=>f.record.disposal='Different stop',
    (f:any)=>f.family.push({id:'other-b',data:{...f.anchor,splitSequence:2}}),
    (f:any)=>f.family.push({id:'duplicate-a',data:{...f.anchor}}),
    (f:any)=>f.input.destinationAllowed=async()=>false]) {
    const f=fixture();change(f);expect((await authorizeSplitDeliveryStop(f.input)).ok).toBe(false);
  }
});
test('cancelled source cannot resurrect a held leg; completed pickup may finish its declared deliveries',async()=>{
  const f=fixture();f.anchor.status='completed';expect((await authorizeSplitDeliveryStop(f.input)).ok).toBe(true);
  f.anchor.status='cancelled';expect((await authorizeSplitDeliveryStop(f.input)).ok).toBe(false);
});

test('cancelled stop history does not occupy a resequenced live slot or increase live total',async()=>{
  const f=fixture();
  f.family.push({id:'old-b',data:{...f.anchor,splitSequence:2,status:'cancelled'}},
    {id:'old-c',data:{...f.anchor,splitSequence:4,status:'dismissed'}},
    {id:'old-d',data:{...f.anchor,splitSequence:3,status:'declined'}});
  expect((await authorizeSplitDeliveryStop(f.input)).ok).toBe(true);
  f.family[1].data.companyId='foreign';
  expect(await authorizeSplitDeliveryStop(f.input)).toMatchObject({ok:false,reason:'split_family_owner_mismatch'});
});
