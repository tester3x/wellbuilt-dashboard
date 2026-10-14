'use client';

import { useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { useAuth } from '@/contexts/AuthContext';
import { getFirebaseFunctions } from '@/lib/firebase';

/** One-time governed packet publication for the isolated demo company. */
export default function DemoSetupPage() {
  const { user, loading } = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const allowed = user?.companyId === 'wellbuilt-demo' && user?.role === 'admin';

  const publish = async () => {
    setBusy(true);
    setMessage('');
    try {
      const call = httpsCallable(getFirebaseFunctions(), 'publishJobPacketRevision');
      for (let revision = 1; revision <= 4; revision += 1) {
        const response = await fetch(`/demo-packets/rev${revision}.json`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Could not load packet draft ${revision}`);
        const packetDraft = await response.json();
        const result = await call({
          requestId: `wellbuilt-demo-initial-water-hauling-${revision}`,
          expectedLatestRevision: revision - 1,
          packetDraft,
        });
        const published = result.data as { revision?: number };
        if (published.revision !== revision) throw new Error(`Unexpected packet revision ${published.revision}`);
        setMessage(`Published water-hauling revision ${revision} of 4.`);
      }
      setMessage('Water-hauling packet revision 4 is ready for demo dispatch.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Packet publication failed.');
    } finally {
      setBusy(false);
    }
  };

  return <main className="min-h-screen bg-slate-950 p-8 text-white">
    <section className="mx-auto max-w-lg rounded-xl border border-cyan-800 bg-slate-900 p-6">
      <h1 className="text-xl font-bold">Demo company setup</h1>
      {loading ? <p className="mt-4">Loading…</p> : allowed ? <>
        <p className="mt-4 text-sm text-slate-300">Publish the standard water-hauling packet to WellBuilt Demo Hauling. The server pins each revision to this company.</p>
        <button type="button" disabled={busy} onClick={publish}
          className="mt-5 rounded bg-cyan-600 px-4 py-2 font-semibold disabled:opacity-50">
          {busy ? 'Publishing…' : 'Publish demo water-hauling packet'}
        </button>
        {message && <p role="status" className="mt-4 text-sm text-cyan-200">{message}</p>}
      </> : <p className="mt-4 text-amber-300">Demo company admin access is required.</p>}
    </section>
  </main>;
}
