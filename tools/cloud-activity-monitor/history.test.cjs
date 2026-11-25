const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {minuteRecords,summarizeHistory,HistoryStore}=require('./history.cjs');
const at=Date.parse('2026-11-25T04:00:00Z'),metric=(name,n,time=at)=>({resource:{labels:{service_name:name}},points:[{interval:{startTime:new Date(time-60000).toISOString(),endTime:new Date(time).toISOString()},value:{int64Value:String(n)}}]}),input=(n=10)=>({run:[metric('photo',2)],legacy:[{...metric('unused',9),resource:{labels:{function_name:'Photo'}}}],reads:[metric('db',n)],writes:[metric('db',3)]});
test('minute history de-duplicates Gen2, keeps documents separate, and rejects hourly counters',()=>{
 const [p]=minuteRecords(input(1354),at);assert.equal(p.calls,2);assert.equal(p.reads,1354);assert.equal(p.writes,3);
 const hourly=metric('db',8000);hourly.points[0].interval.startTime=new Date(at-3600000).toISOString();assert.equal(minuteRecords({reads:[hourly]},at).length,0);
 assert.deepEqual(minuteRecords({...input(),demo:true},at),[]);
});
test('overlapping windows, provider corrections and restarts never double count or lose known data',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-history-')),store=new HistoryStore(dir,{now:()=>at});assert.equal(store.record(input()),1);assert.equal(store.record(input()),0);
 assert.equal(store.record(input(12)),1);store.record({writes:[metric('db',4)],errors:['reads: unavailable']});
 const restarted=new HistoryStore(dir,{now:()=>at}),s=summarizeHistory(restarted.rows.values(),at);assert.equal(s.hours.length,1);assert.equal(s.hours[0].reads,12);assert.equal(s.hours[0].writes,4);assert.equal(s.hours[0].calls,2);assert.equal(s.hours[0].coverage.reads,1);assert.equal(s.hours[0].at,Date.parse('2026-11-25T03:00:00Z'),'minute ending at04:00 belongs to03:59 hour');
});
test('missing metric minutes stay gaps and a real relative read spike retains its measured time',()=>{
 const points=Array.from({length:6},(_,i)=>({at:at-(6-i)*60000,reads:10,writes:null,calls:2,functions:{photo:2}}));points.push({at,reads:1354,writes:null,calls:3,functions:{photo:3}});
 const s=summarizeHistory(points,at);assert.equal(s.spikes.length,1);assert.equal(s.spikes[0].at,at);assert.match(s.spikes[0].reasons[0],/reads.*1354/);assert.equal(s.hours.reduce((a,h)=>a+h.coverage.writes,0),0);assert.equal(s.hours[0].peaks.reads.count,1354);
});
test('thirty-day retention prunes only owned expired journals; corrupt tail does not invent samples',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-history-prune-')),hist=path.join(dir,'history');fs.mkdirSync(hist);fs.writeFileSync(path.join(hist,'metrics-2026-01-01.jsonl'),'old');fs.writeFileSync(path.join(hist,'notes.txt'),'preserve');const p=minuteRecords(input(),at)[0];fs.writeFileSync(path.join(hist,'metrics-2026-11-24.jsonl'),JSON.stringify(p)+'\n{"partial":');const store=new HistoryStore(dir,{now:()=>at});assert.equal(store.rows.size,1);assert.equal(fs.existsSync(path.join(hist,'metrics-2026-01-01.jsonl')),false);assert.equal(fs.readFileSync(path.join(hist,'notes.txt'),'utf8'),'preserve');store.record(input(15));assert.equal(new HistoryStore(dir,{now:()=>at}).rows.get(at).reads,15,'a corrupt old tail cannot swallow the next appended record');
});
test('collector records history from its same four metric requests, with no extra endpoint',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-collector-')),lib=path.join(dir,'lib'),data=path.join(dir,'data'),count=path.join(dir,'calls.json');fs.mkdirSync(lib);
 fs.writeFileSync(path.join(lib,'requireAuth.js'),'exports.requireAuth=async()=>{};');fs.writeFileSync(path.join(lib,'auth.js'),'exports.getGlobalDefaultAccount=()=>({});');
 fs.writeFileSync(path.join(lib,'apiv2.js'),`const fs=require('fs');exports.Client=class{async get(url){const f=${JSON.stringify(count)},a=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):[];a.push(url);fs.writeFileSync(f,JSON.stringify(a));const q=new URL('http://local'+url).searchParams;return {body:{timeSeries:[{resource:{labels:{service_name:'sample'}},points:[{interval:{endTime:q.get('interval.endTime')},value:{int64Value:'2'}}]}]}};}};`);
 const result=spawnSync(process.execPath,[path.join(__dirname,'collector.cjs'),data,'--once'],{env:{...process.env,WB_FIREBASE_TOOLS_LIB:lib},encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(fs.readFileSync(count)).length,4);assert.equal(JSON.parse(fs.readFileSync(path.join(data,'history-summary.json'))).minutes,1);assert.equal(JSON.parse(fs.readFileSync(path.join(data,'status.json'))).historyAvailable,true);
});
