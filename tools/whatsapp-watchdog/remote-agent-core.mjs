import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';
export const recoveryActions=['refresh','reconnect','retry_pending','resume','restart_worker'];
export function healthSummary(status,version='remote-agent-v1'){
 const counts=Object.values(status?.deliveries||{});
 return {workerReachable:!!status,state:String(status?.state||'Worker unavailable').slice(0,80),paused:status?.paused===true,lastReceiverCheck:String(status?.lastReceiverCheck||'').slice(0,40),transportStatus:String(status?.transportStatus||'Unavailable').slice(0,120),pending:counts.filter(d=>['queued','incomplete'].includes(d.status)).length,reviews:counts.filter(d=>d.status==='review'||d.needsReview).length,channels:status?.channels?.length||0,version,error:String(status?.error||status?.remoteReviewError||'').slice(0,300)};
}
export class RecoveryAgent {
 constructor({directory,sync,health,execute,now=Date.now}){
  Object.assign(this,{directory,sync,health,execute,now});this.busy=false;
  this.file=path.join(directory,'remote-agent-ledger.json');
  try{this.ledger=JSON.parse(readFileSync(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;this.ledger={};}
  // A crash after claiming a command must never replay its side effect.
  for(const record of Object.values(this.ledger))if(record.state==='executing'){record.state='finished';record.result={id:record.id,ok:false,error:'Recovery helper restarted during this action. Check health before requesting it again.'};}
  this.save();
 }
 save(){writeFileSync(this.file+'.tmp',JSON.stringify(this.ledger),{mode:0o600});renameSync(this.file+'.tmp',this.file);}
 async tick(){
  if(this.busy)return;this.busy=true;
  try{
   const pending=Object.values(this.ledger).find(r=>r.result&&!r.acknowledged);
   const response=await this.sync({agentId:'hp-watchdog',health:await this.health(),...(pending?{result:pending.result}:{})});
   if(response.ok!==true)throw Error('Health service did not confirm receipt');
   if(pending){pending.acknowledged=true;this.save();}
   const command=response.command;if(!command)return;
   if(typeof command.id!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(command.id)||!recoveryActions.includes(command.action)||!Number.isFinite(command.expiresAt))throw Error('Invalid remote recovery command');
   const previous=this.ledger[command.id];
   if(previous){if(previous.action!==command.action)throw Error('Recovery command identity changed');previous.acknowledged=false;this.save();return;}
   const record={id:command.id,action:command.action,state:'executing',claimedAt:this.now()};this.ledger[command.id]=record;this.save();
   try{if(command.expiresAt<=this.now())throw Error('Recovery request expired; no action performed');await this.execute(command.action);record.result={id:command.id,ok:true,error:''};}
   catch(e){record.result={id:command.id,ok:false,error:String(e.message||e).slice(0,300)};}
   record.state='finished';this.save();
  }finally{this.busy=false;}
 }
}
