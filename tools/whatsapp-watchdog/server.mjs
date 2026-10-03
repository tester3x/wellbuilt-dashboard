import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {unzipSync,strFromU8} from 'fflate';
import QRCode from 'qrcode';
import {Queue,header,hash} from './core.mjs';
const require=createRequire(import.meta.url);
const {splitChat}=require('../../functions/lib/imports/pullParser.js');
const root=path.dirname(fileURLToPath(import.meta.url));
const directory=process.env.WBC_WATCHDOG_DATA||path.join(process.env.LOCALAPPDATA||process.cwd(),'WellBuilt','WhatsAppWatchdog');
const queue=new Queue(directory), token=randomBytes(32).toString('hex');
const configFile=path.join(directory,'channels.json');
let channels=existsSync(configFile)?JSON.parse(readFileSync(configFile,'utf8')):[];
let client=null,qr='',state='Stopped',paused=true,error='',chats=[],loadingGroups=false;
async function loadGroups(){if(loadingGroups||!client||state!=='Connected')return;loadingGroups=true;try{let available;try{available=await client.getChats();}catch{available=await client.pupPage.evaluate(()=>window.require('WAWebCollections').Chat.getModelsArray().filter(c=>c.id?.server==='g.us').map(c=>({id:{_serialized:c.id._serialized},name:c.name||c.formattedTitle||c.id._serialized,isGroup:true})));}chats=available.filter(c=>c.isGroup||c.id?._serialized?.endsWith('@g.us')).map(c=>({id:c.id._serialized,name:c.name||c.id._serialized}));error=chats.length?'':'WhatsApp is syncing groups; retrying shortly.';}catch(e){error='Group list is not ready; retrying shortly. '+String(e?.message||e);}finally{loadingGroups=false;}}
const groupRetry=setInterval(()=>{if(state==='Connected'&&!chats.length)void loadGroups();},10000);groupRetry.unref();
function status(){return {state,paused,error,qr,channels,chats,...queue.snapshot()};}
function respond(res,code,value,type='application/json'){res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(type==='application/json'?JSON.stringify(value):value);}
async function capture(m,deleted=false){if(paused)return;const channelId=m.fromMe?m.to:m.from;const configured=channels.find(c=>c.id===channelId);if(!configured)return;queue.ingest({id:m.id._serialized,channel:configured.id,chat:header(m.timestamp*1000,m.author||m.from,m.body||''),options:configured.options,deleted});}
async function connect(){if(client)return;const {Client,LocalAuth}=require('whatsapp-web.js');
 client=new Client({authStrategy:new LocalAuth({dataPath:path.join(directory,'session')}),puppeteer:{headless:true,executablePath:process.env.WBC_CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'}});
 state='Connecting';error='';
 client.on('qr',async code=>{qr=await QRCode.toDataURL(code);state='Scan QR';});
 client.on('authenticated',()=>{state='Syncing WhatsApp';});
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
 if(url.pathname==='/resume'){if(!client||state!=='Connected')throw Error('Connect WhatsApp first');if(!channels.length)throw Error('Choose channels first');paused=false;try{for(const configured of channels){const chat=await client.getChatById(configured.id);const messages=await chat.fetchMessages({limit:100});for(const m of messages.sort((a,b)=>a.timestamp-b.timestamp))await capture(m);}}catch(e){paused=true;throw e;}return respond(res,200,{ok:true});}
 if(url.pathname==='/channels'){const value=JSON.parse(bytes);if(!Array.isArray(value)||value.length>20)throw Error('Invalid channels');channels=value.map(c=>{if(!chats.some(chat=>chat.id===c.id))throw Error('Choose an available group');return {id:c.id,name:chats.find(chat=>chat.id===c.id).name,options:{defaultWell:typeof c.defaultWell==='string'?c.defaultWell:'',defaultBbls:c.defaultBbls===165?165:undefined}};});writeFileSync(configFile,JSON.stringify(channels),{mode:0o600});return respond(res,200,{ok:true});}
 if(url.pathname==='/replay'){let text;if(bytes[0]===80&&bytes[1]===75){let total=0,count=0;const entries=unzipSync(bytes,{filter:f=>{count++;total+=f.originalSize;if(count>1000||total>2000000)throw Error('Export exceeds 2 MB expanded size');return /\.txt$/i.test(f.name);}});const values=Object.values(entries);if(values.length!==1)throw Error('ZIP needs exactly one TXT chat');text=strFromU8(values[0]);}else text=bytes.toString('utf8');if(text.length>2000000)throw Error('Chat exceeds 2 MB');const channel=url.searchParams.get('channel')||'Sample';const options={defaultWell:url.searchParams.get('well')||'',defaultBbls:url.searchParams.get('default165')==='true'?165:undefined};let added=0,duplicates=0;for(const m of splitChat(text)){const chat=`[${m.date}, ${m.time}] ${m.author}: ${m.body}`;const result=queue.ingest({channel,id:'export:'+hash(chat),chat,options});result.duplicate?duplicates++:added++;}return respond(res,200,{added,duplicates});}
 return respond(res,404,{error:'Not found'});
 }catch(e){respond(res,400,{error:e.message});}});
server.listen(8791,'127.0.0.1',()=>console.log('WellBuilt Watchdog: http://127.0.0.1:8791 (capture/review only)'));
async function shutdown(){paused=true;if(client)await client.destroy();server.close(()=>process.exit(0));}process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
