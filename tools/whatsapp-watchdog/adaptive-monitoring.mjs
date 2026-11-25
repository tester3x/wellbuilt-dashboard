// Local posting history controls background cloud checks, never WhatsApp capture.
// Manual pauses and learned quiet periods are separate: new posts always wake
// normal processing unless the user explicitly paused that well.
const median=values=>{const a=[...values].sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]:90*60000;};
const clock=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',hourCycle:'h23'});
function parts(at){const p=Object.fromEntries(clock.formatToParts(new Date(at)).map(x=>[x.type,x.value]));return{day:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour)};}
export function learnChannelActivity(messages,{pausedWells=[],channelIds=[]}={},now=Date.now()){
 const paused=new Set(pausedWells),allowed=new Set(channelIds),groups=new Map();
 for(const post of Object.values(messages||{})){
  const at=Date.parse(post.postedAt);if(post.deleted||post.id?.startsWith('export:')||!Number.isFinite(at)||at>now+300000||at<now-30*86400000)continue;
  if(allowed.size&&!allowed.has(post.channel))continue;
  const rows=post.rows||[];if(!rows.some(row=>!paused.has(row.wellName)))continue;
  const group=groups.get(post.channel)||new Set();group.add(at);groups.set(post.channel,group);
 }
 const current=parts(now),channels=[];
 for(const [id,set]of groups){
  const times=[...set].sort((a,b)=>a-b),gaps=times.slice(1).map((at,i)=>at-times[i]).filter(gap=>gap>=10*60000&&gap<=6*3600000);
  const typicalGapMs=median(gaps),days=new Set(),hours=new Set();for(const at of times){const p=parts(at);days.add(p.day);hours.add(p.hour);}
  const ageMs=Math.max(0,now-times.at(-1));
  // Three observed days before treating an empty clock hour as a pattern.
  // No fixed customer/day/night schedule is embedded in this code.
  const learnedQuiet=days.size>=3&&!hours.has(current.hour)&&ageMs>Math.max(30*60000,typicalGapMs);
  const overdueQuiet=ageMs>Math.max(3600000,typicalGapMs*2);
  channels.push({id,samples:times.length,days:days.size,typicalGapMs,lastAt:times.at(-1),quiet:learnedQuiet||overdueQuiet,reason:learnedQuiet?'historically_quiet_hour':overdueQuiet?'no_recent_posts':'recent_activity'});
 }
 return{channels,quiet:channels.length===0||channels.every(c=>c.quiet),computedAt:now};
}
export class AdaptiveMonitoring{
 constructor(queue,config={},channelIds=[]){this.queue=queue;this.config=config;this.channelIds=channelIds;this.cached=null;}
 isPaused(well){return(this.config.pausedWells||[]).includes(well);}
 plan(){if(!this.cached||Date.now()-this.cached.computedAt>=60000)this.cached=learnChannelActivity(this.queue.data.messages,{...this.config,channelIds:this.channelIds},Date.now());return this.cached;}
 interval(base,quiet){return this.config.enabled===true&&this.plan().quiet?quiet:base;}
 reviewInterval(channel){if(this.config.enabled!==true)return 300000;const c=this.plan().channels.find(c=>c.id===channel);return !c||c.quiet?900000:300000;}
}
