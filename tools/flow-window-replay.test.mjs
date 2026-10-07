import test from 'node:test';
import assert from 'node:assert/strict';
import { replayFlow } from './flow-window-replay.mjs';
const row=(id,h,top,bottom,barrels=170)=>({id,time:new Date(Date.UTC(2026,0,1)+h*3600000).toISOString(),topInches:top,bottomInches:bottom,barrels});
test('each load counted, reported bottom preserved, tiny intervals held, cumulative recovery used',()=>{
 const r=replayFlow([row('a',0,100,66),row('b',24,78,44),row('c',25,44,10),row('d',36,16,0,80)]);
 assert.equal(r.totalBarrels,590);assert.equal(r.observations[1].hoursPerFoot,24);
 assert.equal(r.observations[2].action,'hold');assert.equal(r.observations[2].hoursPerFoot,24);
 assert.equal(r.observations[3].recoveryInches,6);assert.equal(r.observations[3].hoursPerFoot,24);
 assert.equal(r.observations[2].bottomInches,10);
});
test('unreadable and down observations break the interval',()=>{
 const r=replayFlow([row('a',0,100,66),{id:'gap',time:row('x',2,1,0).time,barrier:true},row('b',24,78,44)]);
 assert.equal(r.observations[2].action,'anchor');
 const d=replayFlow([row('a',0,100,66),{...row('down',2,70,36),down:true},row('b',24,78,44)]);
 assert.equal(d.observations[2].action,'anchor');
});
test('rejects duplicate identity instead of double counting',()=>assert.throws(()=>replayFlow([row('a',0,100,66),row('a',1,66,32)]),/duplicate/));
test('negative recovery resets rather than inventing production',()=>assert.equal(replayFlow([row('a',0,100,66),row('b',24,50,16)]).observations[1].action,'reset'));
