import {decideBarrels,reportedTrackingBottom,isProvisionalPull} from '../barrelDecision';
const base={written:null,fallback:185,top:12,bottom:10,bank:60,rateMinutesPerFoot:120,isDown:false,rateMeasuredAt:'2026-10-07T10:00:00Z',measuredAt:'2026-10-07T12:00:00Z',maxLoadBbls:185};
test('math detects a partial load instead of always assigning driver capacity',()=>{expect(decideBarrels(base)).toMatchObject({bbls:130,provisional:true,needsReview:true,source:'estimated'});});
test('written barrels override model; smaller well and driver limits bound estimates',()=>{
 expect(decideBarrels({...base,written:140})).toMatchObject({bbls:140,provisional:false});
 expect(decideBarrels({...base,wellLimit:120})).toMatchObject({bbls:120,needsReview:true});
 expect(decideBarrels({...base,driverCapacity:125})).toMatchObject({bbls:125});
});
test('missing AFR retains observed-drop estimate for later review; invalid bottom cannot be trusted',()=>{
 expect(decideBarrels({...base,rateMinutesPerFoot:0})).toMatchObject({bbls:120,needsReview:true});
 expect(decideBarrels({...base,bottom:null})).toBeNull();
 expect(decideBarrels({...base,bottom:13})).toBeNull();
});
test('only scoped provisional watchdog pulls can use reported bottom for tracking',()=>{
 const p={source:'whatsapp_watchdog',watchdogProvenance:{principalId:'laptop-watchdog-v2',reportedBottomFeet:10,barrels:{status:'provisional'}}};
 expect(reportedTrackingBottom(p,144)).toBe(120);expect(isProvisionalPull(p)).toBe(true);
 expect(reportedTrackingBottom({...p,source:'wb_t'},144)).toBeNull();
 expect(reportedTrackingBottom(p,100)).toBeNull();
});
