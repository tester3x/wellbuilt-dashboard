'use client';

import { useCallback, useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { AppHeader } from '@/components/AppHeader';
import { useAuth } from '@/contexts/AuthContext';
import { hasCapability } from '@/lib/auth';
import { getFirebaseFunctions } from '@/lib/firebase';
import { JobExceptionReviews } from '@/components/JobExceptionReviews';
import { WellOperatingReviews } from '@/components/WellOperatingReviews';

type Request = { id: string; locationName: string; locationType: string; latitude: number; longitude: number;
  accuracy: number; observedAt: string; driverName: string; driverId: string; jobId: string };
function ReviewItem({ item, onReview }: { item: Request; onReview: (id: string, action: string, point?: Record<string, unknown>) => Promise<void> }) {
  const [latitude, setLatitude] = useState(String(item.latitude));
  const [longitude, setLongitude] = useState(String(item.longitude));
  const [radius, setRadius] = useState('500');
  const [kind, setKind] = useState(item.locationType);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const review = async (action: 'approve' | 'reject') => {
    setBusy(true); setError('');
    try { await onReview(item.id, action, { latitude: Number(latitude), longitude: Number(longitude), radius: Number(radius), locationType: kind, mapVerified: verified }); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not review location'); }
    finally { setBusy(false); }
  };
  return <section className="rounded-xl border border-gray-700 bg-gray-900 p-5 space-y-3">
    <h2 className="text-lg font-semibold text-yellow-400">{item.locationName}</h2>
    <p className="text-sm text-gray-300">Submitted by {item.driverName || item.driverId} · Job {item.jobId}</p>
    <p className="text-sm text-gray-400">Captured {item.observedAt} · GPS accuracy ±{Math.round(item.accuracy)} m</p>
    <div className="flex flex-wrap gap-3">
      <a className="text-blue-400 underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${item.latitude},${item.longitude}`}>Open captured point in Google Maps</a>
      <a className="text-blue-400 underline" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${item.latitude}&mlon=${item.longitude}#map=18/${item.latitude}/${item.longitude}`}>Open in OpenStreetMap</a>
    </div>
    <div className="flex flex-wrap gap-3">
      <label>Latitude<input aria-label={`Approved latitude for ${item.locationName}`} value={latitude} onChange={e => { setLatitude(e.target.value); setVerified(false); }} className="block w-40 rounded bg-gray-800 p-2" /></label>
      <label>Longitude<input aria-label={`Approved longitude for ${item.locationName}`} value={longitude} onChange={e => { setLongitude(e.target.value); setVerified(false); }} className="block w-40 rounded bg-gray-800 p-2" /></label>
      <label>Radius (m)<input type="number" min={10} max={10000} value={radius} onChange={e => setRadius(e.target.value)} className="block w-28 rounded bg-gray-800 p-2" /></label>
      <label>Location type<select value={kind} onChange={e => setKind(e.target.value)} className="block rounded bg-gray-800 p-2"><option value="place">Place</option><option value="well">Well</option><option value="swd">SWD</option></select></label>
    </div>
    <a className="inline-block text-blue-400 underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${Number(latitude)},${Number(longitude)}`}>Check proposed approval point on map</a>
    <label className="flex items-center gap-2"><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />I verified the approval point on a map.</label>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    <div className="flex gap-3"><button disabled={busy || !verified} onClick={() => void review('approve')} className="rounded bg-green-700 px-4 py-2 disabled:opacity-40">Approve saved location</button>
      <button disabled={busy} onClick={() => void review('reject')} className="rounded border border-red-500 px-4 py-2 disabled:opacity-40">Reject</button></div>
  </section>;
}

export default function LocationReviewPage() {
  const { user, userCompany, loading } = useAuth();
  const allowed = hasCapability(user, 'createDispatch', userCompany) || hasCapability(user, 'manageCompany', userCompany);
  const [items, setItems] = useState<Request[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!user || !allowed) return;
    setBusy(true); setError('');
    try { const response = await httpsCallable(getFirebaseFunctions(), 'reviewArrivalLocations')({ action: 'list' }); setItems((response.data as { items: Request[] }).items); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load location requests'); }
    finally { setBusy(false); }
  }, [user, allowed]);
  useEffect(() => { void load(); }, [load]);
  const review = async (id: string, action: string, point?: Record<string, unknown>) => {
    await httpsCallable(getFirebaseFunctions(), 'reviewArrivalLocations')({ id, action, ...point });
    await load();
  };
  return <><AppHeader /><main className="mx-auto max-w-4xl space-y-5 p-6 text-white">
    <h1 className="text-2xl font-bold">Location Review</h1>
    <p className="text-gray-300">Driver GPS proposals stay pending until dispatch/admin verifies and approves the location. Use Anyway acknowledgments do not change saved locations.</p>
    {loading ? <p>Loading…</p> : !allowed ? <p>Dispatch or company administration access is required.</p> : <>
      <button onClick={() => void load()} disabled={busy} className="rounded bg-gray-800 px-4 py-2">{busy ? 'Loading…' : 'Refresh requests'}</button>
      {error && <p role="alert" className="text-red-400">{error}</p>}
      {!busy && !error && items.length === 0 && <p>No pending location requests.</p>}
      {items.map(item => <ReviewItem key={item.id} item={item} onReview={review} />)}
      <JobExceptionReviews allowed={allowed} />
      <WellOperatingReviews />
    </>}
  </main></>;
}
