import {createHash} from 'crypto';
import {acceptedGaugeRead,agreeGaugeReads,fallbackEligibility,runPhotoFallback,photoAiCacheKey,fallbackAuditChanged,photoFallbackSourceChanged,type FallbackDeps} from '../photoFallbackCore';
const image=Buffer.from('synthetic image fixture');
const item={photoReady:true,channel:'group',messageId:'message',postedAt:'2026-11-20T14:21:57.000Z',caption:'[11/20/2026, 08:21:57] Driver: ',mimeType:'image/jpeg',bytes:image.length,imageDigest:createHash('sha256').update(image).digest('hex'),rows:[{wellName:'Dwyer',bottomLevelFeet:null,photo:{tagVerified:true,observedBottom:null,autoSend:false,canSend:true}}]};
const policy={enabled:true,allowDelivery:true,enabledAfterMs:Date.parse('2026-11-20T00:00:00Z')};
const read={readable:true,tankLabel:'WTR 3',instrumentTag:'LT-5103',displayText:'5.9',units:'ft',printedPadIdentifier:null};
const empty={recordedCount:0,receipts:[],status:'no_message_receipt'};
function fixture(extra:Partial<FallbackDeps>={}){
 const saved:any[]=[];let reads=0,sends=0;
 const deps:FallbackDeps={receipts:async()=>empty,claim:async()=>'claimed',image:async()=>image,read:async()=>{reads++;return read;},save:async r=>{saved.push(r);},deliver:async bottom=>{sends++;return {packetId:'one',bottom};},...extra};
 return {deps,saved,counts:()=>({reads,sends})};
}
test('only locally unreadable, verified Dwyer photos are eligible',()=>{
 expect(fallbackEligibility(item,policy)).toBeNull();
 expect(fallbackEligibility({...item,sourceEdited:true},policy)).toBe('edited_source');
 expect(fallbackEligibility({...item,rows:[{...item.rows[0],issues:['Possible duplicate Dwyer report in this group']}]},policy)).toBe('other_review_required');
 expect(fallbackEligibility(item,{...policy,enabled:false})).toBe('not_armed');
 expect(fallbackEligibility(item,{...policy,enabledAfterMs:Date.parse(item.postedAt)+1})).toBe('not_armed');
 expect(fallbackEligibility({...item,rows:[{...item.rows[0],bottomLevelFeet:5.9}]},policy)).toBe('local_read_available');
 expect(fallbackEligibility({...item,rows:[{...item.rows[0],wellName:'Good Shepherd 21-15H'}]},policy)).toBe('not_verified_dwyer');
 expect(fallbackEligibility({...item,caption:'[11/20/2026, 08:21:57] Driver: 41-15'},policy)).toBe('other_pad');
 expect(fallbackEligibility({...item,caption:'[11/20/2026, 08:20:57] Driver: '},policy)).toBe('missing_original_chat');
});
test.each([{readable:false},{tankLabel:'WTR 2'},{instrumentTag:'LT-5104'},{displayText:'59'},{displayText:'5.95'},{displayText:'41.0'},{units:'in'},{printedPadIdentifier:'21-15H'}])('rejects wrong/ambiguous extraction %j',change=>{
 expect(acceptedGaugeRead({...read,...change})).toBeNull();
});
test('two independent reads must agree exactly; neighboring tank levels are not a fallback',()=>{
 expect(agreeGaugeReads(read,read)).toBe(5.9);
 expect(agreeGaugeReads(read,{...read,displayText:'4.4'})).toBeNull();
 expect(photoAiCacheKey(item.imageDigest)).toBe(photoAiCacheKey(item.imageDigest));
});
test('handled historical photo performs no claim, model call or send',async()=>{
 const f=fixture({receipts:async()=>({recordedCount:1,receipts:[{packetId:'original'}],status:'recorded_once'}),claim:async()=>{throw Error('must not claim');}});
 expect((await runPhotoFallback(item,policy,f.deps)).state).toBe('already_recorded');expect(f.counts()).toEqual({reads:0,sends:0});
});
test.each(['finished','busy','budget'] as const)('cache/claim %s never invokes the model again',async state=>{
 const f=fixture({claim:async()=>state});expect((await runPhotoFallback(item,policy,f.deps)).state).toBe(state);expect(f.counts()).toEqual({reads:0,sends:0});
});
test('accepted extraction is durably saved before one intake request',async()=>{
 const f=fixture();const result=await runPhotoFallback(item,policy,f.deps);
 expect(result.state).toBe('delivery_submitted');expect(f.counts()).toEqual({reads:2,sends:1});expect(f.saved[0]).toMatchObject({state:'read_complete',bottomFeet:5.9});
});
test('a receipt arriving during inference prevents delivery',async()=>{
 let checks=0;const f=fixture({receipts:async()=>++checks===1?empty:{recordedCount:1,receipts:[{packetId:'other-worker'}],status:'recorded_once'}});
 expect((await runPhotoFallback(item,policy,f.deps)).state).toBe('already_recorded');expect(f.counts()).toEqual({reads:2,sends:0});
});
test('disagreement, altered photo bytes, and model failure stay in review',async()=>{
 const disagree=fixture({read:async(_bytes,pass)=>({...read,displayText:pass?'5.8':'5.9'})});
 expect((await runPhotoFallback(item,policy,disagree.deps)).state).toBe('review');expect(disagree.counts().sends).toBe(0);
 const changed=fixture({image:async()=>Buffer.from('changed')});expect((await runPhotoFallback(item,policy,changed.deps)).state).toBe('review');expect(changed.counts()).toEqual({reads:0,sends:0});
 const failed=fixture({read:async()=>{throw Error('model unavailable');}});expect((await runPhotoFallback(item,policy,failed.deps)).state).toBe('review');expect(failed.counts().sends).toBe(0);
});
test('review-only activation cannot submit a load even after two matching reads',async()=>{
 const f=fixture();expect((await runPhotoFallback(item,{...policy,allowDelivery:false},f.deps)).state).toBe('review');expect(f.counts()).toEqual({reads:2,sends:0});
});
test('audit writes do not recursively retrigger themselves for the same result',()=>{
 const result={state:'already_recorded'};
 expect(fallbackAuditChanged({...result,model:'model',checkedAt:1},result)).toBe(false);
 expect(fallbackAuditChanged({state:'running'},result)).toBe(true);
});

