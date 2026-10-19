'use client';
import {useEffect,useState,useCallback,useRef} from 'react';
import {httpsCallable} from 'firebase/functions';
import {getFirebaseFunctions} from '@/lib/firebase';

export type Item={id:string;revision:string;groupName:string;body:string;author:string;postedAt:string;editable:boolean;issues:string[];row:{wellName:string;dateTimeUTC:string;tankLevelFeet:number|null;bottomLevelFeet:number|null;bblsTaken:number|null};command?:{state:string;error?:string}};
function centralTime(value:string){const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;}
function ReviewCard({item,companyId,onSaved}:{item:Item;companyId:string;onSaved:()=>void}){
 const [time,setTime]=useState(centralTime(item.row.dateTimeUTC||item.postedAt)),[top,setTop]=useState(String(item.row.tankLevelFeet??'')),[bottom,setBottom]=useState(String(item.row.bottomLevelFeet??'')),[barrels,setBarrels]=useState(String(item.row.bblsTaken??'')),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const pending=item.command?.state==='pending';
 async function decide(decision:string){setBusy(true);setMessage('');try{
 // Resolve Central wall time through the callable; browser timezone is not authoritative.
 await httpsCallable(getFirebaseFunctions(),'decideWatchdogReview')({companyId,id:item.id,revision:item.revision,decision,timeCentral:time,tankLevelFeet:top===''?null:Number(top),bottomLevelFeet:bottom===''?null:Number(bottom),bblsTaken:barrels===''?null:Number(barrels),reason});setMessage('Decision saved. Waiting for the watchdog laptop to apply it.');onSaved();
 }catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}
 return <article className="border border-yellow-600 rounded-lg p-4 space-y-3"><h2 className="font-bold">{item.row.wellName} / {item.groupName}</h2><p>{item.author} / {new Date(item.postedAt).toLocaleString('en-US',{timeZone:'America/Chicago'})} Central</p><pre className="whitespace-pre-wrap">{item.body}</pre><p className="text-yellow-300">{item.issues.join('; ')}</p>{pending?<p>Decision pending - watchdog must be online.</p>:!item.editable?<p>This hold needs reconciliation before it can be sent again.</p>:<><p className="text-sm">Levels use decimal feet: 7 feet 8 inches = 7.667 feet. Original post is preserved.</p>{([['Top level',top,setTop],['Bottom level (optional)',bottom,setBottom],['Barrels',barrels,setBarrels]] as const).map(([label,value,set])=><label key={label} className="block">{label}<input aria-label={label} type="number" min="0" step="any" value={value} onChange={e=>set(e.target.value)} className="block bg-gray-800 border border-gray-600 rounded p-2 w-full"/></label>)}<label className="block">Measurement time (Central)<input aria-label="Measurement time (Central)" type="datetime-local" value={time} onChange={e=>setTime(e.target.value)} className="block bg-gray-800 border border-gray-600 rounded p-2 w-full"/></label><label className="block">Reason<input value={reason} maxLength={300} onChange={e=>setReason(e.target.value)} className="block bg-gray-800 border border-gray-600 rounded p-2 w-full"/></label><button disabled={busy||reason.trim().length<3} onClick={()=>decide('confirm')} className="bg-yellow-500 text-black rounded p-2 mr-2 disabled:opacity-40">Confirm and send</button><button disabled={busy||reason.trim().length<3} onClick={()=>decide('exclude')} className="bg-gray-700 rounded p-2 disabled:opacity-40">Exclude</button></>}{item.command?.state==='failed'&&<p role="alert">Decision failed: {item.command.error}. Correct and retry.</p>}<p role="status">{message}</p></article>;
}

type ReviewList={rows:Item[];truncated:boolean};
const loadReviews=async(companyId:string):Promise<ReviewList>=>{
 const result=await httpsCallable<{companyId:string},ReviewList>(getFirebaseFunctions(),'listWatchdogReviews',{timeout:15000})({companyId});
 return result.data;
};
export function WatchdogReviewInbox({companyId,load=loadReviews}:{companyId:string;load?:(companyId:string)=>Promise<ReviewList>}){
 const [rows,setRows]=useState<Item[]>([]),[error,setError]=useState(''),[updated,setUpdated]=useState(''),[refreshing,setRefreshing]=useState(true);
 const generation=useRef(0),mounted=useRef(false),inFlight=useRef<{generation:number;promise:Promise<void>}|null>(null);
 const refresh=useCallback(()=>{
  if(!mounted.current)return Promise.resolve();
  const epoch=generation.current;
  if(inFlight.current?.generation===epoch)return inFlight.current.promise;
  setRefreshing(true);setError('');
  const promise=(async()=>{
   try{
    const response=await load(companyId);
    if(!mounted.current||generation.current!==epoch)return;
    setRows(response.rows);setError(response.truncated?'Inbox is large; some records may not be listed.':'');
    setUpdated(new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',second:'2-digit'}));
   }catch(e){if(mounted.current&&generation.current===epoch)setError((e as Error).message||'Refresh failed. Try again.');}
   finally{if(mounted.current&&generation.current===epoch){inFlight.current=null;setRefreshing(false);}}
  })();
  inFlight.current={generation:epoch,promise};return promise;
 },[companyId,load]);
 useEffect(()=>{
  mounted.current=true;generation.current++;inFlight.current=null;setRows([]);setUpdated('');void refresh();
  const timer=setInterval(()=>void refresh(),15000);
  return()=>{mounted.current=false;generation.current++;clearInterval(timer);};
 },[refresh]);
 return <>
  <div className="flex items-center justify-between gap-3"><h1 className="text-2xl font-bold">Watchdog reviews ({rows.length})</h1>
   <button type="button" onClick={()=>void refresh()} disabled={refreshing} aria-busy={refreshing} className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:cursor-wait disabled:opacity-70">
    <span aria-hidden="true" className={refreshing?'inline-block animate-spin':''}>&#8635;</span>{refreshing?'Refreshing...':'Refresh'}
   </button>
  </div>
  <p>Review decisions are applied by the watchdog laptop when online.</p>
  <p role="status" aria-live="polite">{refreshing?'Checking for reviews...':updated?`Last checked: ${updated}`:'Reviews have not loaded yet.'}</p>
  {error&&<p role="alert" className="text-red-300">{error}</p>}
  {!refreshing&&!error&&!rows.length&&<p>No pulls waiting for review.</p>}
  {rows.map(item=><ReviewCard key={companyId+item.id+item.revision} item={item} companyId={companyId} onSaved={()=>void refresh()}/>)}
 </>;
}
