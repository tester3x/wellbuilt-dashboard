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
 return `[${parts.month}/${parts.day}/${parts.year}, ${parts.hour}:${parts.minute}:${parts.second}] ${String(author).replace(/[\r\n]/g,' ')}: ${body}`;
}
export class Queue{
 constructor(directory){this.directory=directory;mkdirSync(directory,{recursive:true});this.file=path.join(directory,'queue.json');try{this.data=JSON.parse(readFileSync(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;this.data={version:1,messages:{}};}if(this.data.version!==1)throw Error('Unsupported queue version');}
 save(){const tmp=this.file+'.tmp';writeFileSync(tmp,JSON.stringify(this.data),{mode:0o600});renameSync(tmp,this.file);}
 ingest({id,channel,chat,options={},deleted=false}){
 if(!id||!channel||typeof chat!=='string'||chat.length>2000000)throw Error('Invalid message');
 const key=hash(channel+'\0'+id),digest=hash(chat+'\0'+deleted+'\0'+JSON.stringify(options));const previous=this.data.messages[key];
 if(previous?.digest===digest)return {duplicate:true};
 const rows=deleted?[]:parsePullChat(chat,options).map(row=>({...row,id:key+':'+row.id}));
 const notices=deleted?[]:findPullChatNotices(chat);
 const post=splitChat(chat)[0];let postedAt=rows[0]?.postedAt||'';if(!postedAt&&post)try{postedAt=chatTimestamp(post.date,post.time);}catch{}
 this.data.messages[key]={key,id,channel,chat,digest,rows,notices,deleted,edited:!!previous,postedAt,author:post?.author||'',body:post?.body||chat,updatedAt:new Date().toISOString()};this.save();return {duplicate:false,rows:rows.length,notices:notices.length};
 }
 snapshot(){const messages=Object.values(this.data.messages);return {messageCount:messages.length,pullCount:messages.reduce((n,m)=>n+m.rows.length,0),messages:messages.filter(m=>m.rows.length||m.notices.length||m.deleted).slice(-200).reverse()};}
 liveFeed(channels){const selected=new Set(channels),counts=new Map();return Object.values(this.data.messages).filter(m=>selected.has(m.channel)&&!m.id.startsWith('export:')).sort((a,b)=>Date.parse(b.postedAt||b.updatedAt)-Date.parse(a.postedAt||a.updatedAt)).filter(m=>{const count=counts.get(m.channel)||0;counts.set(m.channel,count+1);return count<100;});}
 export(channel){return Object.values(this.data.messages).filter(m=>m.channel===channel&&!m.deleted&&(m.rows.length||m.notices.length)).sort((a,b)=>Date.parse(a.rows[0]?.postedAt||a.updatedAt)-Date.parse(b.rows[0]?.postedAt||b.updatedAt)).map(m=>m.chat).join('\n');}
}
