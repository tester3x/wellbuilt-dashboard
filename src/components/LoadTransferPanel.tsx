'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { useAuth } from '@/contexts/AuthContext';
import { hasCapability } from '@/lib/auth';
import { getFirebaseAuth, getFirebaseFunctions } from '@/lib/firebase';

type Offer = { id: string; mode: string; wellName: string; fromDriverName: string; fromDriverId?: string; fromDriverHash?: string; toDriverId?: string; toDriverName?: string; reason?: string; totalBBL?: number };
type RosterDriver = { id: string; name: string };
export function LoadTransferPanel({ companyId }: { companyId: string | null }) {
  const { user, userCompany } = useAuth();
  const visible = hasCapability(user, 'viewDispatch', userCompany);
  const canAssign = hasCapability(user, 'createDispatch', userCompany);
  const [offers, setOffers] = useState<Offer[]>([]), [drivers, setDrivers] = useState<RosterDriver[]>([]);
  const [chosen, setChosen] = useState<Record<string, string>>({}), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const scope = useRef(companyId); scope.current = companyId;
  const refresh = useCallback(async () => {
    if (!visible || !companyId || document.visibilityState === 'hidden') return;
    const owner = getFirebaseAuth().currentUser;
    try {
      const result = await httpsCallable(getFirebaseFunctions(), 'staffLoadTransfers')({ action: 'list', viewedCompanyId: companyId });
      if (getFirebaseAuth().currentUser !== owner || scope.current !== companyId) return;
      const data = result.data as { companyId: string; requests: Offer[]; drivers: RosterDriver[] };
      if (data.companyId !== companyId || !Array.isArray(data.requests) || !Array.isArray(data.drivers)) throw new Error('Transfer response could not be verified');
      setOffers(data.requests); setDrivers(data.drivers); setError('');
    } catch (e) { if (getFirebaseAuth().currentUser === owner && scope.current === companyId) setError(e instanceof Error ? e.message : 'Could not load transfer requests'); }
  }, [visible, companyId]);
  useEffect(() => {
    setOffers([]); setDrivers([]); setError('');
    void refresh(); const timer = setInterval(() => { void refresh(); }, 15000);
    const focus = () => { void refresh(); }; document.addEventListener('visibilitychange', focus);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', focus); };
  }, [refresh]);
  async function act(action: 'assign' | 'decline', offer: Offer) {
    if (!canAssign || busy) return;
    if (action === 'assign' && !chosen[offer.id]) return;
    if (action === 'decline' && !window.confirm(`Decline the load-transfer offer from ${offer.fromDriverName}? The sender keeps the load.`)) return;
    setBusy(offer.id); setError('');
    try {
      const result = await httpsCallable(getFirebaseFunctions(), 'staffLoadTransfers')({ action, requestId: offer.id, viewedCompanyId: companyId,
        ...(action === 'assign' ? { driverId: chosen[offer.id] } : {}) });
      if ((result.data as { ok?: boolean }).ok !== true) throw new Error('Transfer action was not confirmed');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Transfer action failed'); }
    finally { setBusy(''); }
  }
  if (!visible || !companyId || (!offers.length && !error)) return null;
  return <section aria-label="Load transfers" className="mb-3 rounded-lg border border-amber-500/40 bg-gray-800 p-4">
    <h2 className="mb-2 font-semibold text-amber-300">Load transfers{offers.length ? ` · ${offers.length}` : ''}</h2>
    {error && <p role="alert" className="mb-2 text-sm text-red-300">{error}</p>}
    <div className="space-y-3">{offers.map(offer => <div key={offer.id} className="rounded border border-gray-600 p-3">
      <div className="font-medium text-white">{offer.wellName} · {offer.totalBBL ?? '—'} BBL</div>
      <p className="text-sm text-gray-300">From {offer.fromDriverName}{offer.toDriverName ? ` → ${offer.toDriverName}` : ' · Needs a receiving driver'}</p>
      {offer.reason && <p className="mt-1 text-sm text-gray-400">{offer.reason}</p>}
      <p className="mt-1 text-xs text-gray-400">The sender keeps the load until the receiver accepts.</p>
      {canAssign && <div className="mt-2 flex flex-wrap gap-2">
        {offer.mode === 'approval' && <>
          <select aria-label={`Receiving driver for ${offer.wellName}`} className="rounded border border-gray-500 bg-gray-900 px-2 py-2 text-white"
            value={chosen[offer.id] || ''} onChange={event => setChosen(old => ({ ...old, [offer.id]: event.target.value }))} disabled={!!busy}>
            <option value="">Choose receiving driver</option>
            {drivers.filter(driver => driver.id !== (offer.fromDriverId || offer.fromDriverHash)).map(driver => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
          </select>
          <button disabled={!!busy || !chosen[offer.id]} onClick={() => { void act('assign', offer); }} className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-40">Send offer</button>
        </>}
        <button disabled={!!busy} onClick={() => { void act('decline', offer); }} className="rounded border border-red-500 px-3 py-2 text-red-300 disabled:opacity-40">Decline offer</button>
      </div>}
    </div>)}</div>
  </section>;
}
