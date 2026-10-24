import {decideBarrels,reportedTrackingBottom,isProvisionalPull,fixedDriverDefault,fixedDriverDefaultConfirmed} from '../barrelDecision';
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

test('small rounding over a configured load ceiling stays provisional without mandatory review',()=>{expect(decideBarrels({...base,top:11.25,bottom:8.75,bank:67.2,rateMinutesPerFoot:0,driverCapacity:165})).toMatchObject({bbls:165,provisional:true,needsReview:false});expect(decideBarrels({...base,top:12,bottom:8,rateMinutesPerFoot:0,driverCapacity:165})).toMatchObject({needsReview:true});});

test('assumed inflow above a known full-load drop does not demand review',()=>{expect(decideBarrels({...base,top:11,bottom:8.5,bank:67.2,rateMinutesPerFoot:114,driverCapacity:165})).toMatchObject({bbls:165,provisional:true,needsReview:false});expect(decideBarrels({...base,top:11,bottom:8,bank:67.2,rateMinutesPerFoot:114,driverCapacity:165})).toMatchObject({needsReview:true});});


test('operator fixed driver default overrides estimates but never written barrels',()=>{
 expect(decideBarrels({...base,fixedDefaultBbls:185})).toMatchObject({bbls:185,source:'default',provisional:true,needsReview:false,issues:[]});
 expect(decideBarrels({...base,fixedDefaultBbls:185,written:140})).toMatchObject({bbls:140,source:'written',provisional:false});
 expect(decideBarrels({...base,fixedDefaultBbls:185,wellLimit:150})).toMatchObject({bbls:150,needsReview:true});
 expect(decideBarrels({...base,fixedDefaultBbls:185,bottom:null})).toBeNull();
});
test('capacity and an ordinary parser fallback do not enable fixed loads for other drivers',()=>{
 const channel={driverDefaultBbls:{Known:185,Other:165},driverCapacities:{Known:185},driverDefaultModes:{Known:'fixed_load'}};
 expect(fixedDriverDefault(channel,undefined,'Known')).toBe(185);
 expect(fixedDriverDefault(channel,undefined,'Other')).toBeNull();
 expect(fixedDriverDefault(channel,undefined,'Unknown')).toBeNull();
 expect(fixedDriverDefault({...channel,driverDefaultBbls:{Known:NaN}},undefined,'Known')).toBeNull();
 expect(decideBarrels({...base,driverCapacity:185})).toMatchObject({bbls:130,source:'estimated',needsReview:true});
});

test('only separately owner-confirmed fixed quantities train production; ceilings and written amounts still win',()=>{
 const channel={driverDefaultBbls:{Known:165,Legacy:165},driverDefaultModes:{Known:'confirmed_fixed_load',Legacy:'fixed_load'}};
 expect(fixedDriverDefault(channel,undefined,'Known')).toBe(165);
 expect(fixedDriverDefaultConfirmed(channel,undefined,'Known')).toBe(true);
 expect(fixedDriverDefaultConfirmed(channel,undefined,'Legacy')).toBe(false);
 expect(fixedDriverDefaultConfirmed(channel,'other','Unknown')).toBe(false);
 expect(decideBarrels({...base,fixedDefaultBbls:165,fixedDefaultConfirmed:true})).toMatchObject({bbls:165,provisional:false,needsReview:false});
 expect(decideBarrels({...base,fixedDefaultBbls:165,fixedDefaultConfirmed:true,wellLimit:140})).toMatchObject({bbls:140,provisional:true,needsReview:true});
 expect(decideBarrels({...base,fixedDefaultBbls:165,fixedDefaultConfirmed:true,written:100})).toMatchObject({bbls:100,source:'written',provisional:false});
 const packet={source:'whatsapp_watchdog',watchdogProvenance:{principalId:'laptop-watchdog-v2',reportedBottomFeet:10,barrels:{status:'confirmed',source:'owner_fixed_load'}}};
 expect(reportedTrackingBottom(packet,144)).toBe(120);expect(isProvisionalPull(packet)).toBe(false);
 expect(reportedTrackingBottom({...packet,source:'other'},144)).toBeNull();
 expect(isProvisionalPull({...packet,watchdogProvenance:{...packet.watchdogProvenance,timeEstimate:{status:'estimated'}}})).toBe(true);
});
