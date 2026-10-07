import {refreshFlowWindow} from '../refreshFlowWindow';
function mock(initial:any){const values=new Map<string,any>(Object.entries(initial));const changes:any[]=[];
 const ref=(path=''):any=>({once:async()=>({val:()=>values.get(path)}),orderByChild:()=>({equalTo:()=>ref(path)}),update:async(p:any)=>{changes.push({path,p});if(path)values.set(path,{...values.get(path),...p});},transaction:async(fn:any)=>{const v=fn(values.get(path));if(v!==undefined)values.set(path,v);return {committed:v!==undefined};}});
 return {db:{ref},values,changes};}
const p=(id:string,h:number,t:number,b:number)=>({packetId:id,requestType:'pull',dateTimeUTC:new Date(Date.UTC(2026,0,1)+h*3600000).toISOString(),tankTopInches:t,tankAfterInches:b,bblsTaken:170});
test('refresh updates derived history and matching latest response without changing ownership or measurements',async()=>{
 const last=p('b',24,78,44);const m=mock({'well_config/Example':{flowWindowMinimumRecoveryInches:6,bblPerFoot:60,pullBbls:140,allowedBottom:1.25},'packets/processed':{a:p('a',0,100,66),b:last},'packets/outgoing':{response:{lastPullPacketId:'b'}},'packets/outgoing/response':{lastPullPacketId:'b',lastPullDateTimeUTC:last.dateTimeUTC,lastPullBottomLevel:'3\'8"',lastPullDriverId:'owner',wellDown:false},'wells/Example/status':{lastPull:{packetId:'b'},isDown:false,current:{levelInches:44},calculated:{}}});
 await refreshFlowWindow(m.db,'Example');expect(m.values.get('packets/outgoing/response').flowRate).toBe('24:00:00');expect(m.values.get('packets/outgoing/response').lastPullDriverId).toBe('owner');expect(m.values.get('wells/Example/status').current.levelInches).toBe(44);expect(m.values.get('wells/Example/status').calculated.bbls24hrs).toBe(60);
});
test('disabled well does not write; concurrent newer latest response is not overwritten',async()=>{
 const off=mock({'well_config/Example':{}});await refreshFlowWindow(off.db,'Example');expect(off.changes).toHaveLength(0);
 const last=p('b',24,78,44);const m=mock({'well_config/Example':{flowWindowMinimumRecoveryInches:6,bblPerFoot:60},'packets/processed':{a:p('a',0,100,66),b:last},'packets/outgoing':{response:{lastPullPacketId:'b'}},'packets/outgoing/response':{lastPullPacketId:'newer',flowRate:'keep'},'wells/Example/status':{lastPull:{packetId:'newer'},calculated:{flowRate:'keep'}}});await refreshFlowWindow(m.db,'Example');expect(m.values.get('packets/outgoing/response').flowRate).toBe('keep');expect(m.values.get('wells/Example/status').calculated.flowRate).toBe('keep');
});
