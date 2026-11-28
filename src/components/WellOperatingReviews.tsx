'use client';
import { useState, useEffect } from 'react';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '@/lib/firebase';
import { listWellOperatingRequests, type WellOperatingRequest } from '@/lib/wellOperatingRequests';
import { useAuth } from '@/contexts/AuthContext';

type Item = WellOperatingRequest;
export function WellOperatingReviews() {
  const { user, operatingCompanyId } = useAuth();
  const [items, setItems] = useState<Item[] | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function load() {
    if (!user || !operatingCompanyId) return;
    setBusy(true); setError('');
    try { setItems(await listWellOperatingRequests(user.uid, operatingCompanyId)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load status requests'); }
    finally { setBusy(false); }
  }
  async function review(id: string, action: string) {
    setBusy(true); setError('');
    try { await httpsCallable(getFirebaseFunctions(), 'reviewWellOperatingStatus')({ id, action }); await load();
      window.dispatchEvent(new Event('well-status-reviewed')); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not review status request'); }
    finally { setBusy(false); }
  }
  useEffect(() => { setItems(null); void load(); }, [user?.uid, operatingCompanyId]);
  return <section id="well-status-requests" className="space-y-3 border-t border-gray-700 pt-6">
    <h2 className="text-xl font-bold">Well Up / Down requests</h2>
    <p>Drivers without explicit permission to manage this route need approval to change its operating status.</p>
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
