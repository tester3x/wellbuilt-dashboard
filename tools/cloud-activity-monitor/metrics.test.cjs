const {test}=require('node:test'),assert=require('node:assert/strict');
const {summarize,functions}=require('./metrics.cjs');
const now=1800000000000,at=now-120000;
const series=(name,count,time=at,code='200')=>({resource:{labels:{service_name:name}},metric:{labels:{response_code:code}},points:[{interval:{endTime:new Date(time).toISOString()},value:{int64Value:String(count)}}]});
test('aggregates revisions and response codes within the same completed minute',()=>{
 const r=functions([series('photo',1200),series('photo',75,at,'500'),series('other',3)]);
 assert.equal(r[0].count,1275);assert.equal(r[0].errors,75);assert.equal(r[1].count,3);
});
test('actual loop-sized traffic alarms and names the culprit',()=>{
 const s=summarize({run:[series('processwatchdogphotofallback',1275)]},now);
 assert.equal(s.status,'CRITICAL');assert.match(s.alerts[0],/processwatchdogphotofallback.*1,275/);
});
test('Gen 2 metric families are not counted twice, while Gen 1 stays visible',()=>{
 const old=series('unused',9);old.resource={labels:{function_name:'photoFallback'}};
 const v1=series('unused',3);v1.resource={labels:{function_name:'legacyOnly'}};
 const s=summarize({run:[series('photofallback',7)],legacy:[old,v1]},now);
 assert.deepEqual(s.functions.map(r=>[r.name,r.count]),[['photofallback',7],['legacyOnly',3]]);
});
test('missing/failed/stale data never displays NORMAL',()=>{
 assert.equal(summarize({},now).status,'NO_RECENT_DATA');
 assert.equal(summarize({run:[series('x',2)],errors:['denied']},now).status,'UNKNOWN');
 assert.equal(summarize({run:[series('x',2)],truncated:true},now).status,'UNKNOWN');
 assert.equal(summarize({run:[series('x',2,now-20*60000)]},now).status,'NO_RECENT_DATA');
});
test('Firestore burst is visible even with quiet functions; ordinary traffic stays green',()=>{
 assert.equal(summarize({run:[series('x',2)]},now).status,'NORMAL');
 const reads=series('database',12000);assert.equal(summarize({reads:[reads]},now).status,'CRITICAL');
});
