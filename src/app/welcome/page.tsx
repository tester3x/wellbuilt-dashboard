'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { httpsCallable } from 'firebase/functions';
import { onAuthStateChanged } from 'firebase/auth';
import { getFirebaseAuth, getFirebaseFunctions } from '@/lib/firebase';

type Setup = { ok: boolean; companyId: string; companyName: string; displayName: string; joinCode: string };
export default function WelcomePage() {
  const [setup, setSetup] = useState<Setup | null>(null), [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const stop = onAuthStateChanged(getFirebaseAuth(), async user => {
      if (!active) return;
      if (!user) { setError('Sign in to finish company setup.'); return; }
      try {
        const response = await httpsCallable(getFirebaseFunctions(), 'getOwnerCompanySetup')({ schemaVersion: 1 });
        const value = response.data as Setup;
        if (!value?.ok || !value.companyId || !value.displayName) throw Error('unconfirmed');
        if (active) { setSetup(value); setError(''); }
      } catch { if (active) setError('Company setup could not be confirmed. Retry, or return to signup with the same email to finish an interrupted setup.'); }
    });
    return () => { active = false; stop(); };
  }, [attempt]);
  return <main className="min-h-screen bg-gray-900 text-white px-5 py-12"><div className="max-w-xl mx-auto space-y-6">
    <h1 className="text-3xl font-bold">{setup ? `Welcome to ${setup.companyName}` : 'Your company setup'}</h1>
    {error ? <div role="alert" className="bg-red-900/40 border border-red-500 rounded-lg p-4 space-y-4"><p>{error}</p>
      <button onClick={() => { setError(''); setAttempt(a => a + 1); }} className="underline">Retry</button>{' · '}<Link href="/register" className="underline">Return to signup</Link>{' · '}<Link href="/login" className="underline">Sign in</Link></div>
      : !setup ? <p role="status">Checking your company setup…</p> : <>
        <p>You’re the company administrator. Start with JSA and DVIR, and manage your vehicles and inspection settings.</p>
        <section className="rounded-xl border border-gray-600 bg-gray-800 p-6 space-y-3"><h2 className="text-xl font-semibold">Sign in to the apps</h2>
          <p>In WB JSA or WB e, use <strong>{setup.displayName}</strong> and the password you just chose.</p>
          <p className="text-gray-300">You don’t need an employee code or an open shift for standalone JSA and DVIR.</p>
        </section>
        <section className="rounded-xl border border-gray-600 p-6 space-y-3"><h2 className="text-xl font-semibold">Company setup</h2>
          <p><Link href="/equipment" className="text-cyan-400 underline">Add your trucks and inspection settings</Link></p>
          <p><Link href="/safety" className="text-cyan-400 underline">Set up your JSA assessments</Link></p>
          <p><Link href="/settings" className="text-cyan-400 underline">Open company settings</Link></p>
        </section>
        <details className="border border-gray-700 rounded-xl p-5"><summary>Invite employees later</summary><p className="mt-4">Your company code: <strong className="font-mono">{setup.joinCode}</strong></p><p className="mt-2 text-gray-300">Employees use this code in New Employee Registration. Share it only with people joining your company.</p></details>
        <Link href="/" className="inline-block px-6 py-3 bg-cyan-600 rounded-lg font-semibold">Open Dashboard</Link>
      </>}
  </div></main>;
}
