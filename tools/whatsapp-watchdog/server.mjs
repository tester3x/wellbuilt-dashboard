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
import {ReviewAlerts} from './alerts.mjs';
import {RemoteReviews} from './remote-review.mjs';
const require=createRequire(import.meta.url);
const {splitChat,parsePullChat,chatTimestamp}=require('../../functions/lib/imports/pullParser.js');
const root=path.dirname(fileURLToPath(import.meta.url));
const directory=process.env.WBC_WATCHDOG_DATA||path.join(process.env.LOCALAPPDATA||process.cwd(),'WellBuilt','WhatsAppWatchdog');
const queue=new Queue(directory);const transport=new Transport(queue);transport.configure();
const deliveryTimer=setInterval(()=>void transport.tick(paused),10000);deliveryTimer.unref();
const token=randomBytes(32).toString('hex');
const configFile=path.join(directory,'channels.json');
let channels=existsSync(configFile)?JSON.parse(readFileSync(configFile,'utf8')):[];
queue.save();
let client=null,qr='',state='Stopped',paused=true,error='',chats=[],loadingGroups=false;
async function loadGroups(){if(loadingGroups||!client||!['Connected','Syncing WhatsApp'].includes(state))throw Error('WhatsApp is not connected yet. Current state: '+state);loadingGroups=true;try{let available;try{available=await Promise.race([client.getChats(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Chat list timed out')),8000))]);}catch{available=await client.pupPage.evaluate(()=>window.require('WAWebCollections').Chat.getModelsArray().filter(c=>c.id?.server==='g.us').map(c=>({id:{_serialized:c.id._serialized},name:c.name||c.formattedTitle||c.id._serialized,isGroup:true})));}chats=available.filter(c=>c.isGroup||c.id?._serialized?.endsWith('@g.us')).map(c=>({id:c.id._serialized,name:c.name||c.id._serialized}));error=chats.length?'':'WhatsApp is syncing groups; retrying shortly.';}catch(e){error='Group list is not ready; retrying shortly. '+String(e?.message||e);}finally{loadingGroups=false;}}
const groupRetry=setInterval(()=>{if(['Connected','Syncing WhatsApp'].includes(state)&&!chats.length)void loadGroups().catch(e=>{error=e.message;});},10000);groupRetry.unref();
let polling=false,lastReceiverCheck='',receiverMode='Starting',receiverGroups=[];
async function pollReceiver(){
 transport.channelOptions=Object.fromEntries(channels.map(c=>[c.id,c.options]));
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
  const messages=groups.filter(c=>ids.includes(c.id._serialized)).flatMap(c=>[...c.msgs.getModelsArray(),...received.filter(m=>m.id?.remote?._serialized===c.id._serialized),...(extra.get(c.id._serialized)||[])].filter(m=>typeof m.body==='string'&&(m.id?._serialized||m.id?.id)&&Number.isFinite(Number(m.t))).map(m=>({id:m.id._serialized||m.id.id,channel:c.id._serialized,timestamp:Number(m.t),senderId:(typeof m.id?.participant==='string'?m.id.participant:m.id?.participant?._serialized)||(typeof m.author==='string'?m.author:m.author?._serialized)||null,author:m.notifyName||m.author?._serialized||m.from?._serialized||'Driver',body:typeof m.body==='string'?m.body:'',deleted:m.type==='revoked'})));
  return {diagnostics,groups:groups.map(c=>({id:c.id._serialized,name:c.name||c.formattedTitle||c.id._serialized})),messages};
 },paused?[]:channels.map(c=>c.id));
 chats=result.groups;receiverGroups=result.diagnostics;lastReceiverCheck=new Date().toISOString();receiverMode='Polling synced messages';state='Connected';error='';
 if(!paused)for(const m of newestReceiverMessages(result.messages)){const selected=channels.find(c=>c.id===m.channel);if(selected)queue.ingest({id:m.id,channel:m.channel,chat:header(m.timestamp*1000,m.author,m.body),options:{...selected.options,wellNames:(transport.wells||[]).filter(w=>w.channels?.includes(selected.id)).map(w=>w.wellName)},deleted:m.deleted,senderId:m.senderId});}
 }catch(e){error='Receiver not ready: '+String(e?.message||e);if(state==='Connected')state='Syncing WhatsApp';}
 finally{polling=false;}
}
const remoteReviews=new RemoteReviews(queue,transport);
const remoteReviewTimer=setInterval(()=>{if(!paused&&queue.data.remoteReviewsEnabled===true)void remoteReviews.tick(channels);},30000);remoteReviewTimer.unref();
const alerts=new ReviewAlerts(queue);
const alertTimer=setInterval(()=>{if(client&&state==='Connected'&&!paused)void alerts.tick((id,body)=>client.sendMessage(id,body),Object.fromEntries(channels.map(c=>[c.id,c.name])));},10000);alertTimer.unref();
const receiverTimer=setInterval(()=>void pollReceiver(),4000);receiverTimer.unref();
function status(){return {reviewCorrectionsEnabled:true,remoteReviewError:remoteReviews.error,reviewAlerts:{enabled:!!queue.data.reviewAlerts?.enabled,groupId:queue.data.reviewAlerts?.groupId||'',lastSentAt:queue.data.reviewAlerts?.lastSentAt||null,error:alerts.error},state,paused,error,qr,channels,chats,receiverMode,lastReceiverCheck,receiverGroups,transportStatus:transport.status,wellLifecycle:transport.wells||[],enabledAt:transport.config?.enabledAt,deliveries:queue.data.deliveries||{},livePosts:queue.liveFeed(channels.map(c=>c.id)),...queue.snapshot()};}
function respond(res,code,value,type='application/json'){res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(type==='application/json'?JSON.stringify(value):value);}
async function capture(m,deleted=false){if(paused)return;const channelId=m.fromMe?m.to:m.from;const configured=channels.find(c=>c.id===channelId);if(!configured)return;queue.ingest({id:m.id._serialized||m.id.id,channel:configured.id,chat:header(m.timestamp*1000,m.author||m.from,m.body||''),options:configured.options,deleted,senderId:m.id?.participant?._serialized||m.author||null});}
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
 if(req.method==='GET'&&url.pathname==='/review-alert-history'){const group=queue.data.reviewAlerts?.groupId;if(!client||state!=='Connected'||!group)throw Error('Alert history unavailable');const messages=await client.pupPage.evaluate(id=>{const collections=window.require('WAWebCollections');const chat=collections.Chat.getModelsArray().find(c=>c.id?._serialized===id);const all=[...(chat?.msgs?.getModelsArray?.()||[]),...collections.Msg.getModelsArray().filter(m=>m.id?.remote?._serialized===id)];return Array.from(new Map(all.map(m=>[m.id._serialized,m])).values()).sort((a,b)=>Number(a.t)-Number(b.t)).slice(-100).map(m=>({id:m.id._serialized,at:new Date(Number(m.t)*1000).toISOString(),fromMe:!!m.id.fromMe,body:typeof m.body==='string'?m.body:''}));},group);return respond(res,200,{messages,scope:'currently_synced'});}
 if(req.method==='GET'&&url.pathname==='/export')return respond(res,200,queue.export(url.searchParams.get('channel')),'text/plain; charset=utf-8');
 if(req.method!=='POST')return respond(res,404,{error:'Not found'});
 if(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:8791'&&req.headers.origin!=='http://localhost:8791')return respond(res,403,{error:'Invalid origin'});
 let chunks=[],length=0;for await(const chunk of req){length+=chunk.length;if(length>10000000)return respond(res,413,{error:'File exceeds 10 MB'});chunks.push(chunk);}const bytes=Buffer.concat(chunks);
 if(url.pathname==='/stop-well'){const value=JSON.parse(bytes);if(typeof value.wellName!=='string'||typeof value.reason!=='string')throw Error('Choose a well and enter a reason');const result=await transport.stopWell(value.wellName,value.reason);return respond(res,200,result);}
 if(url.pathname==='/well-lifecycle'){return respond(res,200,await transport.lifecycle());}
 if(url.pathname==='/remote-reviews'){const value=JSON.parse(bytes);if(typeof value.enabled!=='boolean')throw Error('Invalid remote review setting');queue.data.remoteReviewsEnabled=value.enabled;queue.save();return respond(res,200,{ok:true});}
 if(url.pathname==='/overlord-message'){const value=JSON.parse(bytes),group=queue.data.reviewAlerts?.groupId;if(!client||state!=='Connected'||!group||typeof value.text!=='string'||value.text.length<1||value.text.length>3000)throw Error('Alert destination unavailable or invalid message');await client.sendMessage(group,value.text);return respond(res,200,{ok:true});}
 if(url.pathname==='/review-alerts'){const value=JSON.parse(bytes);if(typeof value.enabled!=='boolean'||(value.enabled&&!chats.some(c=>c.id===value.groupId)))throw Error('Choose an available alert group');if(value.enabled&&channels.some(c=>c.id===value.groupId))throw Error('Choose an alert-only group, not a watched route');queue.data.reviewAlerts={...queue.data.reviewAlerts,enabled:value.enabled,groupId:value.groupId||queue.data.reviewAlerts?.groupId||''};queue.save();return respond(res,200,{ok:true});}
 if(url.pathname==='/review'){const value=JSON.parse(bytes);if(typeof value.rowId!=='string'||!['confirm','exclude'].includes(value.decision)||typeof value.reason!=='string'||(value.decision==='exclude'&&value.reason.trim().length<3)||value.reason.length>300)throw Error('Enter a review reason');let at;if(value.decision==='confirm'){if(typeof value.time!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value.time))throw Error('Choose a valid measurement time');const [date,time]=value.time.split('T');const [y,m,d]=date.split('-');at=chatTimestamp(m+'/'+d+'/'+y,time);}await transport.review(value.rowId,value.decision,at,value.reason.trim(),value.corrections||{});return respond(res,200,{ok:true});}
 if(url.pathname==='/refresh-groups'){await loadGroups();return respond(res,200,{ok:true});}
 if(url.pathname==='/connect'){await connect();return respond(res,200,{ok:true});}
 if(url.pathname==='/stop'){paused=true;state='Stopped';if(client){const old=client;client=null;await old.destroy();}return respond(res,200,{ok:true});}
 if(url.pathname==='/pause'){paused=true;return respond(res,200,{ok:true});}
 if(url.pathname==='/resume'){if(!client||state!=='Connected')throw Error('Connect WhatsApp first');if(!channels.length)throw Error('Choose channels first');paused=false;await pollReceiver();if(paused)throw Error(error||'Receiver not ready');return respond(res,200,{ok:true});}
 if(url.pathname==='/barrel-policy'){
 const value=JSON.parse(bytes);const selected=channels.find(c=>c.id===value.channel);if(!selected)throw Error('Choose a watched group');
 await transport.request('setWatchdogBarrelPolicyV2',value);
 selected.options={...selected.options,maxLoadBbls:value.maxLoadBbls,driverCapacities:value.driverCapacities,wellLoadLimits:value.wellLoadLimits};
 writeFileSync(configFile,JSON.stringify(channels),{mode:0o600});transport.channelOptions=Object.fromEntries(channels.map(c=>[c.id,c.options]));
 return respond(res,200,{ok:true});
 }
 if(url.pathname==='/channels'){const value=JSON.parse(bytes);if(!Array.isArray(value)||value.length>20)throw Error('Invalid channels');channels=value.map(c=>{if(!chats.some(chat=>chat.id===c.id))throw Error('Choose an available group');return {id:c.id,name:chats.find(chat=>chat.id===c.id).name,options:{...channels.find(saved=>saved.id===c.id)?.options,driverDefaultBbls:channels.find(saved=>saved.id===c.id)?.options?.driverDefaultBbls||{},defaultWell:typeof c.defaultWell==='string'?c.defaultWell:'',defaultBbls:c.defaultBbls===undefined?undefined:(Number.isFinite(c.defaultBbls)&&c.defaultBbls>0&&c.defaultBbls<=1000?c.defaultBbls:(()=>{throw Error('Missing barrels fallback must be greater than 0 and at most 1000');})())}};});writeFileSync(configFile,JSON.stringify(channels),{mode:0o600});transport.channelOptions=Object.fromEntries(channels.map(c=>[c.id,c.options]));queue.reparseChannels(Object.fromEntries(channels.map(c=>[c.id,{...c.options,wellNames:(transport.wells||[]).filter(w=>w.channels?.includes(c.id)).map(w=>w.wellName)}])));return respond(res,200,{ok:true});}
 if(url.pathname==='/replay'){let text;if(bytes[0]===80&&bytes[1]===75){let total=0,count=0;const entries=unzipSync(bytes,{filter:f=>{count++;total+=f.originalSize;if(count>1000||total>2000000)throw Error('Export exceeds 2 MB expanded size');return /\.txt$/i.test(f.name);}});const values=Object.values(entries);if(values.length!==1)throw Error('ZIP needs exactly one TXT chat');text=strFromU8(values[0]);}else text=bytes.toString('utf8');if(text.length>2000000)throw Error('Chat exceeds 2 MB');const channel=url.searchParams.get('channel')||'Sample';const options={defaultWell:url.searchParams.get('well')||'',defaultBbls:url.searchParams.get('default165')==='true'?165:undefined};let added=0,duplicates=0;for(const m of splitChat(text)){const chat=`[${m.date}, ${m.time}] ${m.author}: ${m.body}`;const result=queue.ingest({channel,id:'export:'+hash(chat),chat,options});result.duplicate?duplicates++:added++;}return respond(res,200,{added,duplicates});}
 return respond(res,404,{error:'Not found'});
 }catch(e){respond(res,400,{error:e.message});}});
server.listen(8791,'127.0.0.1',()=>console.log('WellBuilt Watchdog: http://127.0.0.1:8791 (capture/review only)'));
async function shutdown(){paused=true;if(client)await client.destroy();server.close(()=>process.exit(0));}process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
