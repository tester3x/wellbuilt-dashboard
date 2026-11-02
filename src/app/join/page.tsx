'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {httpsCallable} from 'firebase/functions';
import {getFirebaseFunctions} from '@/lib/firebase';
import {registerEmployeeWithEmail} from '@/lib/auth';
import {useAuth} from '@/contexts/AuthContext';

type Status={ok:boolean;status:string;companyName?:string;displayName?:string};
export default function JoinCompanyPage(){
 const {user}=useAuth();
 const [token,setToken]=useState(''),[invitedCompany,setInvitedCompany]=useState('');
 const [email,setEmail]=useState(''),[name,setName]=useState(''),[legalName,setLegalName]=useState('');
 const [password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[code,setCode]=useState('');
 const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  const read=()=>setToken(new URLSearchParams(window.location.hash.slice(1)).get('invite')||'');
  read();window.addEventListener('hashchange',read);
  return ()=>window.removeEventListener('hashchange',read);
 },[]);
 useEffect(()=>{
  setInvitedCompany('');if(!token)return;let active=true;setError('');
  httpsCallable(getFirebaseFunctions(),'getEmployeeInvitation')({invitationToken:token}).then(r=>{if(active)setInvitedCompany((r.data as {companyName:string}).companyName);}).catch(()=>{if(active)setError('This invitation is invalid or expired. Ask your employer for a new link, or enter its company code.');});
  return ()=>{active=false;};
 },[token]);
 useEffect(()=>{if(!user)return;let active=true;
  httpsCallable(getFirebaseFunctions(),'getEmployeeJoinStatus')({}).then(r=>{const value=r.data as Status;if(active&&value.status!=='none')setStatus(value);}).catch(()=>{});
  return ()=>{active=false;};
 },[user?.uid]);
 async function refresh(){setBusy(true);setError('');try{setStatus((await httpsCallable(getFirebaseFunctions(),'getEmployeeJoinStatus')({})).data as Status);}catch{setError('Could not check approval. Please try again.');}finally{setBusy(false);}}
 async function submit(e:React.FormEvent){e.preventDefault();setError('');if(password!==confirm){setError('Passwords do not match.');return;}setBusy(true);
  try{setStatus(await registerEmployeeWithEmail({email,password,displayName:name,legalName, ...(token?{invitationToken:token}:{companyCode:code})}));setPassword('');setConfirm('');}
  catch(e){const value=e as {code?:string;message?:string};setError(value.code==='auth/invalid-credential'?'An account already uses this email. Sign in with its existing password.':value.message?.replace(/^Firebase:\s*/,'')||'Could not submit. Retry with the same account details.');}
  finally{setBusy(false);}
 }
 const inputClass='w-full rounded-lg border border-gray-600 bg-gray-700 p-3 text-white';
 return <main className="min-h-screen bg-gray-900 px-4 py-10 text-white"><div className="mx-auto max-w-lg rounded-xl bg-gray-800 p-6 space-y-5">
  <h1 className="text-2xl font-bold">Join an existing company</h1>
  {status&&status.status!=='none'?<section aria-live="polite" className="space-y-4">
   <h2 className="text-xl">{status.status==='complete'?'You’re approved':status.status==='rejected'?'Request declined':'Waiting for company approval'}</h2>
   <p>{status.companyName}{status.status==='complete'?' has approved your account.':status.status==='rejected'?' declined this request. Contact your employer if you need help.':' will review your request and assign your responsibilities.'}</p>
   <p>Your app sign-in name is <strong>{status.displayName}</strong>. Dashboard uses your email. Use the password you chose.</p>
   {status.status==='complete'?<a href="/" className="block rounded bg-cyan-600 p-3 text-center">Open Dashboard</a>:<button disabled={busy} onClick={refresh} className="rounded bg-cyan-600 p-3">{busy?'Checking…':'Check approval'}</button>}
  </section>:<form onSubmit={submit} className="space-y-4">
   <p className="text-gray-300">Create your own employee account. Your employer approves access for your job—Driver, Dispatch, Payroll, Safety or other responsibilities.</p>
   {token?<div className="rounded bg-gray-900 p-3"><p>{invitedCompany?`Invitation to ${invitedCompany}`:'Checking invitation…'}</p><button type="button" onClick={()=>{setToken('');setError('');window.history.replaceState(null,'','/join/');}} className="text-cyan-300 underline">Use a company code instead</button></div>:<label className="block">Company code<input className={inputClass} value={code} onChange={e=>setCode(e.target.value)} required autoComplete="off" maxLength={32}/></label>}
   <label className="block">Full name<input className={inputClass} value={legalName} onChange={e=>setLegalName(e.target.value)} required maxLength={64} autoComplete="name"/></label>
   <label className="block">App sign-in name<input className={inputClass} value={name} onChange={e=>setName(e.target.value)} required minLength={2} maxLength={64} autoComplete="username"/></label>
   <label className="block">Email<input className={inputClass} type="email" value={email} onChange={e=>setEmail(e.target.value)} required autoComplete="email"/></label>
   <label className="block">Password<input className={inputClass} type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={6} maxLength={128} autoComplete="new-password"/></label>
   <label className="block">Confirm password<input className={inputClass} type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} required minLength={6} maxLength={128} autoComplete="new-password"/></label>
   <button disabled={busy||!!token&&!invitedCompany} className="w-full rounded bg-cyan-600 p-3 disabled:opacity-50">{busy?'Submitting…':'Request to join company'}</button>
  </form>}
  {error&&<p role="alert" className="text-red-300">{error}</p>}
  <p className="text-gray-300">Already have an account? <Link href="/login" className="text-cyan-300 underline">Sign in</Link></p>
  <p className="text-gray-300">Starting your own company? <Link href="/register" className="text-cyan-300 underline">Create a company</Link></p>
 </div></main>;
}
