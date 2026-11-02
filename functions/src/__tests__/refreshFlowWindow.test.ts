import {refreshFlowWindow} from '../refreshFlowWindow';
function mock(initial:any){const values=new Map<string,any>(Object.entries(initial));const changes:any[]=[];const listening=new Set<string>();
 const ref=(path=''):any=>({on:()=>listening.add(path),off:()=>listening.delete(path),once:async()=>({val:()=>values.get(path)}),orderByChild:()=>({equalTo:()=>ref(path)}),update:async(p:any)=>{changes.push({path,p});if(path)values.set(path,{...values.get(path),...p});},transaction:async(fn:any)=>{const v=fn(listening.has(path)?values.get(path):null);if(v!==undefined)values.set(path,v);return {committed:v!==undefined};}});
 return {db:{ref},values,changes,listening};}
const p=(id:string,h:number,t:number,b:number)=>({packetId:id,requestType:'pull',dateTimeUTC:new Date(Date.UTC(2026,0,1)+h*3600000).toISOString(),tankTopInches:t,tankAfterInches:b,bblsTaken:170});
test('refresh updates derived history and matching latest response without changing ownership or measurements',async()=>{
 const last=p('b',24,78,44);const m=mock({'well_config/Example':{flowWindowMinimumRecoveryInches:6,bblPerFoot:60,pullBbls:140,allowedBottom:1.25},'packets/processed':{a:p('a',0,100,66),b:last},'packets/outgoing':{response:{lastPullPacketId:'b'}},'packets/outgoing/response':{lastPullPacketId:'b',lastPullDateTimeUTC:last.dateTimeUTC,lastPullBottomLevel:'3\'8"',lastPullDriverId:'owner',wellDown:false},'wells/Example/status':{lastPull:{packetId:'b'},isDown:false,current:{levelInches:44},calculated:{}}});
 await refreshFlowWindow(m.db,'Example');expect(m.values.get('packets/outgoing/response').flowRate).toBe('24:00:00');expect(m.values.get('packets/outgoing/response').lastPullDriverId).toBe('owner');expect(m.values.get('wells/Example/status').current.levelInches).toBe(44);expect(m.values.get('wells/Example/status').calculated.bbls24hrs).toBe(60);
});
test('disabled well does not write; concurrent newer latest response is not overwritten',async()=>{
 const off=mock({'well_config/Example':{}});await refreshFlowWindow(off.db,'Example');expect(off.changes).toHaveLength(0);
 const last=p('b',24,78,44);const m=mock({'well_config/Example':{flowWindowMinimumRecoveryInches:6,bblPerFoot:60},'packets/processed':{a:p('a',0,100,66),b:last},'packets/outgoing':{response:{lastPullPacketId:'b'}},'packets/outgoing/response':{lastPullPacketId:'newer',flowRate:'keep'},'wells/Example/status':{lastPull:{packetId:'newer'},calculated:{flowRate:'keep'}}});await refreshFlowWindow(m.db,'Example');expect(m.values.get('packets/outgoing/response').flowRate).toBe('keep');expect(m.values.get('wells/Example/status').calculated.flowRate).toBe('keep');
});

test('inventory mode refreshes edit/deletion projections without rewriting original history',async()=>{
 const records=Object.fromEntries([0,3,6].map((h,i)=>['p'+i,{...p('p'+i,h,84,72),tankLevelFeet:7,bblsTaken:185}]));
 const last=records.p2;
 const m=mock({'well_config/Example':{productionRateMode:'inventory_balance',bblPerFoot:120,tanks:6},
 'packets/processed':records,'packets/outgoing':{response:{lastPullPacketId:'p2'}},
 'packets/outgoing/response':{lastPullPacketId:'p2',lastPullDateTimeUTC:last.dateTimeUTC,lastPullBbls:'185',lastPullDriverId:'owner'},
 'wells/Example/status':{lastPull:{packetId:'p2'},current:{levelInches:72},calculated:{}}});
 const before=JSON.stringify(records);await refreshFlowWindow(m.db,'Example');
 expect(m.values.get('packets/outgoing/response').bbls24hrs).toBe('1480');
 expect(m.values.get('wells/Example/status').calculated.bbls24hrs).toBe(1480);
 expect(m.values.get('packets/outgoing/response').lastPullDriverId).toBe('owner');
 expect(m.values.get('wells/Example/status').current.levelInches).toBe(72);
 expect(JSON.stringify(records)).toBe(before);
 expect(m.listening.size).toBe(0);
 expect(m.changes.some(c=>!c.path||c.path.startsWith('packets/processed'))).toBe(false);
});

