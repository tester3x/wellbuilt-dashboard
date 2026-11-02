/** Local review disposition only. Never edits a delivered packet or confirms an estimate. */
export function dismissReview(queue, {rowId, reason='', category='archived'}, now=new Date().toISOString()) {
 if(typeof rowId!=='string'||!rowId||typeof reason!=='string'||reason.length>300
   || !['archived','duplicate','not_a_load'].includes(category))throw Error('Invalid review dismissal');
 const previous=queue.data.deliveries?.[rowId];
 if(!previous)throw Error('Review entry not found');
 if(previous.reviewDismissal)return {ok:true,alreadyDismissed:true};
 if(previous.status!=='review'&&!previous.needsReview)throw Error('Entry does not need review');
 const next={...previous,status:category==='duplicate'?'duplicate':'archived',needsReview:false,
  reviewDismissal:{at:now,reason:reason.trim()||'Dismissed from review; existing records retained',category,
   previousStatus:previous.status,previousNeedsReview:!!previous.needsReview}};
 queue.data.deliveries[rowId]=next;
 try{queue.save();}catch(error){queue.data.deliveries[rowId]=previous;throw error;}
 return {ok:true,status:next.status};
}
