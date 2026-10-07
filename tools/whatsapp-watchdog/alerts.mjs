export class ReviewAlerts {
 constructor(queue){this.queue=queue;this.busy=false;this.error='';}
 async tick(send,groupNames={},now=Date.now()){
  const config=this.queue.data.reviewAlerts;if(this.busy||!config?.enabled||!config.groupId)return;
  const entries=this.queue.reviewInbox(),ledger=config.notified||{},fresh=entries.filter(e=>!ledger[e.row.id]);
  if(!fresh.length)return;
  if(now-(config.lastAttemptAt||0)<60000)return;
  this.busy=true;config.lastAttemptAt=now;this.queue.save();
  try{
   const counts=new Map();for(const e of fresh){const name=groupNames[e.post.channel]||'Watched group';counts.set(name,(counts.get(name)||0)+1);}
   const lines=['Watchdog Overlord: '+(fresh.length+' new pull'+(fresh.length===1?' needs':'s need')+' review'),entries.length+' held pull'+(entries.length===1?'':'s')+' total.',...Array.from(counts,([name,count])=>name+': '+count),this.queue.data.remoteReviewsEnabled?'Review from your phone: https://wellbuilt-sync.web.app/watchdog/ (sign in and select your company).':'Open Needs review on the watchdog laptop.'];
   await send(config.groupId,lines.join('\n'));
   config.notified={...ledger,...Object.fromEntries(fresh.map(e=>[e.row.id,now]))};config.lastSentAt=now;this.error='';this.queue.save();
  }catch(e){this.error=String(e.message||e);}finally{this.busy=false;}
 }
}