test.each([['overnight','720'],['afr',null]])('inventory refresh retains independent ON for %s mode',async(mode,expected)=>{
 // 6 PM previous Central day -> 6 AM first current-day reading: 3 ft recovery.
 const records=Object.fromEntries([0,12,18].map((h,i)=>['p'+i,{...p('p'+i,h+24,108,72),tankLevelFeet:9,bblsTaken:185}]));
 const last=records.p2;
 const m=mock({'well_config/Example':{productionRateMode:'inventory_balance',overnightProductionMode:mode,bblPerFoot:120},
 'packets/processed':records,'packets/outgoing':{response:{lastPullPacketId:'p2'}},
 'packets/outgoing/response':{lastPullPacketId:'p2',lastPullDateTimeUTC:last.dateTimeUTC,overnightBblsDay:'old'},
 'wells/Example/status':{lastPull:{packetId:'p2'},calculated:{}}});
 await refreshFlowWindow(m.db,'Example');
 expect(m.values.get('packets/outgoing/response').overnightBblsDay).toBe(expected);
});

describe('ON refresh applies independently to every AFR model',()=>{
 const records=()=>Object.fromEntries([
  ['previous',23,72,42],['first',44,144,114],['later',46,117,87],
 ].map(([id,h,top,bottom])=>[id,{...p(String(id),Number(h),Number(top),Number(bottom)),tankLevelFeet:Number(top)/12,bblsTaken:165}]));
 const fixture=(extra:any={},rows=records())=>{
  const last=rows.later;
  return mock({'well_config/Example':{bblPerFoot:60,...extra},'packets/processed':rows,
   'packets/outgoing':{response:{lastPullPacketId:'later'}},
   'packets/outgoing/response':{lastPullPacketId:'later',lastPullDateTimeUTC:last.dateTimeUTC,flowRate:'keep AFR',bbls24hrs:'keep',overnightBblsDay:null,owner:'keep'},
   'wells/Example/status':{lastPull:{packetId:'later'},current:{levelInches:87},calculated:{}}});
 };
 test.each([{}, {flowWindowMinimumRecoveryInches:6}, {productionRateMode:'inventory_balance'}])('first pull at 2 PM remains the endpoint after later pulls: %j',async cfg=>{
  const m=fixture(cfg);await refreshFlowWindow(m.db,'Example');
  expect(m.values.get('packets/outgoing/response')).toMatchObject({overnightBblsDay:'583',overnightEstimatedTime:false,owner:'keep'});
 });
 test('ordinary slow well recalculates corrected/deleted first pull without rewriting AFR or measurements',async()=>{
  const rows=records(),m=fixture({},rows);const status=JSON.stringify(m.values.get('wells/Example/status')),history=JSON.stringify(rows);
  await refreshFlowWindow(m.db,'Example');
  expect(m.values.get('packets/outgoing/response')).toMatchObject({overnightBblsDay:'583',flowRate:'keep AFR',bbls24hrs:'keep'});
  expect(JSON.stringify(rows)).toBe(history);expect(JSON.stringify(m.values.get('wells/Example/status'))).toBe(status);
  rows.first={...rows.first,tankLevelFeet:11,tankTopInches:132};await refreshFlowWindow(m.db,'Example');
  expect(m.values.get('packets/outgoing/response').overnightBblsDay).toBe('514');
  delete rows.first;await refreshFlowWindow(m.db,'Example');
  expect(m.values.get('packets/outgoing/response').overnightBblsDay).toBe('391');
 });
 test('late earlier observation replaces the first endpoint; it never selects a convenient later pull',async()=>{
  const rows=records();delete rows.first;const m=fixture({},rows);await refreshFlowWindow(m.db,'Example');
  expect(m.values.get('packets/outgoing/response').overnightBblsDay).toBe('391');
  rows.first=records().first;await refreshFlowWindow(m.db,'Example');
  expect(m.values.get('packets/outgoing/response').overnightBblsDay).toBe('583');
 });
 test('AFR-only mode withdraws stale ON on an ordinary well too',async()=>{
  const m=fixture({overnightProductionMode:'afr'});m.values.get('packets/outgoing/response').overnightBblsDay='old';
  await refreshFlowWindow(m.db,'Example');expect(m.values.get('packets/outgoing/response').overnightBblsDay).toBeNull();
 });
});
