'use client';
import { useEffect, useState } from 'react';
import { get, ref } from 'firebase/database';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseDatabase, getFirebaseFunctions } from '@/lib/firebase';

type Req={requestId:string;purpose:string;state:string;legalNameHint:string;companyHint:string;contactHint:string;expiresAtMs:number};
type Driver={key:string;displayName:string;legalName?:string;companyId?:string};
const hex=(a:Uint8Array)=>Array.from(a,x=>x.toString(16).padStart(2,'0')).join('');
async function digest(v:string){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))))}
async function call<T>(name:string,data:object){return (await httpsCallable(getFirebaseFunctions(),name)(data)).data as T}

export default function DriverRecoveryAdmin(){
 const [requests,setRequests]=useState<Req[]>([]),[drivers,setDrivers]=useState<Driver[]>([]),[selected,setSelected]=useState<Record<string,string>>({}),[privateValue,setPrivate]=useState(''),[message,setMessage]=useState('');
 const load=async()=>{const [r,d]=await Promise.all([call<{requests:Req[]}>('listDriverAccountRecoveryRequests',{}),get(ref(getFirebaseDatabase(),'drivers/approved'))]);setRequests(r.requests);setDrivers(Object.entries(d.val()||{}).map(([key,v])=>({key,...v as Omit<Driver,'key'>})).filter(x=>x.companyId));};
 useEffect(()=>{void load().catch(()=>setMessage('Recovery requests unavailable.'));},[]);
 const approve=async(r:Req)=>{const key=selected[r.requestId];if(!key)return setMessage('Select the exact driver first.');const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);const secret=hex(bytes);await call('approveDriverAccountRecovery',{requestId:r.requestId,approvedKey:key,recoverySecretHash:await digest(secret)});setPrivate(secret);setMessage('Authorized. Copy the private value once and deliver it through the approved private channel.');await load();};
 const terminal=async(name:string,id:string)=>{await call(name,{requestId:id});setPrivate('');await load();};
 return <main className="min-h-screen bg-gray-950 p-6 text-white"><div className="mx-auto max-w-4xl"><h1 className="text-2xl font-semibold">Driver Login Recovery</h1><p className="mb-5 text-gray-400">Administrators authorize identity recovery. Drivers choose their own passcodes.</p>{message&&<p className="my-3 rounded bg-gray-800 p-3">{message}</p>}{privateValue&&<div className="my-4 rounded border border-amber-500 bg-amber-950 p-4"><b>One-time private recovery value</b><p className="break-all font-mono mt-2">{privateValue}</p><p className="text-xs mt-2">This value exists only in this browser. Copy it now; never place it in chat or email.</p></div>}
 <div className="space-y-3">{requests.map(r=><article key={r.requestId} className="rounded bg-gray-800 p-4"><div className="flex justify-between"><b>{r.purpose.replaceAll('_',' ')}</b><span>{r.state}</span></div><p className="text-sm text-gray-300">{r.legalNameHint} · {r.companyHint} · {r.contactHint}</p>{r.state==='pending'&&<><select className="mt-3 w-full bg-gray-900 p-2" value={selected[r.requestId]||''} onChange={e=>setSelected({...selected,[r.requestId]:e.target.value})}><option value="">Select exact active driver</option>{drivers.filter(d=>d.companyId).map(d=><option key={d.key} value={d.key}>{d.displayName} — {d.legalName||''} — {d.companyId}</option>)}</select><div className="mt-3 flex gap-2"><button className="rounded bg-emerald-700 px-3 py-2" onClick={()=>void approve(r)}>Approve</button><button className="rounded bg-red-700 px-3 py-2" onClick={()=>void terminal('denyDriverAccountRecovery',r.requestId)}>Deny</button><button className="rounded bg-gray-600 px-3 py-2" onClick={()=>void terminal('cancelDriverAccountRecovery',r.requestId)}>Cancel</button></div></>}</article>)}</div></div></main>
}
