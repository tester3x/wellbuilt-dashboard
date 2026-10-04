import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {unzipSync,strFromU8} from 'fflate';
import QRCode from 'qrcode';
import {Queue,header,hash,newestReceiverMessages} from './core.mjs';
import {Transport} from './transport.mjs';
const require=createRequire(import.meta.url);
const {splitChat,parsePullChat}=require('../../functions/lib/imports/pullParser.js');
const root=path.dirname(fileURLToPath(import.meta.url));
const directory=process.env.WBC_WATCHDOG_DATA||path.join(process.env.LOCALAPPDATA||process.cwd(),'WellBuilt','WhatsAppWatchdog');
const queue=new Queue(directory);const transport=new Transport(queue);transport.configure();
const deliveryTimer=setInterval(()=>void transport.tick(paused),10000);deliveryTimer.unref();
const token=randomBytes(32).toString('hex');
const configFile=path.join(directory,'channels.json');
let channels=existsSync(configFile)?JSON.parse(readFileSync(configFile,'utf8')):[];
for(const m of Object.values(queue.data.messages)){const selected=channels.find(c=>c.id===m.channel);if(selected&&!m.deleted&&!m.id.startsWith('export:'))m.rows=parsePullChat(m.chat,selected.options).map(r=>({...r,id:m.key+':'+r.id}));}// Recheck only parser-only holds after a parser upgrade; completed deliveries stay intact.
for(const message of Object.values(queue.data.messages))for(const row of message.rows){const delivery=queue.data.deliveries?.[row.id];if(!row.issues.length&&delivery?.status==='review'&&!delivery.identity&&delivery.issues?.length===1&&delivery.issues[0]==='Unreadable levels')delete queue.data.deliveries[row.id];}
queue.save();
let client=null,qr='',state='Stopped',paused=true,error='',chats=[],loadingGroups=false;
async function loadGroups(){if(loadingGroups||!client||!['Connected','Syncing WhatsApp'].includes(state))throw Error('WhatsApp is not connected yet. Current state: '+state);loadingGroups=true;try{let available;try{available=await Promise.race([client.getChats(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Chat list timed out')),8000))]);}catch{available=await client.pupPage.evaluate(()=>window.require('WAWebCollections').Chat.getModelsArray().filter(c=>c.id?.server==='g.us').map(c=>({id:{_serialized:c.id._serialized},name:c.name||c.formattedTitle||c.id._serialized,isGroup:true})));}chats=available.filter(c=>c.isGroup||c.id?._serialized?.endsWith('@g.us')).map(c=>({id:c.id._serialized,name:c.name||c.id._serialized}));error=chats.length?'':'WhatsApp is syncing groups; retrying shortly.';}catch(e){error='Group list is not ready; retrying shortly. '+String(e?.message||e);}finally{loadingGroups=false;}}
const groupRetry=setInterval(()=>{if(['Connected','Syncing WhatsApp'].includes(state)&&!chats.length)void loadGroups().catch(e=>{error=e.message;});},10000);groupRetry.unref();
let polling=false,lastReceiverCheck='',receiverMode='Starting',receiverGroups=[];
async function pollReceiver(){
 if(polling||!client||!['Syncing WhatsApp','Connected'].includes(state))return;
 polling=true;
 try{
 const result=await client.pupPage.evaluate(async ids=>{
  const connection=window.AuthStore?.AppState?.state;
  if(connection!=='CONNECTED')throw Error('WhatsApp connection: '+connection);
  const models=window.require('WAWebCollections').Chat.getModelsArray();
  const groups=models.filter(c=>c.id?.server==='g.us');
  const collection=window.require('WAWebCollections').Msg;
  const globalMessages=collection.getModelsArray();
  // Listen before library ready: capture additions, decrypted bodies, edits and revokes.
  if(!window.__wellBuiltRawMessages){window.__wellBuiltRawMessages=[];const remember=m=>{window.__wellBuiltRawMessages.push(m);if(window.__wellBuiltRawMessages.length>500)window.__wellBuiltRawMessages.shift();};collection.on('add',remember);collection.on('change:body',remember);collection.on('change:type',remember);}
  const received=[...globalMessages,...window.__wellBuiltRawMessages];
  const extra=new Map();
  for(const chat of groups.filter(c=>ids.includes(c.id._serialized))){if(!window.__wellBuiltBackfilled?.includes(chat.id._serialized)||!chat.msgs.getModelsArray().some(m=>typeof m.body==='string'&&m.body.length)){window.__wellBuiltBackfilled??=[];window.__wellBuiltBackfilled.push(chat.id._serialized);const loaded=await window.require('WAWebChatLoadMessages').loadEarlierMsgs({chat});extra.set(chat.id._serialized,Array.isArray(loaded)?loaded:[]);}}
  const diagnostics=groups.filter(c=>ids.includes(c.id._serialized)).map(c=>({id:c.id._serialized,loaded:c.msgs.getModelsArray().length,extra:(extra.get(c.id._serialized)||[]).length,eligible:[...c.msgs.getModelsArray(),...received.filter(m=>m.id?.remote?._serialized===c.id._serialized),...(extra.get(c.id._serialized)||[])].filter(m=>typeof m.body==='string'&&(m.id?._serialized||m.id?.id)&&Number.isFinite(Number(m.t))).length}));
  const messages=groups.filter(c=>ids.includes(c.id._serialized)).flatMap(c=>[...c.msgs.getModelsArray(),...received.filter(m=>m.id?.remote?._serialized===c.id._serialized),...(extra.get(c.id._serialized)||[])].filter(m=>typeof m.body==='string'&&(m.id?._serialized||m.id?.id)&&Number.isFinite(Number(m.t))).map(m=>({id:m.id._serialized||m.id.id,channel:c.id._serialized,timestamp:Number(m.t),author:m.notifyName||m.author?._serialized||m.from?._serialized||'Driver',body:typeof m.body==='string'?m.body:'',deleted:m.type==='revoked'})));
  return {diagnostics,groups:groups.map(c=>({id:c.id._serialized,name:c.name||c.formattedTitle||c.id._serialized})),messages};
 },paused?[]:channels.map(c=>c.id));
 chats=result.groups;receiverGroups=result.diagnostics;lastReceiverCheck=new Date().toISOString();receiverMode='Polling synced messages';state='Connected';error='';
 if(!paused)for(const m of newestReceiverMessages(result.messages)){const selected=channels.find(c=>c.id===m.channel);if(selected)queue.ingest({id:m.id,channel:m.channel,chat:header(m.timestamp*1000,m.author,m.body),options:selected.options,deleted:m.deleted});}
 }catch(e){error='Receiver not ready: '+String(e?.message||e);if(state==='Connected')state='Syncing WhatsApp';}
 finally{polling=false;}
}
const receiverTimer=setInterval(()=>void pollReceiver(),4000);receiverTimer.unref();
function status(){return {state,paused,error,qr,channels,chats,receiverMode,lastReceiverCheck,receiverGroups,transportStatus:transport.status,enabledAt:transport.config?.enabledAt,deliveries:queue.data.deliveries||{},livePosts:queue.liveFeed(channels.map(c=>c.id)),...queue.snapshot()};}
function respond(res,code,value,type='application/json'){res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(type==='application/json'?JSON.stringify(value):value);}
async function capture(m,deleted=false){if(paused)return;const channelId=m.fromMe?m.to:m.from;const configured=channels.find(c=>c.id===channelId);if(!configured)return;queue.ingest({id:m.id._serialized||m.id.id,channel:configured.id,chat:header(m.timestamp*1000,m.author||m.from,m.body||''),options:configured.options,deleted});}
async function connect(){if(client)return;const {Client,LocalAuth}=require('whatsapp-web.js');
 client=new Client({authStrategy:new LocalAuth({dataPath:path.join(directory,'session')}),puppeteer:{headless:true,executablePath:process.env.WBC_CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'}});
 state='Connecting';error='';
 client.on('qr',async code=>{qr=await QRCode.toDataURL(code);state='Scan QR';});
 client.on('authenticated',()=>{state='Syncing WhatsApp';setTimeout(()=>{if(state==='Syncing WhatsApp')error='Signed in, but the WhatsApp receiver has not finished starting. Live capture is unavailable.';},60000).unref();});
 client.on('ready',async()=>{qr='';state='Connected';await loadGroups();});
 client.on('auth_failure',()=>{state='Authentication failed';error='Relink WhatsApp using QR.';});
 client.on('disconnected',()=>{state='Disconnected';paused=true;qr='';});
 const receive=m=>capture(m).catch(e=>{error=e.message;paused=true;});
 client.on('message_create',receive);client.on('message_edit',receive);
 client.on('message_revoke_everyone',(after,before)=>capture(before||after,true).catch(e=>{error=e.message;paused=true;}));
 client.initialize().catch(e=>{error=e.message;state='Connection failed';});
}
const server=http.createServer(async(req,res)=>{try{
 if(!['127.0.0.1:8791','localhost:8791'].includes(req.headers.host))return respond(res,403,{error:'Invalid host'});
 const url=new URL(req.url,'http://127.0.0.1:8791');
 if(req.method==='GET'&&url.pathname==='/')return respond(res,200,readFileSync(path.join(root,'index.html'),'utf8'),'text/html');
 if(req.method==='GET'&&url.pathname==='/app.js')return respond(res,200,readFileSync(path.join(root,'app.js'),'utf8').replace('__TOKEN__',token),'text/javascript');
 if(req.method==='GET'&&url.pathname==='/style.css')return respond(res,200,readFileSync(path.join(root,'style.css'),'utf8'),'text/css');
 if(req.headers['x-watchdog-token']!==token)return respond(res,403,{error:'Unauthorized'});
 if(req.method==='GET'&&url.pathname==='/status')return respond(res,200,status());
 if(req.method==='GET'&&url.pathname==='/export')return respond(res,200,queue.export(url.searchParams.get('channel')),'text/plain; charset=utf-8');
 if(req.method!=='POST')return respond(res,404,{error:'Not found'});
 if(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:8791'&&req.headers.origin!=='http://localhost:8791')return respond(res,403,{error:'Invalid origin'});
 let chunks=[],length=0;for await(const chunk of req){length+=chunk.length;if(length>10000000)return respond(res,413,{error:'File exceeds 10 MB'});chunks.push(chunk);}const bytes=Buffer.concat(chunks);
 if(url.pathname==='/refresh-groups'){await loadGroups();return respond(res,200,{ok:true});}
 if(url.pathname==='/connect'){await connect();return respond(res,200,{ok:true});}
 if(url.pathname==='/stop'){paused=true;state='Stopped';if(client){const old=client;client=null;await old.destroy();}return respond(res,200,{ok:true});}
 if(url.pathname==='/pause'){paused=true;return respond(res,200,{ok:true});}
 if(url.pathname==='/resume'){if(!client||state!=='Connected')throw Error('Connect WhatsApp first');if(!channels.length)throw Error('Choose channels first');paused=false;await pollReceiver();if(paused)throw Error(error||'Receiver not ready');return respond(res,200,{ok:true});}
 if(url.pathname==='/channels'){const value=JSON.parse(bytes);if(!Array.isArray(value)||value.length>20)throw Error('Invalid channels');channels=value.map(c=>{if(!chats.some(chat=>chat.id===c.id))throw Error('Choose an available group');return {id:c.id,name:chats.find(chat=>chat.id===c.id).name,options:{defaultWell:typeof c.defaultWell==='string'?c.defaultWell:'',defaultBbls:c.defaultBbls===165?165:undefined}};});writeFileSync(configFile,JSON.stringify(channels),{mode:0o600});return respond(res,200,{ok:true});}
 if(url.pathname==='/replay'){let text;if(bytes[0]===80&&bytes[1]===75){let total=0,count=0;const entries=unzipSync(bytes,{filter:f=>{count++;total+=f.originalSize;if(count>1000||total>2000000)throw Error('Export exceeds 2 MB expanded size');return /\.txt$/i.test(f.name);}});const values=Object.values(entries);if(values.length!==1)throw Error('ZIP needs exactly one TXT chat');text=strFromU8(values[0]);}else text=bytes.toString('utf8');if(text.length>2000000)throw Error('Chat exceeds 2 MB');const channel=url.searchParams.get('channel')||'Sample';const options={defaultWell:url.searchParams.get('well')||'',defaultBbls:url.searchParams.get('default165')==='true'?165:undefined};let added=0,duplicates=0;for(const m of splitChat(text)){const chat=`[${m.date}, ${m.time}] ${m.author}: ${m.body}`;const result=queue.ingest({channel,id:'export:'+hash(chat),chat,options});result.duplicate?duplicates++:added++;}return respond(res,200,{added,duplicates});}
 return respond(res,404,{error:'Not found'});
 }catch(e){respond(res,400,{error:e.message});}});
server.listen(8791,'127.0.0.1',()=>console.log('WellBuilt Watchdog: http://127.0.0.1:8791 (capture/review only)'));
async function shutdown(){paused=true;if(client)await client.destroy();server.close(()=>process.exit(0));}process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
