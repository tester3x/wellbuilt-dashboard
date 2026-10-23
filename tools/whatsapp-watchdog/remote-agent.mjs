import {createServer} from 'node:net';
import {mkdirSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Transport} from './transport.mjs';
import {RecoveryAgent,healthSummary} from './remote-agent-core.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const directory=process.env.WBC_WATCHDOG_DATA||path.join(process.env.LOCALAPPDATA,'WellBuilt','WhatsAppWatchdog');
mkdirSync(directory,{recursive:true});
// Separate loopback singleton: never shares or writes the receiver's queue.
const singleton=createServer(socket=>socket.end());
singleton.on('error',error=>{console.error('Remote helper unavailable: '+error.code);process.exitCode=1;});
singleton.listen(8792,'127.0.0.1',async()=>{
 const transport=new Transport({directory});transport.configure();if(!transport.secret||!transport.config?.enabled){singleton.close();throw Error('Existing Watchdog signing configuration required');}
 async function local(endpoint,method='GET'){
  const origin='http://127.0.0.1:8791';
  const script=await (await fetch(origin+'/app.js',{signal:AbortSignal.timeout(4000)})).text();
  const token=/let token='([^']+)'/.exec(script)?.[1];if(!token)throw Error('Watchdog local credential unavailable');
  const response=await fetch(origin+endpoint,{method,headers:{'x-watchdog-token':token,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{}),signal:AbortSignal.timeout(45000)});
  if(!response.ok)throw Error('Watchdog action HTTP '+response.status);
  const result=await response.json();if(result.error)throw Error(result.error);return result;
 }
 const agent=new RecoveryAgent({directory,sync:body=>transport.request('syncWatchdogAgentV2',body),health:async()=>{try{return healthSummary(await local('/status'));}catch{return healthSummary(null);}},execute:async action=>{
  if(action==='restart_worker'){
   await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'restart-watchdog-worker.ps1')],{windowsHide:true,timeout:45000});return;
  }
  const routes={refresh:'/refresh-groups',reconnect:'/connect',retry_pending:'/retry-pending',resume:'/resume'};
  await local(routes[action],'POST');
 }});
 let delay=60000;
 async function poll(){try{await agent.tick();delay=60000;}catch(e){console.error(new Date().toISOString()+' remote health: '+String(e.message).slice(0,300));delay=Math.min(300000,Math.max(60000,delay*2));}setTimeout(poll,delay);}
 await poll();
});
