'use client';

import { useMemo, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { signInWithCustomToken, signOut } from 'firebase/auth';
import { getFirebaseAuth, getFirebaseFunctions } from '@/lib/firebase';

type View = 'menu' | 'request' | 'redeem' | 'legacy' | 'change' | 'status' | 'done';
const PURPOSES = [
  ['forgot_login', 'Forgot login name'],
  ['forgot_passcode', 'Forgot passcode'],
] as const;

function randomValue(bytes = 24): string {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256(value: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
}
async function call<T>(name: string, data: object): Promise<T> {
  return (await httpsCallable(getFirebaseFunctions(), name)(data)).data as T;
}

export default function AccountRecoveryPage() {
  const query = useMemo(() => typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search), []);
  const audience = query.get('audience') || 'wellbuilt-mobile';
  const returnUri = query.get('return_uri') || '';
  const correlationState = query.get('state') || '';
  const allowedReturn: Record<string,string> = {'wellbuilt-suite':'wellbuilt://account-recovery','wellbuilt-mobile':'wellbuilt-mobile://account-recovery','wellbuilt-tickets':'wellbuilt-tickets://account-recovery','wellbuilt-jsa':'wellbuilt-jsa://account-recovery','wellbuilt-equipment':'wellbuilt-equipment://account-recovery'};
  const safeReturn = allowedReturn[audience] === returnUri && /^[A-Za-z0-9_-]{32,128}$/.test(correlationState)
    ? `${returnUri}?outcome=success&state=${encodeURIComponent(correlationState)}` : null;
  const [view, setView] = useState<View>('menu');
  const [purpose, setPurpose] = useState('forgot_passcode');
  const [legalNameHint, setLegal] = useState(''); const [companyHint, setCompany] = useState('');
  const [contactHint, setContact] = useState(''); const [requestId, setRequestId] = useState('');
  const [statusSecret, setStatusSecret] = useState(''); const [recoverySecret, setRecoverySecret] = useState('');
  const [login, setLogin] = useState(''); const [currentPasscode, setCurrent] = useState('');
  const [next, setNext] = useState(''); const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);

  const submitRequest = async () => {
    setBusy(true); setMessage('');
    try {
      const rid = crypto.randomUUID(), status = randomValue();
      await call('requestDriverAccountRecovery', { requestId: rid, purpose, audience, returnUri,
        stateHash: await sha256(randomValue()), statusSecretHash: await sha256(status),
        legalNameHint, companyHint, contactHint });
      sessionStorage.setItem('wb_recovery_request', rid); sessionStorage.setItem('wb_recovery_status', status);
      setRequestId(rid); setStatusSecret(status); setMessage('Request received. Keep this browser available to check status.');
      setView('status');
    } catch { setMessage('The request could not be submitted. Please try again later.'); } finally { setBusy(false); }
  };
  const checkStatus = async () => {
    setBusy(true); try {
      const id = requestId || sessionStorage.getItem('wb_recovery_request') || '';
      const sec = statusSecret || sessionStorage.getItem('wb_recovery_status') || '';
      const r = await call<{state:string}>('getOwnRecoveryRequestStatus', { requestId: id, statusSecret: sec });
      setMessage(`Request status: ${r.state}.`);
    } catch { setMessage('Status is temporarily unavailable.'); } finally { setBusy(false); }
  };
  const redeem = async () => {
    if (!next || next !== confirm) { setMessage('The new passcodes do not match.'); return; }
    setBusy(true); try {
      await call('redeemDriverAccountRecovery', { requestId, recoverySecret, newPasscode: next,
        redemptionAttemptId: crypto.randomUUID() });
      setRecoverySecret(''); setNext(''); setConfirm(''); setMessage('Recovery completed. Reopen your WellBuilt app and sign in.'); setView('done');
    } catch { setMessage('Recovery could not be completed. Check the private value or request a new authorization.'); } finally { setBusy(false); }
  };
  const legacyUpgrade = async () => {
    if (!next || next !== confirm) { setMessage('The new passcodes do not match.'); return; }
    setBusy(true); try {
      await call('upgradeOwnLegacyDriverLogin', { displayName: login, currentPasscode, newPasscode: next });
      setCurrent(''); setNext(''); setConfirm(''); setMessage('Upgrade completed. Reopen your WellBuilt app and sign in.'); setView('done');
    } catch { setMessage('Upgrade could not be completed.'); } finally { setBusy(false); }
  };
  const changePasscode = async () => {
    if (!next || next !== confirm) { setMessage('The new passcodes do not match.'); return; }
    setBusy(true); try {
      const authn = await call<{customToken:string}>('authenticateDriver', { displayName: login, passcode: currentPasscode });
      if (!authn.customToken) throw new Error('no_session');
      await signInWithCustomToken(getFirebaseAuth(), authn.customToken);
      await call('driverChangeOwnPasscode', { currentPasscode, newPasscode: next });
      await signOut(getFirebaseAuth());
      setCurrent(''); setNext(''); setConfirm(''); setMessage('Passcode changed. Reopen your WellBuilt app and sign in.'); setView('done');
    } catch { await signOut(getFirebaseAuth()).catch(()=>undefined); setMessage('Passcode change could not be completed.'); }
    finally { setBusy(false); }
  };

  const field = (label:string, value:string, setter:(x:string)=>void, type='text') =>
    <label className="block text-sm text-gray-200 mb-3">{label}<input type={type} value={value} onChange={e=>setter(e.target.value)}
      className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-3 text-white" autoCapitalize="none" /></label>;
  return <main className="min-h-screen bg-gray-950 text-white px-4 py-8"><section className="mx-auto max-w-md rounded-xl bg-gray-800 p-6 shadow-xl">
    <h1 className="text-2xl font-semibold">WellBuilt account recovery</h1>
    <p className="mt-2 mb-6 text-sm text-gray-300">Passcodes and recovery values stay out of links. WellBuilt staff will never choose your new passcode.</p>
    {view === 'menu' && <div className="space-y-3">
      {PURPOSES.map(([p,l])=><button key={p} onClick={()=>{setPurpose(p);setView('request')}} className="w-full rounded bg-blue-600 p-3">{l}</button>)}
      <button onClick={()=>setView('legacy')} className="w-full rounded bg-blue-600 p-3">Upgrade existing legacy login</button>
      <button onClick={()=>setView('change')} className="w-full rounded bg-blue-600 p-3">Change passcode while authenticated</button>
      <button onClick={()=>setView('status')} className="w-full rounded bg-gray-600 p-3">Check recovery-request status</button>
    </div>}
    {view === 'request' && <div>{field('Legal name',legalNameHint,setLegal)}{field('Company',companyHint,setCompany)}{field('Private contact instructions',contactHint,setContact)}
      <button disabled={busy} onClick={submitRequest} className="w-full rounded bg-blue-600 p-3">Submit request</button></div>}
    {view === 'status' && <div>{field('Request ID',requestId,setRequestId)}<button disabled={busy} onClick={checkStatus} className="w-full rounded bg-blue-600 p-3">Check status</button>
      <button onClick={()=>setView('redeem')} className="mt-3 w-full rounded bg-emerald-700 p-3">I have a private recovery value</button></div>}
    {view === 'redeem' && <div>{field('Request ID',requestId,setRequestId)}{field('Private recovery value',recoverySecret,setRecoverySecret,'password')}{field('New passcode',next,setNext,'password')}{field('Confirm new passcode',confirm,setConfirm,'password')}
      <button disabled={busy} onClick={redeem} className="w-full rounded bg-blue-600 p-3">Complete recovery</button></div>}
    {view === 'legacy' && <div>{field('Existing login name',login,setLogin)}{field('Current passcode',currentPasscode,setCurrent,'password')}{field('New secure passcode',next,setNext,'password')}{field('Confirm new passcode',confirm,setConfirm,'password')}
      <button disabled={busy} onClick={legacyUpgrade} className="w-full rounded bg-blue-600 p-3">Upgrade securely</button></div>}
    {view === 'change' && <div>{field('Login name',login,setLogin)}{field('Current passcode',currentPasscode,setCurrent,'password')}{field('New passcode',next,setNext,'password')}{field('Confirm new passcode',confirm,setConfirm,'password')}
      <button disabled={busy} onClick={changePasscode} className="w-full rounded bg-blue-600 p-3">Change passcode</button></div>}
    {view === 'done' && <div><p className="rounded bg-emerald-950 p-4">{message}</p>{safeReturn&&<a className="mt-4 block rounded bg-blue-600 p-3 text-center" href={safeReturn}>Return to WellBuilt</a>}</div>}
    {message && view !== 'done' && <p role="status" className="mt-4 rounded bg-gray-900 p-3 text-sm">{message}</p>}
    {view !== 'menu' && view !== 'done' && <button onClick={()=>{setMessage('');setView('menu')}} className="mt-5 text-sm text-blue-300">Back</button>}
  </section></main>;
}
