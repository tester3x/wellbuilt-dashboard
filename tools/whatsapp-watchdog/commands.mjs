export class OverlordCommands {
 constructor(queue,bridge=null){this.bridge=bridge;this.queue=queue;this.startedAt=Date.now();this.busy=false;}
 async receive(message,send,context){
  const config=this.queue.data.reviewAlerts;
  if(message.channel!==config?.groupId||message.deleted||!/^watchdog:\s*/i.test(message.body||''))return false;
  if(!message.fromMe&&!['24240845779152@lid'].includes(message.senderId))return true;
  if(message.timestamp*1000<this.startedAt||this.busy)return true;
  const ledger=this.queue.data.commandLedger??={};if(ledger[message.id])return true;
  ledger[message.id]={at:Date.now(),status:'claimed'};this.queue.save();this.busy=true;
  try{
   const command=message.body.replace(/^watchdog:\s*/i,'').trim().toLowerCase();let reply;
   if(/^(qc|quick commands?)\b/.test(command))reply='Quick commands:\n\nWatchdog: status\nWatchdog: reviews\nWatchdog: latest G3\nWatchdog: latest G5\n\nOther requests: Watchdog: followed by your request';
   else if(command==='status')reply=`${context.state} · ${context.paused?'Paused':'Watching'} · WB M: ${context.transportStatus}\n${this.queue.reviewInbox().length} pulls need review.`;
   else if(['reviews','review list'].includes(command))reply=this.queue.reviewInbox().map(({row})=>`${row.wellName} · ${row.dateTimeUTC} · ${row.tankLevelFeet} ft`).join('\n')||'No pulls need review.';
   else if(/^latest(?:\s+(?:g[35]|gunslinger [35]))?$/.test(command)){
    const filter=command.slice(6).trim().replace(/^g([35])$/,'gunslinger $1');
    const rows=Object.values(this.queue.data.messages).filter(m=>!m.deleted).flatMap(m=>m.rows).filter(r=>!filter||r.wellName.toLowerCase()===filter).sort((a,b)=>Date.parse(b.dateTimeUTC)-Date.parse(a.dateTimeUTC));
    const r=rows[0],d=r&&this.queue.data.deliveries?.[r.id];reply=r?`${r.wellName} · ${r.dateTimeUTC}\nTop ${r.tankLevelFeet} ft · bottom ${d?.measurements?.bottomLevelFeet??r.bottomLevelFeet} ft · ${d?.measurements?.bblsTaken??r.bblsTaken} bbl\nWB M: ${d?.status||'pending'}${d?.needsReview?' · needs review':''}`:'No matching pull found.';
   }else {
    const request=message.body.replace(/^watchdog:\s*/i,'').trim();
    if(!request)reply='Put your request after Watchdog:.';
    else if(request.length>8000)reply='Please keep the request under 8,000 characters.';
    else {this.queue.data.codexRequests??={};this.queue.data.codexRequests[message.id]={request,channel:message.channel,senderId:message.senderId||'linked-account',createdAt:Date.now(),status:this.bridge?.config?.enabled?'queued':'awaiting_execution_setup'};this.queue.save();reply=(this.bridge?.config?.enabled?'Request queued for Codex. I will post the result here.':'Request saved for Codex. Execution is not configured; this request has not run.');}
   }
   await send(message.channel,'Watchdog reply\n'+reply.slice(0,2500));ledger[message.id].status='sent';this.queue.save();
  }catch(e){ledger[message.id].status='failed';ledger[message.id].error=String(e.message||e);this.queue.save();}finally{this.busy=false;}return true;
 }
}
