'use client';
import { useCallback, useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '@/lib/firebase';
type Item = { id: string; driverId: string; reason: string; mode: string;
  scope: { jobId: string; jobType: string; pickup: string; dropoff: string;
    pickupLat: number | null; pickupLng: number | null; dropoffLat: number | null; dropoffLng: number | null } };
function ExceptionItem({ item, review }: { item: Item; review: (id: string, action: string, note: string) => Promise<void> }) {
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const act = async (action: string) => {
    setBusy(true); setError('');
    try { await review(item.id, action, note); } catch (e) { setError(e instanceof Error ? e.message : 'Review failed'); }
    finally { setBusy(false); }
  };
  return <article className="space-y-3 rounded-xl border border-gray-700 bg-gray-900 p-5">
    <h3 className="font-semibold text-yellow-400">Same-location PW · Job {item.scope.jobId}</h3>
    <p>Driver: {item.driverId} · {item.mode === 'hybrid' ? 'Hybrid' : 'Dispatch-only'}</p>
    <p>Job type: {item.scope.jobType}</p>
    <p>Proposed pickup: {item.scope.pickup}<br />Proposed drop-off: {item.scope.dropoff}</p>
    <p className="text-sm text-gray-400">Pickup GPS: {item.scope.pickupLat ?? 'Not recorded'}, {item.scope.pickupLng ?? 'Not recorded'}<br />
      Drop-off GPS: {item.scope.dropoffLat ?? 'Not recorded'}, {item.scope.dropoffLng ?? 'Not recorded'}</p>
    <p>Driver’s reason: {item.reason}</p>
    <p className="text-sm text-gray-400">Approval applies only to this job, type and these locations. It does not change the job type, billing, stage or saved GPS.</p>
    <label className="block">Review reason<textarea aria-label={`Review reason for ${item.scope.jobId}`} value={note} maxLength={1000}
      onChange={e => setNote(e.target.value)} className="mt-1 block w-full rounded bg-gray-800 p-2" /></label>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    <div className="flex gap-3"><button disabled={busy || !note.trim()} onClick={() => void act('approve')}
      className="rounded bg-green-700 px-4 py-2 disabled:opacity-40">Approve this job exception</button>
      <button disabled={busy || !note.trim()} onClick={() => void act('reject')}
        className="rounded border border-red-500 px-4 py-2 disabled:opacity-40">Reject</button></div>
  </article>;
}
export function JobExceptionReviews({ allowed }: { allowed: boolean }) {
  const [items, setItems] = useState<Item[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [lastReview, setLastReview] = useState('');
  const load = useCallback(async () => {
    if (!allowed) { setItems([]); return; }
    setBusy(true); setError('');
    try { const result = await httpsCallable(getFirebaseFunctions(), 'reviewJobExceptions')({ action: 'list' });
      setItems((result.data as { items: Item[] }).items); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load job exceptions'); }
    finally { setBusy(false); }
  }, [allowed]);
  useEffect(() => { void load(); }, [load]);
  const review = async (id: string, action: string, note: string) => {
    await httpsCallable(getFirebaseFunctions(), 'reviewJobExceptions')({ id, action, note });
    setLastReview(action === 'approve' ? 'Job exception approved.' : 'Job exception rejected.');
    await load();
  };
  if (!allowed) return null;
  return <section className="space-y-4 border-t border-gray-700 pt-8" aria-labelledby="job-exceptions-heading"><h2 id="job-exceptions-heading" className="text-xl font-bold">Job exceptions</h2>
    <p className="text-gray-300">Dispatch-only and hybrid drivers request review here, including drivers who also have a staff role. Approval is an explicit staff action.</p>
    <button disabled={busy} onClick={() => void load()} className="rounded bg-gray-800 px-4 py-2">Refresh job exceptions</button>
    {lastReview && <p role="status" className="rounded border border-green-700 bg-green-950/50 px-4 py-3 text-green-200">{lastReview}</p>}
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {!busy && !error && !items.length && <p className="rounded-xl border border-gray-700 bg-gray-900 p-5 text-gray-200">All caught up. No job exceptions need review.</p>}
    {items.map(item => <ExceptionItem key={item.id} item={item} review={review} />)}
  </section>;
}
