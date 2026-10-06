import {hash,canReviewPost} from './core.mjs';
export class RemoteReviews{
 constructor(queue,transport){this.queue=queue;this.transport=transport;this.busy=false;this.error='';}
 async tick(channels){if(this.busy||this.transport.busy||!this.transport.secret)return;this.busy=true;try{
  this.queue.data.remoteReviews??={};const ledger=this.queue.data.remoteReviews;
  const entries=Object.values(this.queue.data.messages).flatMap(post=>post.rows.filter(row=>this.queue.data.deliveries?.[row.id]?.status==='review'||ledger[row.id]).map(row=>({post,row})));
  for(const {post,row} of entries){if(this.transport.busy)break;const delivery=this.queue.data.deliveries?.[row.id];if(!delivery)continue;
   const revision=hash(post.digest+'\0'+JSON.stringify([row,delivery.status,delivery.issues||[]]));const prior=ledger[row.id];if(delivery.status!=='review'&&prior?.syncedRevision===revision&&!prior.result)continue;
   const payload={rowId:row.id,revision,channel:post.channel,groupName:channels.find(c=>c.id===post.channel)?.name||'',body:post.body||post.chat,author:post.author||'',postedAt:post.postedAt||post.updatedAt,row,status:delivery.status,issues:delivery.issues||row.issues||[],editable:canReviewPost(post,this.queue.data.deliveries)&&!delivery.identity,...(prior?.result?{result:prior.result}:{})};
   const response=await this.transport.request('syncWatchdogReviewV2',payload);ledger[row.id]={...prior,syncedRevision:revision};if(prior?.result)delete ledger[row.id].result;this.queue.save();
   const command=response.command;if(!command)continue;
   if(ledger[row.id].lastCommand===command.id){ledger[row.id].result={id:command.id,ok:ledger[row.id].lastOk,error:ledger[row.id].lastError||''};this.queue.save();continue;}
   try{await this.transport.review(row.id,command.decision,command.review?.dateTimeUTC,command.reason,command.review||{});ledger[row.id]={...ledger[row.id],lastCommand:command.id,lastOk:true,result:{id:command.id,ok:true}};}
   catch(e){if(this.transport.busy)continue;ledger[row.id]={...ledger[row.id],lastCommand:command.id,lastOk:false,lastError:String(e.message),result:{id:command.id,ok:false,error:String(e.message)}};}
   this.queue.save();
  }this.error='';
 }catch(e){this.error=String(e.message||e);}finally{this.busy=false;}}
}
