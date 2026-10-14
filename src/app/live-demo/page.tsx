'use client';

import { useEffect, useRef, useState } from 'react';
import { signInWithCustomToken } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { getFirebaseAuth, getFirebaseFunctions } from '@/lib/firebase';

const DEMO_UID = 'wellbuilt-demo-shared-viewer';
const DEMO_COMPANY = 'wellbuilt-demo';

/** Public entry to the real company-scoped Dashboard. The shared viewer has no write capabilities. */
export default function LiveDemoPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const started = useRef(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (loading) return;
    if (user?.uid === DEMO_UID && user.companyId === DEMO_COMPANY) {
      router.replace('/dispatch?tab=jobs');
      return;
    }
    // A staff session reached this route by client navigation. A full reload
    // starts the isolated demo Firebase app while retaining staff Auth.
    if (user || started.current) return;
    started.current = true;
    const enter = async () => {
      try {
        const session = await httpsCallable<undefined, { customToken: string; companyId: string; role: string }>(
          getFirebaseFunctions(), 'demoViewerSession')();
        if (session.data.companyId !== DEMO_COMPANY || session.data.role !== 'demo_viewer') {
          throw new Error('Demo viewer scope mismatch');
        }
        const credential = await signInWithCustomToken(getFirebaseAuth(), session.data.customToken);
        const token = await credential.user.getIdTokenResult();
        if (credential.user.uid !== DEMO_UID || token.claims.staffCompanyId !== DEMO_COMPANY
          || token.claims.staffRole !== 'demo_viewer' || token.claims.isDemo !== true) {
          throw new Error('Demo viewer identity mismatch');
        }
        // AuthProvider will resolve the signed-in viewer and take the first
        // branch of this effect through to Dispatch. Navigating here before
        // that callback completes can trip Dispatch's login redirect.
      } catch (cause) {
        started.current = false;
        setError(cause instanceof Error ? cause.message : 'Demo sign-in is unavailable.');
      }
    };
    void enter();
  }, [loading, router, user]);

  return <main className="flex min-h-screen items-center justify-center bg-[#0b1424] p-4 text-white">
    <section className="w-full max-w-md rounded-xl border border-cyan-800/70 bg-gray-800 p-8 text-center shadow-2xl">
      <img src="/live-demo/logo.svg" alt="WellBuilt Demo Hauling logo" className="mx-auto mb-4 h-20 w-20" />
      <h1 className="text-2xl font-bold">WellBuilt Demo Hauling</h1>
      {user && user.uid !== DEMO_UID ? <>
        <p className="mt-4 text-sm text-gray-300">Your WellBuilt account will stay signed in while you view the demo.</p>
        <button type="button" onClick={() => window.location.reload()} className="mt-4 rounded-lg bg-cyan-600 px-4 py-2 font-semibold">Open Demo Viewer</button>
        <p className="mt-4 text-xs text-gray-400">The demo uses the actual company Dashboard and a shared read-only viewer.</p>
      </> : error ? <>
        <p role="alert" className="mt-4 text-sm text-amber-300">{error}</p>
        <button type="button" onClick={() => { setError(''); started.current = false; window.location.reload(); }} className="mt-4 rounded-lg bg-cyan-600 px-4 py-2 font-semibold">Try again</button>
      </> : <p className="mt-4 text-sm text-gray-300">Opening the real demo company Dashboard…</p>}
    </section>
  </main>;
}
