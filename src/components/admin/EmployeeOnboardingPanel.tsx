'use client';
import {useCallback,useEffect,useState} from 'react';
import {httpsCallable} from 'firebase/functions';
import {getFirebaseFunctions} from '@/lib/firebase';
import {useAuth} from '@/contexts/AuthContext';
import {hasCapability,DEFAULT_ROLE_LABELS,type UserRole} from '@/lib/auth';
import {CompanyJoinCodeCard} from './CompanyJoinCodeCard';
type Request={uid:string;displayName:string;legalName:string;email:string;status:string;roles?:UserRole[]};
const choices:UserRole[]=['driver','dispatch','payroll','safety','lead','manager','admin','viewer'];
export function EmployeeOnboardingPanel(){
 const {user,userCompany}=useAuth();const [requests,setRequests]=useState<Request[]>([]),[roles,setRoles]=useState<Record<string,UserRole[]>>({});
 const [url,setUrl]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const allowed=hasCapability(user,'manageDrivers',userCompany)&&hasCapability(user,'manageRolesAndCapabilities',userCompany);
 const load=useCallback(async()=>{if(!allowed)return;try{const result=await httpsCallable(getFirebaseFunctions(),'listEmployeeJoinRequests')({});const rows=(result.data as {requests:Request[]}).requests;setRequests(rows);setRoles(prior=>Object.fromEntries(rows.map(r=>[r.uid,r.status==='pending'?(prior[r.uid]||r.roles||['driver']):(r.roles||['driver'])])));}catch{setMessage('Employee requests could not be loaded. Check your company onboarding permissions.');}},[allowed,user?.uid]);
 useEffect(()=>{void load();},[load]);
 if(!allowed)return null;
 async function invite(){setBusy(true);setMessage('');try{const result=await httpsCallable(getFirebaseFunctions(),'createEmployeeInvitation')({});setUrl((result.data as {url:string}).url);setMessage('Invitation ready. It expires in seven days and joins one new employee. You approve their responsibilities afterward.');}catch{setMessage('Could not create an invitation.');}finally{setBusy(false);}}
 async function resolve(row:Request,action:'approve'|'reject'){setBusy(true);setMessage('');try{const response=await httpsCallable(getFirebaseFunctions(),'resolveEmployeeJoin',{timeout:120000})({uid:row.uid,action,...(action==='approve'?{roles:roles[row.uid]||['driver']}: {})});const status=(response.data as {status:string}).status;setMessage(status==='complete'?'Employee approved. They can check approval on the signup page or sign in.':'Request declined.');await load();}catch(e){setMessage((e as {message?:string}).message||'Could not finish approval. Retry with the same responsibilities.');}finally{setBusy(false);}}
 return <section className="mb-6 space-y-4 rounded-lg border border-gray-600 bg-gray-800 p-4">
  <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-bold text-white">Employee onboarding</h2><p className="text-sm text-gray-300">Invite anyone joining your company, including office staff. No driver registration is required first.</p></div><button onClick={invite} disabled={busy} className="rounded bg-cyan-600 px-4 py-2 text-white disabled:opacity-50">Invite Employee</button></div>
  {user?.companyId&&<CompanyJoinCodeCard companyId={user.companyId}/>}
  <p className="text-sm text-gray-300">Employees can also visit <a className="text-cyan-300 underline" href="/join/">Join an existing company</a> and enter your company code.</p>
  {url&&<div className="space-y-2 rounded bg-gray-900 p-3"><label className="block text-sm text-gray-300">Private signup link<input readOnly value={url} className="w-full rounded bg-gray-700 p-2 text-white" onFocus={e=>e.target.select()}/></label><div className="flex gap-4"><button className="text-cyan-300 underline" onClick={async()=>{try{await navigator.clipboard.writeText(url);setMessage('Invitation copied. Send it privately by email or text.');}catch{setMessage('Select and copy the invitation link above.');}}}>Copy link</button><a className="text-cyan-300 underline" href={'mailto:?subject='+encodeURIComponent('Join our company on WellBuilt')+'&body='+encodeURIComponent('Create your employee account using this private invitation. Choose your own password; our company will approve your access.\n\n'+url)}>Email link</a></div></div>}
  {message&&<p role="status" className="text-amber-200">{message}</p>}
  <div className="flex justify-between"><h3 className="font-semibold text-white">New employee requests ({requests.length})</h3><button className="text-cyan-300 underline" onClick={load}>Refresh</button></div>
  {requests.map(row=><div key={row.uid} className="space-y-3 rounded bg-gray-900 p-3 text-white"><p className="font-semibold">{row.legalName||row.displayName}</p><p className="text-sm text-gray-300">{row.email} · App sign-in: {row.displayName}</p><div className="flex flex-wrap gap-3">{choices.map(role=><label key={role}><input type="checkbox" disabled={busy||row.status!=='pending'} checked={(roles[row.uid]||['driver']).includes(role)} onChange={e=>setRoles(prior=>{const selected=prior[row.uid]||['driver'];return {...prior,[row.uid]:e.target.checked?[...selected,role]:selected.filter(r=>r!==role)};})}/> {DEFAULT_ROLE_LABELS[role]}</label>)}</div><div className="flex gap-3"><button disabled={busy||!(roles[row.uid]||['driver']).length} onClick={()=>resolve(row,'approve')} className="rounded bg-green-700 p-2">Approve employee</button><button disabled={busy} onClick={()=>resolve(row,'reject')} className="rounded bg-red-800 p-2">Decline</button></div></div>)}
 </section>;
}
