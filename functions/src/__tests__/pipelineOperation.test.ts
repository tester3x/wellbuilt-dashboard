import {runningPipeline,refreshPipelineProjection} from '../pipelineOperation';
import {calculateInventoryProduction} from '../inventoryProduction';
import {calculateFlowWindows} from '../flowWindows';
const config={tankHeight:20,bblPerFoot:51,isDown:false,pipelineOperation:{mode:'running',holdingLevelFeet:10,productionMinutesPerFoot:101.13,levelBasis:'assumed'}};
test('pipeline holds half-height with gross production retained; off, down and malformed configurations do not grant a hold',()=>{
 expect(runningPipeline(config)).toEqual({levelFeet:10,minutesPerFoot:101.13,assumed:true,bblsDay:726});
 for(const c of [{...config,isDown:true},{...config,routeType:'freshwater'},{...config,pipelineOperation:{...config.pipelineOperation,mode:'off'}},{...config,pipelineOperation:{...config.pipelineOperation,holdingLevelFeet:21}},{...config,pipelineOperation:{...config.pipelineOperation,productionMinutesPerFoot:0}}])expect(runningPipeline(c)).toBeNull();
});
test('actual projection preserves raw last pull, owner, rate configuration and history; explicit DOWN wins',async()=>{
 const last={packetId:'last',bottomLevelInches:110,bblsTaken:140,dateTimeUTC:'2026-10-27T21:00:00Z'};
 const rows:any={'packets/outgoing':{response:{wellName:'Example'}},'packets/outgoing/response':{wellName:'Example',lastPullPacketId:'last',lastPullBottomLevel:"9'2\"",wellDown:false,companyId:'c'},'wells/Example/status':{isDown:false,lastPull:last,calculated:{flowRate:'old'}}};
 const db={ref:(path:string)=>({orderByChild:()=>({equalTo:()=>({once:async()=>({val:()=>rows[path]})})}),transaction:async(fn:any)=>{const next=fn(rows[path]);if(next!==undefined)rows[path]=next;}})};
 expect(await refreshPipelineProjection(db,'Example',config)).toBe(true);
 expect(rows['packets/outgoing/response']).toMatchObject({wellDown:false,currentLevel:"10'0\"",lastPullBottomLevel:"9'2\"",netInventoryBblsDay:0,productionBblsDay:726,companyId:'c',pipelineLevelAssumed:true});
 expect(rows['wells/Example/status'].lastPull).toBe(last);
 expect(Object.keys(rows)).toHaveLength(3);expect(config.pipelineOperation.productionMinutesPerFoot).toBe(101.13);
 rows['wells/Example/status'].isDown=true;rows['packets/outgoing/response'].wellDown=true;
 await refreshPipelineProjection(db,'Example',config);expect(rows['wells/Example/status'].isDown).toBe(true);expect(rows['packets/outgoing/response'].wellDown).toBe(true);
});
test('pipeline readings break production estimators; they cannot imply reduced inflow',()=>{
 const at=Date.parse('2026-10-01T00:00:00Z');const row=(hours:number,pipelineRunning=false)=>({requestType:'pull',dateTimeUTC:new Date(at+hours*3600000).toISOString(),tankLevelFeet:10,tankTopInches:120,tankAfterInches:90,bblsTaken:140,pipelineRunning});
 const h={a:row(0),b:row(4,true),c:row(8)};
 expect(calculateInventoryProduction(h,51,at+8*3600000)).toBeNull();
 expect(calculateFlowWindows(h,6).map(r=>r.action)).toEqual(['anchor','break','anchor']);
});
