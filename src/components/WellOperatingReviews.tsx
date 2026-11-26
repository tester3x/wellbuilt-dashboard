'use client';
import { useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '@/lib/firebase';

type Item = { id: string; wellConfigKey: string; driverName: string; down: boolean; requestedAt: string };
export function WellOperatingReviews() {
  const [items, setItems] = useState<Item[] | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function load() {
    setBusy(true); setError('');
    try { const result = await httpsCallable(getFirebaseFunctions(), 'reviewWellOperatingStatus')({ action: 'list' });
      setItems((result.data as { items: Item[] }).items); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load status requests'); }
    finally { setBusy(false); }
  }
  async function review(id: string, action: string) {
    setBusy(true); setError('');
    try { await httpsCallable(getFirebaseFunctions(), 'reviewWellOperatingStatus')({ id, action }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not review status request'); }
    finally { setBusy(false); }
  }
  return <section className="space-y-3 border-t border-gray-700 pt-6">
    <h2 className="text-xl font-bold">Well Up / Down requests</h2>
    <p>Drivers without this well in their WB Mobile route access need approval to change its operating status.</p>
    <button disabled={busy} onClick={() => void load()} className="rounded bg-gray-800 px-4 py-2">{busy ? 'Loading…' : 'Load status requests'}</button>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {items?.length === 0 && <p>No pending well status requests.</p>}
    {items?.map(item => <article key={item.id} className="space-y-3 rounded-xl border border-gray-700 p-4">
      <h3 className="font-bold text-yellow-400">{item.wellConfigKey} → {item.down ? 'Down' : 'Up'}</h3>
      <p>Requested by {item.driverName} · {item.requestedAt}</p>
      <p>Approval changes operating status only. It does not create or edit a pickup.</p>
      <div className="flex gap-3">
        <button disabled={busy} onClick={() => void review(item.id, 'approve')} className="rounded bg-green-800 px-4 py-2">Approve status change</button>
        <button disabled={busy} onClick={() => void review(item.id, 'reject')} className="rounded border border-red-500 px-4 py-2">Reject</button>
      </div>
    </article>)}
  </section>;
}
