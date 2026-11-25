// Local-only minute journal. Reuses the collector's already-fetched metric window.
const fs=require('node:fs'),path=require('node:path');
const MINUTE=60000,HOUR=3600000,DAY=86400000;
const valid=n=>Number.isFinite(n)&&n>=0;
function minuteRecords(input,now=Date.now()){
 if(input.demo)return[];
 const rows=new Map(),get=at=>{if(!rows.has(at))rows.set(at,{at,reads:null,writes:null,calls:null,functions:{}});return rows.get(at);};
 const add=(series,key,skip=new Set())=>{for(const s of series||[]){const name=(s.resource?.labels?.service_name||s.resource?.labels?.function_name||'').toLowerCase();if(key==='functions'&&(!name||skip.has(name)))continue;
  for(const p of s.points||[]){const at=Date.parse(p.interval?.endTime),start=Date.parse(p.interval?.startTime),n=Number(p.value?.int64Value??p.value?.doubleValue);if(!valid(n)||!Number.isFinite(at)||at%MINUTE||at>now+5*MINUTE||(Number.isFinite(start)&&at-start!==MINUTE))continue;const r=get(at);if(key==='functions')r.functions[name]=(r.functions[name]||0)+n;else r[key]=(r[key]??0)+n;}
 }};
 add(input.reads,'reads');add(input.writes,'writes');
 const runNames=new Set((input.run||[]).map(s=>(s.resource?.labels?.service_name||'').toLowerCase()));
 add(input.run,'functions');add(input.legacy,'functions',runNames);
 const callsComplete=Array.isArray(input.run)&&Array.isArray(input.legacy)&&!input.truncated&&!input.errors?.some(e=>/^(run|legacy):/.test(e));
 for(const r of rows.values()){
  if(callsComplete&&Object.keys(r.functions).length)r.calls=Object.values(r.functions).reduce((a,b)=>a+b,0);
  r.functions=callsComplete?Object.fromEntries(Object.entries(r.functions).filter(([,n])=>n>0).sort(([a],[b])=>a.localeCompare(b))):{};
  if(input.truncated){r.reads=null;r.writes=null;}
 }
 return [...rows.values()].sort((a,b)=>a.at-b.at);
}
function summarizeHistory(points,now=Date.now(),days=30){
 const rows=[...points].filter(p=>p.at>=now-days*DAY&&p.at<=now).sort((a,b)=>a.at-b.at),hours=new Map(),spikes=[],recent={reads:[],writes:[],calls:[]};
 for(const p of rows){
  const start=Math.floor((p.at-1)/HOUR)*HOUR;
  if(!hours.has(start))hours.set(start,{at:start,reads:0,writes:0,calls:0,coverage:{reads:0,writes:0,calls:0},peaks:{reads:null,writes:null,calls:null},functions:{}});
  const h=hours.get(start),reasons=[];
  for(const key of ['reads','writes','calls'])if(valid(p[key])){
   h[key]+=p[key];h.coverage[key]++;if(!h.peaks[key]||p[key]>h.peaks[key].count)h.peaks[key]={count:p[key],at:p.at};
   const old=recent[key].filter(x=>x.at>=p.at-60*MINUTE),values=old.map(x=>x.count).sort((a,b)=>a-b),median=values.length?values[Math.floor(values.length/2)]:null;
   const floor={reads:500,writes:200,calls:120}[key],fixed={reads:3000,writes:1000,calls:120}[key];
   if(p[key]>=fixed||(values.length>=5&&p[key]>=floor&&p[key]>=Math.max(1,median)*10))reasons.push(key+': '+Math.round(p[key])+'/min');
   recent[key]=[...old,{at:p.at,count:p[key]}];
  }
  if(p.calls!==null)for(const[name,count]of Object.entries(p.functions||{}))h.functions[name]=(h.functions[name]||0)+count;
  if(reasons.length){const busiest=Object.entries(p.functions||{}).sort((a,b)=>b[1]-a[1])[0];spikes.push({at:p.at,reasons,busiest:busiest?{name:busiest[0],count:busiest[1]}:null});}
 }
 return {schemaVersion:1,project:'wellbuilt-sync',generatedAt:now,retentionDays:days,firstAt:rows[0]?.at||null,lastAt:rows.at(-1)?.at||null,minutes:rows.length,
  hours:[...hours.values()].sort((a,b)=>b.at-a.at),points:rows.filter(p=>p.at>=now-DAY),spikes:spikes.slice(-200).reverse(),
  note:'Recorded minute totals only. Missing samples are gaps, never zeros. Peaks are per-minute counts. Test alerts are excluded.'};
}
class HistoryStore{
 constructor(data,{days=30,now=Date.now}={}){
  this.data=path.resolve(data);this.dir=path.join(this.data,'history');this.days=days;this.now=now;this.rows=new Map();fs.mkdirSync(this.dir,{recursive:true});
  for(const file of fs.readdirSync(this.dir).filter(f=>/^metrics-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()){
   const day=Date.parse(file.slice(8,18)+'T00:00:00Z');if(day+DAY<this.now()-days*DAY)continue;
   const text=fs.readFileSync(path.join(this.dir,file),'utf8');
   for(const line of text.split('\n')){if(!line)continue;try{const p=JSON.parse(line);if(this.valid(p))this.rows.set(p.at,p);}catch{/* An incomplete final line cannot fabricate a zero minute. */}}
   if(text&&!text.endsWith('\n'))fs.appendFileSync(path.join(this.dir,file),'\n');
  }
  this.prune();
 }
 valid(p){return p&&Number.isFinite(p.at)&&p.at%MINUTE===0&&['reads','writes','calls'].every(k=>p[k]===null||valid(p[k]))&&p.functions&&typeof p.functions==='object';}
 prune(){const cutoff=this.now()-this.days*DAY;for(const[at]of this.rows)if(at<cutoff)this.rows.delete(at);
  for(const file of fs.readdirSync(this.dir))if(/^metrics-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)&&Date.parse(file.slice(8,18)+'T00:00:00Z')+DAY<cutoff){const target=path.resolve(this.dir,file);if(path.dirname(target)===this.dir)fs.unlinkSync(target);}
 }
 record(input){
  if(input.demo)return 0;this.prune();let changed=0;
  for(const p of minuteRecords(input,this.now())){
   if(p.at<this.now()-this.days*DAY)continue;const old=this.rows.get(p.at),next={...p};
   if(old)for(const k of ['reads','writes','calls'])if(next[k]===null){next[k]=old[k];if(k==='calls')next.functions=old.functions;}
   if(old&&JSON.stringify(old)===JSON.stringify(next))continue;
   const file=path.join(this.dir,'metrics-'+new Date(p.at-1).toISOString().slice(0,10)+'.jsonl');
   fs.appendFileSync(file,JSON.stringify(next)+'\n');this.rows.set(p.at,next);changed++;
  }
  const summary=summarizeHistory(this.rows.values(),this.now(),this.days),tmp=path.join(this.data,'history-summary.tmp');fs.writeFileSync(tmp,JSON.stringify(summary));fs.renameSync(tmp,path.join(this.data,'history-summary.json'));return changed;
 }
}
module.exports={minuteRecords,summarizeHistory,HistoryStore};
