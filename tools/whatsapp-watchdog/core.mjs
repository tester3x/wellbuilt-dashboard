import {combinedPullTimes} from './combined-times.mjs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {parsePullChat,findPullChatNotices,splitChat,chatTimestamp}=require('../../functions/lib/imports/pullParser.js');
export const hash=value=>createHash('sha256').update(value).digest('hex');
export function header(timestamp,author,body){
 const f=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 const parts=Object.fromEntries(f.formatToParts(new Date(timestamp)).map(x=>[x.type,x.value]));
 const date=`${parts.month}/${parts.day}/${parts.year}`;let time=`${parts.hour}:${parts.minute}:${parts.second}`;
 // Retain WhatsApp's exact offset only in the repeated hour. Ordinary headers
 // stay byte-identical so historical deliveries are not needlessly reparsed.
 try{chatTimestamp(date,time);}catch(error){
  if(!String(error.message).includes('Ambiguous or nonexistent'))throw error;
  const offset=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',timeZoneName:'longOffset'}).formatToParts(new Date(timestamp)).find(p=>p.type==='timeZoneName').value.replace('GMT','UTC');
  time+=' '+offset;
 }
 return `[${date}, ${time}] ${String(author).replace(/[\r\n]/g,' ')}: ${body}`;
}
export class Queue{
 constructor(directory){this.directory=directory;mkdirSync(directory,{recursive:true});this.file=path.join(directory,'queue.json');try{this.data=JSON.parse(readFileSync(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;this.data={version:1,messages:{}};}if(this.data.version!==1)throw Error('Unsupported queue version');}
 save(){const tmp=this.file+'.tmp';writeFileSync(tmp,JSON.stringify(this.data),{mode:0o600});renameSync(tmp,this.file);}
 ingest({id,channel,chat,options={},deleted=false,senderId,photoEvidence,photoPending=false,body,author,timestamp}){
 if(!id||!channel||typeof chat!=='string'||chat.length>2000000)throw Error('Invalid message');
 const key=hash(channel+'\0'+id),previous=this.data.messages[key];
 if(previous?.photoOnly&&!deleted&&!photoEvidence)return {duplicate:true};
 const digest=hash(chat+'\0'+deleted+'\0'+JSON.stringify(options)+'\0'+(senderId||'')+(photoEvidence?JSON.stringify([photoEvidence,photoPending]):''));
 if(previous?.digest===digest)return {duplicate:true};
 const post=splitChat(chat)[0];
 let postedAt='';if(post)try{postedAt=chatTimestamp(post.date,post.time);}catch{}
 if(photoEvidence)postedAt=new Date(timestamp*1000).toISOString();
 const rows=deleted?[]:photoEvidence?[{...photoEvidence,id:key+':photo',postedAt,dateTimeUTC:postedAt}]
  :parsePullChat(chat,{...options,levelNotation:'feet_inches'}).map(row=>({...row,id:key+':'+row.id}));
 const notices=deleted||photoEvidence?[]:findPullChatNotices(chat);
 postedAt=rows[0]?.postedAt||postedAt;
 const sameBody=previous?.body===(photoEvidence?body:post?.body||chat);
 const recoveredClock=previous&&!previous.edited&&sameBody&&!previous.postedAt&&postedAt&&rows.length===previous.rows.length;
 if(recoveredClock)for(const row of rows){
  const old=previous.rows.find(r=>r.id===row.id),d=this.data.deliveries?.[row.id];
  if(!row.issues.length&&old?.issues.some(i=>i.includes('daylight-saving time'))&&d?.status==='review'&&!d.identity&&!d.review&&d.issues?.every(i=>i.includes('daylight-saving time')||i==='Invalid stated pull time'))delete this.data.deliveries[row.id];
 }
 this.data.messages[key]={key,id,channel,chat,digest,senderId:senderId||previous?.senderId||null,rows,notices,deleted,edited:!!previous&&(previous.edited||!sameBody||!!previous.postedAt&&previous.postedAt!==postedAt),postedAt,author:photoEvidence?author:post?.author||'',body:photoEvidence?body:post?.body||chat,updatedAt:new Date().toISOString(),...(photoEvidence||previous?.photoOnly?{photoOnly:true,photoPending}: {})};
 if(photoEvidence){
  this.data.deliveries??={};
  if(!sameBody||!this.data.deliveries[rows[0].id]?.reviewDismissal)
   this.data.deliveries[rows[0].id]={status:'review',issues:photoEvidence.issues};
 }
 this.save();return {duplicate:false,rows:rows.length,notices:notices.length};
 }
 reparseChannels(channelOptions){
 let changed=false;
 for(const message of Object.values(this.data.messages)){
  const options=channelOptions[message.channel];
  if(!options||message.deleted||message.edited||message.photoOnly||message.id.startsWith('export:'))continue;
  let rows=parsePullChat(message.chat,{...options,levelNotation:'feet_inches'}).map(row=>({...row,id:message.key+':'+row.id})).map(row=>{const d=this.data.deliveries?.[row.id];return d&&(['duplicate','excluded','archived','before_activation'].includes(d.status)||(d.status==='complete'&&!d.needsReview))?message.rows.find(old=>old.id===row.id)||row:row;});
  const estimated=combinedPullTimes({...message,rows},this.data);if(estimated)rows=estimated.map(row=>{const d=this.data.deliveries?.[row.id];return d&&(['duplicate','excluded','archived','before_activation'].includes(d.status)||(d.status==='complete'&&!d.needsReview)||d.review)?message.rows.find(old=>old.id===row.id)||row:row;});
   if(JSON.stringify(rows)!==JSON.stringify(message.rows)){message.rows=rows;changed=true;}
  for(const row of rows){const delivery=this.data.deliveries?.[row.id];
   if(!row.issues.length&&!message.notices.length&&delivery?.status==='review'&&!delivery.identity&&!delivery.review&&delivery.issues?.length===1&&(['Missing barrels','Unreadable levels'].includes(delivery.issues[0])||row.combinedTimeResolved&&delivery.issues[0]==='Multiple wells in one message; confirm individual pull times')){delete this.data.deliveries[row.id];changed=true;}
  }
 }
 if(changed)this.save();
 }
 reviewInbox(){return Object.values(this.data.messages).flatMap(post=>post.rows.filter(row=>(this.data.deliveries?.[row.id]?.status==='review'||this.data.deliveries?.[row.id]?.needsReview)).map(row=>({post:{...post,rows:[row]},row}))).sort((a,b)=>Date.parse(a.post.postedAt||a.post.updatedAt)-Date.parse(b.post.postedAt||b.post.updatedAt));}
 snapshot(){const messages=Object.values(this.data.messages);return {reviewInbox:this.reviewInbox(),messageCount:messages.length,pullCount:messages.reduce((n,m)=>n+m.rows.length,0),messages:messages.filter(m=>m.rows.length||m.notices.length||m.deleted).slice(-200).reverse()};}
 liveFeed(channels){const selected=new Set(channels),counts=new Map();return Object.values(this.data.messages).filter(m=>selected.has(m.channel)&&!m.id.startsWith('export:')).sort((a,b)=>Date.parse(b.postedAt||b.updatedAt)-Date.parse(a.postedAt||a.updatedAt)).filter(m=>{const count=counts.get(m.channel)||0;counts.set(m.channel,count+1);return count<100;});}
 export(channel){return Object.values(this.data.messages).filter(m=>m.channel===channel&&!m.deleted&&!m.photoOnly&&(m.rows.length||m.notices.length)).sort((a,b)=>Date.parse(a.rows[0]?.postedAt||a.updatedAt)-Date.parse(b.rows[0]?.postedAt||b.updatedAt)).map(m=>m.chat).join('\n');}
}

export function newestReceiverMessages(messages,limit=100){const unique=new Map();for(const m of messages)unique.set(m.channel+'\0'+m.id,m);const counts=new Map();return [...unique.values()].sort((a,b)=>b.timestamp-a.timestamp).filter(m=>{const count=counts.get(m.channel)||0;counts.set(m.channel,count+1);return count<limit;});}

export function canReviewPost(post,deliveries,rowId){if(rowId&&deliveries?.[rowId]?.needsReview)return !post.deleted&&deliveries[rowId].status==='complete'&&!deliveries[rowId].correctionPending;if(rowId&&!post.edited){const d=deliveries?.[rowId];return !post.deleted&&!d?.identity&&!['complete','duplicate','queued','incomplete'].includes(d?.status);}return !post.deleted&&!Object.entries(deliveries||{}).some(([id,d])=>id.startsWith(post.key+':')&&(d.identity||['complete','duplicate','queued','incomplete'].includes(d.status)));}
