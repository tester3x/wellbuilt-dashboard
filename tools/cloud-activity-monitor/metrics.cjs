const defaults={functionWarn:120,functionCritical:600,readsWarn:3000,readsCritical:10000,writesWarn:1000,writesCritical:5000};
function latestBucket(series){
 const bins=new Map();
 for(const s of series||[])for(const p of s.points||[]){const at=Date.parse(p.interval?.endTime);const n=Number(p.value?.int64Value??p.value?.doubleValue);if(Number.isFinite(at)&&Number.isFinite(n)&&n>=0)bins.set(at,(bins.get(at)||0)+n);}
 if(!bins.size)return null;const at=Math.max(...bins.keys());return {at,count:bins.get(at)};
}
function functions(series){
 const byName=new Map();
 for(const s of series||[]){const name=s.resource?.labels?.service_name||s.resource?.labels?.function_name;if(!name)continue;const list=byName.get(name)||[];list.push(s);byName.set(name,list);}
 return [...byName].map(([name,list])=>{
  const sample=latestBucket(list);const errors=list.filter(s=>/^5/.test(String(s.metric?.labels?.response_code||s.metric?.labels?.response_code_class||''))||s.metric?.labels?.status&&s.metric.labels.status!=='ok');
  const e=latestBucket(errors);return {name,...sample,errors:e?.at===sample?.at?e.count:0};
 }).filter(r=>r.at).sort((a,b)=>b.count-a.count);
}
function summarize(input,now=Date.now(),limits=defaults){
 const rows=functions(input.run),names=new Set(rows.map(r=>r.name.toLowerCase())),legacy=functions(input.legacy);
 // Gen 2 appears in both metric families. Prefer Cloud Run; do not list/count
 // the same function twice under lowercase service and camel-case function IDs.
 const all=[...rows,...legacy.filter(r=>!names.has(r.name.toLowerCase()))].sort((a,b)=>b.count-a.count);
 const reads=latestBucket(input.reads),writes=latestBucket(input.writes);
 const alerts=[];let severity=0;
 const flag=(label,value,warn,critical)=>{if(value>=warn){const level=value>=critical?2:1;severity=Math.max(severity,level);alerts.push(`${label}: ${Math.round(value).toLocaleString('en-US')}/min`);}};
 for(const row of all){flag(row.name,row.count,limits.functionWarn,limits.functionCritical);if(row.errors>=10){severity=Math.max(severity,1);alerts.push(`${row.name}: ${row.errors} server errors/min`);}}
 if(reads)flag('Firestore reads',reads.count,limits.readsWarn,limits.readsCritical);
 if(writes)flag('Firestore writes',writes.count,limits.writesWarn,limits.writesCritical);
 const newest=Math.max(0,...all.map(r=>r.at),reads?.at||0,writes?.at||0);
 const errors=input.errors||[];
 const stale=!newest||now-newest>10*60000;
 const status=errors.length||input.truncated?'UNKNOWN':stale?'NO_RECENT_DATA':severity===2?'CRITICAL':severity===1?'WARNING':'NORMAL';
 return {schemaVersion:1,project:'wellbuilt-sync',collectedAt:now,sampleAt:newest||null,status,alerts,errors,functions:all.slice(0,12),photo:all.find(r=>r.name==='processwatchdogphotofallback')||null,reads,writes,
  note:'Google metrics are delayed; rates use the latest completed one-minute sample. No traffic is not proof of worker health.'};
}
module.exports={defaults,latestBucket,functions,summarize};
