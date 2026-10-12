import {newShopOrder,updateShopOrder,shopCanRead,shopPhotos,type ShopActor} from '../shopModel';
const driver:ShopActor={uid:'uid-a',driverId:'driver-a',companyId:'company-a',displayName:'Test Driver',staff:false};
const mechanic:ShopActor={...driver,uid:'staff-a',staff:true,displayName:'Test Mechanic'};
const raw={id:'report_123',equipmentType:'trailer',equipmentNumber:'T30',title:'Air leak',description:'Air leak at fitting',outOfService:true,photos:[]};
const at='2026-10-12T20:00:00Z';
test('new report binds ownership and ignores caller role/identity claims',()=>{
 const o=newShopOrder({...raw,companyId:'other',driverId:'other',staff:true},driver,at);
 expect(o.companyId).toBe('company-a');expect(o.driverId).toBe('driver-a');expect(o.status).toBe('reported');expect(o.outOfService).toBe(true);
});
test('other drivers and other companies cannot read a report',()=>{
 const o=newShopOrder(raw,driver,at);
 expect(shopCanRead(o,driver)).toBe(true);expect(shopCanRead(o,{...driver,driverId:'other'})).toBe(false);
 expect(shopCanRead(o,mechanic)).toBe(true);expect(shopCanRead(o,{...mechanic,companyId:'other'})).toBe(false);
});
test('drivers cannot repair or sign off',()=>{expect(()=>updateShopOrder(newShopOrder(raw,driver,at),{revision:1,action:'work'},driver,at)).toThrow('Shop access');});
test('repair holds equipment until separate signoff, immutable after approval',()=>{
 let o=newShopOrder(raw,driver,at);
 o=updateShopOrder(o,{revision:1,action:'work',assignedTo:'Alex',repairNotes:'Checking fitting'},mechanic,at);
 expect(o.outOfService).toBe(true);
 o=updateShopOrder(o,{revision:2,action:'ready',repairNotes:'Fitting replaced, pressure checked'},mechanic,at);
 expect(o.outOfService).toBe(true);expect(o.signedOffAt).toBeNull();
 o=updateShopOrder(o,{revision:3,action:'signoff'},mechanic,at);
 expect(o.status).toBe('closed');expect(o.outOfService).toBe(false);expect(o.signedOffBy).toBe('Test Mechanic');expect(o.revision).toBe(4);
 expect(()=>updateShopOrder(o,{revision:4,action:'work'},mechanic,at)).toThrow('read-only');
});
test('stale revisions and cross-company updates fail',()=>{
 const o=newShopOrder(raw,driver,at);
 expect(()=>updateShopOrder(o,{revision:0,action:'work'},mechanic,at)).toThrow('changed');
 expect(()=>updateShopOrder(o,{revision:1,action:'work'},{...mechanic,companyId:'other'},at)).toThrow('Shop access');
});
test('signoff cannot skip work and review',()=>{
 const o=newShopOrder(raw,driver,at);
 expect(()=>updateShopOrder(o,{revision:1,action:'signoff'},mechanic,at)).toThrow('ready');
 expect(()=>updateShopOrder(o,{revision:1,action:'ready'},mechanic,at)).toThrow('Start work');
 const working=updateShopOrder(o,{revision:1,action:'work'},mechanic,at);
 expect(()=>updateShopOrder(working,{revision:2,action:'ready'},mechanic,at)).toThrow('repair notes');
});
test('ready repair can be returned for more work without lifting hold',()=>{
 let o=newShopOrder(raw,driver,at);
 o=updateShopOrder(o,{revision:1,action:'work'},mechanic,at);
 o=updateShopOrder(o,{revision:2,action:'ready',repairNotes:'Repaired'},mechanic,at);
 expect(updateShopOrder(o,{revision:3,action:'reopen'},mechanic,at)).toMatchObject({status:'working',outOfService:true});
});
test('photo payloads and scheduled dates are bounded and validated',()=>{
 expect(()=>shopPhotos(['file:///secret'])).toThrow();expect(()=>shopPhotos(Array(4).fill('/9j/AAAA'))).toThrow();
 expect(()=>newShopOrder({...raw,scheduledDate:'2026-02-30'},driver,at)).toThrow();
 expect(newShopOrder({...raw,scheduledDate:'2026-10-15'},driver,at).scheduledDate).toBe('2026-10-15');
});
