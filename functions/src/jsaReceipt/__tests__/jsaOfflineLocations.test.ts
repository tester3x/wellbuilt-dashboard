import {offlineLocationProjection} from '../jsaOfflineLocations';
import {offlineHash,type OfflineGrant,type OfflineEvent} from '../jsaOfflineCore';
const owner={driverId:'driver',companyId:'company'};
const event={id:'event',jobRef:'job',grantId:'grant',occurredAtMs:1000,kind:'acknowledged'} as OfflineEvent;
const grant={...owner,shiftId:'original-shift',mode:'per_job'} as OfflineGrant;
const receipt={...owner,eventId:event.id,eventHash:offlineHash(event)};
const job={...owner,wellName:'Pickup',hauledTo:'Drop-off',commodityType:'Service Work'};
test('only a server-confirmed immutable event projects actual owned job locations into the original shift',()=>{
 const p=offlineLocationProjection(owner,event,grant,receipt,job,null);
 expect(p.shiftId).toBe('original-shift');expect(p.wells.map(w=>w.name)).toEqual(['Pickup','Drop-off']);
 expect(p).not.toHaveProperty('jsaCompleted');expect(p).not.toHaveProperty('acknowledged');
 const again=offlineLocationProjection(owner,event,grant,receipt,job,{...p,jsaCompleted:true});
 expect(again.wells).toEqual(p.wells);expect(again).not.toHaveProperty('jsaCompleted');
});
test('existing names, metadata and completion survive case-insensitive cross-bucket dedup',()=>{
 const existing={...owner,jsaCompleted:true,wells:[{name:'PICKUP',acknowledged:true}],locations:[{name:'pickup'},{name:'Other'}]};
 const p=offlineLocationProjection(owner,event,grant,receipt,job,existing);
 expect(p.wells.map(w=>w.name)).toEqual(['PICKUP','Other','Drop-off']);expect(p.wells[0].acknowledged).toBe(true);
});
test.each(['company','driver','event','job','existing'])('foreign or unconfirmed %s cannot be projected',kind=>{
 const c=kind==='company'?{...grant,companyId:'other'}:kind==='driver'?{...grant,driverId:'other'}:grant;
 expect(()=>offlineLocationProjection(owner,event,c,kind==='event'?{...receipt,eventHash:'wrong'}:receipt,
  kind==='job'?{...job,driverId:'other'}:job,kind==='existing'?{...owner,companyId:'other'}:null)).toThrow();
});
