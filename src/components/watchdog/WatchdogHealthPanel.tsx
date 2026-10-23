'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {httpsCallable} from 'firebase/functions';
import {getFirebaseFunctions} from '@/lib/firebase';

type Command={id:string;action:string;state:string;error:string;expiresAt:number};
export type AgentHealth={installed:boolean;seenAt:number|null;stale:boolean;serverTime:number;canRecover:boolean;command:Command|null;health:{workerReachable:boolean;state:string;paused:boolean;lastReceiverCheck:string;transportStatus:string;pending:number;reviews:number;channels:number;error:string}|null};
const loadHealth=async(companyId:string)=>(await httpsCallable<{companyId:string},AgentHealth>(getFirebaseFunctions(),'getWatchdogAgentHealth',{timeout:15000})({companyId})).data;
const sendRecovery=async(payload:{companyId:string;action:string;requestId:string;reason:string})=>{await httpsCallable(getFirebaseFunctions(),'requestWatchdogRecovery',{timeout:15000})(payload);};
const actions=[['refresh','Refresh receiver'],['reconnect','Reconnect WhatsApp'],['retry_pending','Retry pending work'],['resume','Resume watching'],['restart_worker','Restart Watchdog']] as const;
export function WatchdogHealthPanel({companyId,load=loadHealth,send=sendRecovery}:{companyId:string;load?:(companyId:string)=>Promise<AgentHealth>;send?:(payload:{companyId:string;action:string;requestId:string;reason:string})=>Promise<void>}){
 const [data,setData]=useState<AgentHealth|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[reason,setReason]=useState('');
 const generation=useRef(0),mounted=useRef(false),inFlight=useRef(false);
 const refresh=useCallback(async()=>{
  if(!mounted.current||inFlight.current)return;
  const epoch=generation.current;inFlight.current=true;setBusy(true);setError('');
  try{const result=await load(companyId);if(mounted.current&&generation.current===epoch)setData(result);}
  catch(e){if(mounted.current&&generation.current===epoch)setError((e as Error).message);}
  finally{if(mounted.current&&generation.current===epoch){inFlight.current=false;setBusy(false);}}
 },[companyId,load]);
 useEffect(()=>{mounted.current=true;generation.current++;inFlight.current=false;setData(null);setMessage('');setReason('');void refresh();return()=>{mounted.current=false;generation.current++;};},[refresh]);
 async function recover(action:string){
  if(inFlight.current||!data?.canRecover||!data.installed||reason.trim().length<3)return;
  const epoch=generation.current;inFlight.current=true;setBusy(true);setError('');setMessage('');
  try{
   await send({companyId,action,requestId:crypto.randomUUID(),reason:reason.trim()});
   const updated=await load(companyId);
   if(mounted.current&&generation.current===epoch){setMessage('Recovery request saved. Refresh status to check the HP’s result. Requests expire after 10 minutes.');setData(updated);}
  }catch(e){if(mounted.current&&generation.current===epoch)setError((e as Error).message);}
  finally{if(mounted.current&&generation.current===epoch){inFlight.current=false;setBusy(false);}}
 }
 const health=data?.health,pending=data?.command?.state==='pending'&&data.command.expiresAt>data.serverTime;
 const receiverStale=health?.workerReachable&&health.state==='Connected'&&(!Date.parse(health.lastReceiverCheck)||data!.serverTime-Date.parse(health.lastReceiverCheck)>180000);
 return <section aria-label="Watchdog remote health" className="rounded-lg border border-gray-600 bg-gray-900 p-4 space-y-3">
  <div className="flex justify-between items-center gap-3"><h2 className="text-xl font-bold">HP Watchdog health</h2><button type="button" disabled={busy} onClick={()=>void refresh()} className="rounded bg-gray-700 px-3 py-2 disabled:opacity-50">{busy?'Checking HP...':'Refresh HP status'}</button></div>
  {error&&<p role="alert" className="text-red-300">{error}</p>}
  {data&&!data.installed?<p>Remote helper is ready to install on the HP. No heartbeat has been received yet.</p>:data&&<>
   <p className={data.stale?'text-yellow-300':'text-green-400'}>{data.stale?'HP helper has not checked in recently.':'HP helper is online.'} Last heartbeat: {data.seenAt?new Date(data.seenAt).toLocaleString():'None'}.</p>
   {health&&<><p>Watchdog: {health.workerReachable?health.state:'Worker unavailable'}{health.paused?' · Paused':''}{receiverStale?' · Receiver check is overdue':''}</p>
    <p>{health.channels} watched chats · {health.pending} pending updates · {health.reviews} reviews</p>
    <p>Delivery: {health.transportStatus}</p>
    {health.lastReceiverCheck&&<p>Last WhatsApp check: {new Date(health.lastReceiverCheck).toLocaleString()}</p>}
    {health.error&&<p className="text-yellow-300">{health.error}</p>}
    {/Scan QR|Authentication failed/i.test(health.state)&&<p>WhatsApp needs to be linked again on the HP.</p>}
   </>}
  </>}
  {data?.command&&<p role="status">Last recovery: {actions.find(([action])=>action===data.command!.action)?.[1]||data.command.action} — {data.command.state}{data.command.error?': '+data.command.error:''}</p>}
  {data?.canRecover&&<>
   <label className="block">Recovery reason<input aria-label="Recovery reason" value={reason} maxLength={300} onChange={e=>setReason(e.target.value)} className="block w-full rounded border border-gray-600 bg-gray-800 p-2"/></label>
   <div className="flex flex-wrap gap-2">{actions.map(([action,label])=><button type="button" key={action} disabled={busy||!!error||!data.installed||!!pending||reason.trim().length<3} onClick={()=>void recover(action)} className="rounded bg-blue-700 px-3 py-2 disabled:opacity-40">{label}</button>)}</div>
   <p className="text-sm text-gray-300">The HP must have power and internet. Restart preserves saved work and the linked WhatsApp session. Status refresh is manual.</p>
  </>}
  {message&&<p role="status">{message}</p>}
 </section>;
}
