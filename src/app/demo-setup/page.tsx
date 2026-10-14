'use client';

import { useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { useAuth } from '@/contexts/AuthContext';
import { getFirebaseFunctions } from '@/lib/firebase';
import { adminSetPasscode } from '@/lib/secureDriverAdmin';

/** One-time governed packet publication for the isolated demo company. */
export default function DemoSetupPage() {
  const { user, loading } = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [passcode, setPasscode] = useState('');
  const [passcodeMessage, setPasscodeMessage] = useState('');
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

  const resetAntig = async () => {
    if (passcode.length < 8) { setPasscodeMessage('Use at least 8 characters.'); return; }
    setBusy(true);
    setPasscodeMessage('');
    try {
      const result = await adminSetPasscode({
        driverId: '2f6e6f75-b468-4239-9831-71faeb623acb',
        displayName: 'AntigDemoDriver',
        passcode,
        temporary: false,
      });
      if (result.driverId !== '2f6e6f75-b468-4239-9831-71faeb623acb') throw new Error('Driver identity mismatch');
      setPasscode('');
      setPasscodeMessage('Antig demo driver passcode updated. Sign in to WB Tickets with AntigDemoDriver.');
    } catch (cause) {
      setPasscodeMessage(cause instanceof Error ? cause.message : 'Passcode update failed.');
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
        <div className="mt-8 border-t border-slate-700 pt-5">
          <h2 className="font-semibold">Antig demo driver login</h2>
          <p className="mt-2 text-sm text-slate-300">If the original demo passcode is unknown, choose a new one for AntigDemoDriver. This calls the governed company-scoped credential reset.</p>
          <label htmlFor="antig-passcode" className="mt-4 block text-sm">New passcode</label>
          <input id="antig-passcode" type="password" autoComplete="new-password" value={passcode}
            onChange={event => setPasscode(event.target.value)}
            className="mt-1 w-full rounded border border-slate-600 bg-slate-950 p-2" />
          <button type="button" disabled={busy || passcode.length < 8} onClick={resetAntig}
            className="mt-3 rounded bg-cyan-600 px-4 py-2 font-semibold disabled:opacity-50">
            Reset Antig demo passcode
          </button>
          {passcodeMessage && <p role="status" className="mt-3 text-sm text-cyan-200">{passcodeMessage}</p>}
        </div>
      </> : <p className="mt-4 text-amber-300">Demo company admin access is required.</p>}
    </section>
  </main>;
}
