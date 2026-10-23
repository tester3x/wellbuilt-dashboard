import {test} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {planWaterOrder} from '../waterOrderPlanner.ts';
import {releasableWaterTrips, waterTripStatus} from '../waterOrderProgress.ts';

const now=Date.parse('2026-10-23T12:00:00Z');
const trucks=Array.from({length:42},(_,i)=>({key:`driver-${i}`,name:`Driver ${i}`,capacity:i%2?140:185,hoursPerDay:10}));
const sources=Array.from({length:50},(_,i)=>({wellName:`Source ${i}`,operator:'Test operator',available:1000,daily:1000,capacity:1000,cycleMinutes:60+i,asOf:new Date(now).toISOString(),reserved:0}));
const make=(count=35,tankCount=35)=>planWaterOrder({orderId:'crew-test',now,deadline:now+3*86400000,trucks:trucks.slice(0,count),sources,tanks:Array.from({length:tankCount},(_,i)=>({id:`tank-${i}`,name:`Tank ${i}`,capacity:400,buffer:30,current:0}))});

test('35-driver fleet: inventory, driver hours, mixed capacities, exact tanks and stable retry IDs',()=>{
 const plan=make(),again=make();
 assert.equal(plan.planned,12950);assert.equal(plan.shortfall,0);
 assert.equal(new Set(plan.trips.map(t=>t.driverKey)).size,35);
 assert.deepEqual(plan.trips,again.trips);
 assert.equal(plan.trips.reduce((n,t)=>n+t.bbl,0),plan.planned);
 for(const truck of trucks.slice(0,35)){
  const trips=plan.trips.filter(t=>t.driverKey===truck.key);
  for(let i=0;i<trips.length;i++){
   const t=trips[i];assert.ok(t.bbl<=truck.capacity);assert.equal(t.tanks.reduce((n,a)=>n+a.bbl,0),t.bbl);
   if(i)assert.ok(Date.parse(t.startAt)>=Date.parse(trips[i-1].deliveryAt));
   const day=Math.floor((Date.parse(t.startAt)-now)/86400000);assert.ok(Date.parse(t.deliveryAt)<=now+day*86400000+truck.hoursPerDay*3600000);
  }
 }
 for(let i=0;i<35;i++)assert.equal(plan.trips.flatMap(t=>t.tanks).filter(t=>t.id===`tank-${i}`).reduce((n,a)=>n+a.bbl,0),370);
});

test('42 drivers, 50 sources, 120 tanks stays within bounded planning and reports remaining work',()=>{
 const start=performance.now(),plan=make(42,120);
 assert.ok(performance.now()-start<5000,'Full-size plan should finish without a long UI stall');
 assert.ok(plan.trips.length<=300);assert.equal(plan.planned+plan.shortfall,44400);
 assert.equal(new Set(plan.trips.map(t=>t.id)).size,plan.trips.length);
 assert.ok(plan.trips.every(t=>Date.parse(t.deliveryAt)<=Date.parse(plan.deadline)));
});

test('ready count and release share same per-driver gate, including declined jobs and expiry',()=>{
 const plan=make(),at=now+4*3600000;
 const first=releasableWaterTrips(plan,[],at,{},{});
 assert.equal(first.length,35);assert.equal(new Set(first.map(t=>t.driverKey)).size,35);
 const sent=first.map(t=>t.id),linked=Object.fromEntries(first.map(t=>[t.id,'pending']));
 assert.equal(releasableWaterTrips(plan,sent,at,{},linked).length,0);
 const declined=first[0];linked[declined.id]='declined';
 const next=releasableWaterTrips(plan,sent,at,{},linked);assert.equal(next.length,1);assert.equal(next[0].driverKey,declined.driverKey);
 assert.equal(waterTripStatus(declined,plan,sent,at,{},linked,new Set()),'Cancelled');
 const blocked=plan.trips.find(t=>t.driverKey===first[1].driverKey&&!sent.includes(t.id))!;
 assert.equal(waterTripStatus(blocked,plan,sent,at,{},linked,new Set()),'Waiting');
 assert.equal(waterTripStatus(first[1],plan,sent,at,{[first[1].id]:0},linked,new Set()),'Delivered','A confirmed zero is still an acknowledged record');
 assert.equal(releasableWaterTrips(plan,[],Date.parse(plan.deadline)+1,{},{}).length,0);
});

test('300-load cap is explicit shortfall rather than silently promising excess work',()=>{
 const plan=planWaterOrder({orderId:'limit',now,deadline:now+31*86400000,trucks:trucks.map(t=>({...t,capacity:1,hoursPerDay:24})),sources,tanks:[{id:'a',name:'Test',capacity:1000,buffer:0,current:0}]});
 assert.equal(plan.trips.length,300);assert.equal(plan.planned,300);assert.equal(plan.shortfall,700);
});
