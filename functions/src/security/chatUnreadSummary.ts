import * as admin from 'firebase-admin';
import {createHash} from 'crypto';

const millis = (value: any): number => value?.toMillis?.() || (typeof value === 'string' ? Date.parse(value) : 0) || 0;

/** Count messages, not people or threads. Own automatic reports are outgoing. */
export function summarizeUnreadMessages(messages: any[], thread: any, participant: string, aliases: string[] = []) {
  const own = new Set([participant, ...aliases]);
  const readAt = Math.max(0, ...[...own].map(id => millis(thread.lastRead?.[id])));
  const driverIds = (thread.participants || []).filter((id: string) => id.startsWith('driver:'));
  const soleOwnDriver = participant.startsWith('driver:') && driverIds.length > 0 && driverIds.every((id: string) => own.has(id));
  const incoming = messages.filter(message => {
    const sender = String(message.senderId || '');
    if (own.has(sender) || own.has(`driver:${sender}`)) return false;
    if (soleOwnDriver && sender === 'system' && ['shift_start', 'shift_started', 'shift_ended'].includes(message.systemType)) return false;
    return millis(message.timestamp || message.createdAt) > readAt;
  }).sort((a, b) => millis(b.timestamp || b.createdAt) - millis(a.timestamp || a.createdAt));
  const latest = incoming[0];
  return { unreadCount: incoming.length, ...(latest ? { lastUnreadMessage: {
    text: latest.text || (latest.photoUrl ? 'Photo' : 'New message'), senderId: latest.senderId,
    senderName: latest.senderName || '', timestamp: latest.timestamp || latest.createdAt, type: latest.type || 'text',
  } } : {}) };
}

/** Cache only presentation counts, after caller membership checks. Never marks a read.
 * A message/read/revision change invalidates the cache; old data cannot suppress a fresh message. */
export function unreadSummaryStamp(thread:any,participant:string,aliases:string[]=[]):string {
 const own=[...new Set([participant,...aliases])].sort();
 return createHash('sha256').update(JSON.stringify([1,own,own.map(id=>millis(thread.lastRead?.[id])),
  thread.lastMessage||null,millis(thread.updatedAt),thread.communicationRevision||0,thread.historyMigrationVersion||0,thread.unreadHistoryVersion||0])).digest('hex');
}
export async function readUnreadSummary(ref: admin.firestore.DocumentReference, thread: any, participant: string, aliases: string[] = []) {
 const readAt = Math.max(0, ...[participant, ...aliases].map(id => millis(thread.lastRead?.[id])));
 if (thread.lastMessage && millis(thread.lastMessage.timestamp) <= readAt) return { unreadCount: 0 };
 const key=createHash('sha256').update(JSON.stringify([participant,[...new Set(aliases)].sort()])).digest('hex');
 const stamp=unreadSummaryStamp(thread,participant,aliases),history=JSON.stringify([thread.historyMigrationVersion||0,thread.unreadHistoryVersion||0]);
 let cached=thread.unreadSummaries?.[key],cacheReads=0;
 if(!cached){try{cached=(await ref.collection('_read_summaries').doc(key).get()).data();cacheReads=1;}catch{}}
 const valid=cached?.version===2&&Date.now()-cached.at>=0&&Date.now()-cached.at<6*3600000
  &&Number.isSafeInteger(cached.summary?.unreadCount)&&cached.summary.unreadCount>=0;
 if(valid&&cached.stamp===stamp){console.info('WB_READ_COST',{operation:'chat.unread',documents:cacheReads,cache:'hit'});return cached.summary;}
 const delta=valid&&cached.readAt===readAt&&cached.history===history&&Number.isFinite(cached.through)&&cached.through>0
  &&Array.isArray(cached.idsAtBoundary)&&cached.idsAtBoundary.length<=200&&millis(thread.lastMessage?.timestamp)>cached.through;
 const cutoff = admin.firestore.Timestamp.fromMillis(delta?cached.through:readAt);
 const batches = await Promise.all(['timestamp', 'createdAt'].map(field => ref.collection('messages').where(field, delta?'>=':'>', cutoff).get()));
 const messages = new Map<string, any>();
 for (const batch of batches) for (const doc of batch.docs) messages.set(doc.id, doc.data());
 const oldBoundary=new Set(delta?cached.idsAtBoundary:[]);
 const added=summarizeUnreadMessages([...messages].filter(([id])=>!oldBoundary.has(id)).map(([,row])=>row),thread,participant,aliases);
 let summary:any=added;
 if(delta){const latest=millis(added.lastUnreadMessage?.timestamp)>=millis(cached.summary.lastUnreadMessage?.timestamp)?added.lastUnreadMessage:cached.summary.lastUnreadMessage;
  summary={unreadCount:cached.summary.unreadCount+added.unreadCount,...(latest?{lastUnreadMessage:latest}:{})};}
 const wire=JSON.parse(JSON.stringify({...summary,...(summary.lastUnreadMessage?{lastUnreadMessage:{...summary.lastUnreadMessage,
  timestamp:new Date(millis(summary.lastUnreadMessage.timestamp)).toISOString()}}:{})}));
 const through=Math.max(delta?cached.through:readAt,...[...messages.values()].map(row=>Math.max(millis(row.timestamp),millis(row.createdAt))));
 const idsAtBoundary=[...messages].filter(([,row])=>Math.max(millis(row.timestamp),millis(row.createdAt))===through).map(([id])=>id);
 const value={version:2,stamp,history,at:Date.now(),readAt,through,idsAtBoundary,summary:wire};
 try{if((cached&&thread.unreadSummaries?.[key]||Object.keys(thread.unreadSummaries||{}).length<16)&&JSON.stringify(value).length<8192)
   await ref.update({['unreadSummaries.'+key]:value});
  else await ref.collection('_read_summaries').doc(key).set(value);
 }catch{/* Optional cache failure cannot block receiving chat or mark messages read. */}
 console.info('WB_READ_COST',{operation:'chat.unread',documents:cacheReads+batches.reduce((n,b)=>n+Math.max(1,b.size),0),unique:messages.size,cache:delta?'delta':'miss'});
 return wire;
}