const unidentified={...item,rows:[{...item.rows[0],wellName:'Well needs review',issues:[
 'Compare the photo with any separate text report for this haul',
 'Confirm the well. The caption and gauge tags did not identify Dwyer',
 'WTR 3 (LT-5103) bottom level needs verification',
 'Resolve conflicting haul evidence or confirm the Dwyer report',
],photo:{...item.rows[0].photo,tagVerified:false}}]};
const defaultPolicy={...policy,unidentifiedDwyerChannels:['group']};
test('explicit channel default admits unidentified local photo only to cloud verification',async()=>{
 expect(fallbackEligibility(unidentified,policy)).toBe('not_verified_dwyer');
 expect(fallbackEligibility({...unidentified,channel:'other'},defaultPolicy)).toBe('not_verified_dwyer');
 expect(fallbackEligibility(unidentified,defaultPolicy)).toBeNull();
 const f=fixture();expect((await runPhotoFallback(unidentified,defaultPolicy,f.deps)).state).toBe('delivery_submitted');expect(f.counts()).toEqual({reads:2,sends:1});
 const wrong=fixture({read:async()=>({...read,printedPadIdentifier:'Good Shepherd 21-15H'})});
 expect((await runPhotoFallback(unidentified,defaultPolicy,wrong.deps)).state).toBe('review');expect(wrong.counts().sends).toBe(0);
});
test('channel default never overrides other pads, conflicting barrels, duplicate holds or local values',()=>{
 expect(fallbackEligibility({...unidentified,rows:[{...unidentified.rows[0],wellName:'Good Shepherd 21-15H'}]},defaultPolicy)).toBe('not_verified_dwyer');
 expect(fallbackEligibility({...unidentified,rows:[{...unidentified.rows[0],photo:{...unidentified.rows[0].photo,reviewOnly:true}}]},defaultPolicy)).toBe('not_verified_dwyer');
 for(const text of ['21-15H','Good Shepherd','41-15'])expect(fallbackEligibility({...unidentified,caption:item.caption+text},defaultPolicy)).toBe('other_pad');
 for(const text of ['hauled 165 bbl','185','pulled 140 bbl\nhauled 140 bbl'])expect(fallbackEligibility({...unidentified,caption:item.caption+text},defaultPolicy)).toBe('other_review_required');
 expect(fallbackEligibility({...unidentified,rows:[{...unidentified.rows[0],issues:['Possible duplicate Dwyer report in this group']}]},defaultPolicy)).toBe('other_review_required');
 expect(fallbackEligibility({...unidentified,rows:[{...unidentified.rows[0],bottomLevelFeet:8.6}]},defaultPolicy)).toBe('local_read_available');
});
test('unidentified photo with an existing receipt performs no model call or send',async()=>{
 const f=fixture({receipts:async()=>({recordedCount:1,receipts:[{packetId:'original'}],status:'recorded_once'})});
 expect((await runPhotoFallback(unidentified,defaultPolicy,f.deps)).state).toBe('already_recorded');expect(f.counts()).toEqual({reads:0,sends:0});
});

test('merged stale audit values cannot retrigger model/receipt work',()=>{
 const prior={...item,cloudFallback:{state:'delivery_submitted',bottomFeet:7.6,delivery:{packetId:'original'},checkedAt:1}};
 const result={state:'already_recorded'};
 // Reproduce Firestore set(...,{merge:true}) retaining the omitted fields.
 const merged={...prior,cloudFallback:{...prior.cloudFallback,...result,checkedAt:2}};
 expect(fallbackAuditChanged(merged.cloudFallback,result)).toBe(true);
 expect(photoFallbackSourceChanged(prior,merged)).toBe(false);
 const replaced={...prior,cloudFallback:{...result,checkedAt:2}};
 expect(fallbackAuditChanged(replaced.cloudFallback,result)).toBe(false);
 expect(photoFallbackSourceChanged(prior,replaced)).toBe(false);
});
test('unchanged mirror heartbeats stop before cloud reads, but real source changes proceed',()=>{
 expect(photoFallbackSourceChanged(item,{...item,updatedAt:999,cloudFallback:{state:'review'}})).toBe(false);
 expect(photoFallbackSourceChanged(undefined,item)).toBe(true);
 for(const patch of [{photoReady:false},{sourceEdited:true},{caption:'edited'},{imageDigest:'b'.repeat(64)},
  {rows:[{...item.rows[0],bottomLevelFeet:8.6}]}])expect(photoFallbackSourceChanged(item,{...item,...patch})).toBe(true);
 expect(photoFallbackSourceChanged(item,JSON.parse(JSON.stringify(item)))).toBe(false);
});
