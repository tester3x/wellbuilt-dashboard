import {readFileSync} from 'fs';
import {join} from 'path';
import {runInNewContext} from 'vm';
import {transpileModule,ScriptTarget} from 'typescript';
import {calculateInventoryProduction} from '../inventoryProduction';
const source=readFileSync(join(__dirname,'../index.ts'),'utf8');
const start=source.indexOf('async function calculateAFR('),end=source.indexOf('\n}',start)+2;
const js=transpileModule(source.slice(start,end)+'\ncalculateAFR;', {compilerOptions:{target:ScriptTarget.ES2020}}).outputText;
const at=Date.parse('2026-10-20T12:00:00Z');
const p=(hour:number,id:string)=>({packetId:id,requestType:'pull',dateTimeUTC:new Date(at+hour*3600000).toISOString(),tankLevelFeet:7,bblsTaken:185,tankAfterInches:72});
function fixture(mode?:string){
 const records:any={a:p(0,'a'),b:p(3,'b')},config:any={productionRateMode:mode,bblPerFoot:120};
 const legacy=jest.fn(()=>0.1);
 const snap={val:()=>records,forEach:(fn:any)=>Object.entries(records).forEach(([key,value])=>fn({key,val:()=>value}))};
 const chain:any={orderByChild:()=>chain,equalTo:()=>chain,once:async()=>snap};
 const calculate=runInNewContext(js,{db:{ref:(key:string)=>key.startsWith('well_config/')?{once:async()=>({val:()=>config})}:chain},
  calculateInventoryProduction,resolveTankBblPerFoot:()=>120,effectiveFlow:()=>null,isProvisionalPull:()=>false,averageFlowRates:legacy,Date});
 return {calculate,records,legacy};
}
test('actual AFR entry point includes the current pull before it is persisted',async()=>{
 const f=fixture('inventory_balance');
 expect(await f.calculate('Example',0.9,p(6,'c'))).toBeCloseTo(120/1480);
 expect(f.records.c).toBeUndefined();expect(f.legacy).not.toHaveBeenCalled();
});
test('delete/rebuild entry point reads canonical historical and edited observations',async()=>{
 const f=fixture('inventory_balance');f.records.c={...p(6,'c'),wasEdited:true};f.records.b.historicalOnly=true;
 expect(await f.calculate('Example',0)).toBeCloseTo(120/1480);
 delete f.records.b;expect(await f.calculate('Example',0)).toBeCloseTo(120/740);
});
test('unconfigured wells retain the legacy AFR route',async()=>{
 const f=fixture();expect(await f.calculate('Example',0.07)).toBe(0.07);
 expect(f.legacy).not.toHaveBeenCalled();
});
