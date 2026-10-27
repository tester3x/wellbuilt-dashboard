'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { httpsCallable } from 'firebase/functions';
import { AppHeader } from '@/components/AppHeader';
import { useAuth } from '@/contexts/AuthContext';
import { getFirebaseFunctions } from '@/lib/firebase';
import { hasCapability } from '@/lib/auth';
import packetDraft from '../../../../release/pw-fieldtest/pw-revision-5-fresh-water-tank-refill.json';

type Config = { enabled: true; tankCount: number; tankHeightFeet: number; bblPerFootPerTank: number; dailyUseBbl: number };
type Pad = { wellName: string; route: string; operator: string; config: Config | null;
  status: null | { projectedFeet: number | null; dailyUseBbl: number; daysRemaining: number | null; asOfUTC: string } };

export default function FreshWaterDispatchPage() {
  const { user, userCompany } = useAuth();
  const canManageWells = hasCapability(user, 'manageWells', userCompany);
  const canPublish = hasCapability(user, 'manageDrivers', userCompany);
  const [pads, setPads] = useState<Pad[]>([]);
  const [selected, setSelected] = useState('');
  const [tankCount, setTankCount] = useState('2');
  const [height, setHeight] = useState('20');
  const [bblFoot, setBblFoot] = useState('20');
  const [dailyUse, setDailyUse] = useState('15');
  const [initialLevel, setInitialLevel] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');

  const refresh = useCallback(async () => {
    const call = httpsCallable<Record<string, never>, { ok: boolean; pads: Pad[] }>(getFirebaseFunctions(), 'staffListFreshWaterPads');
    const result = await call({});
    setPads(result.data.pads || []);
  }, []);
  useEffect(() => { if (user) refresh().catch(e => setMessage(e.message || String(e))); }, [user, refresh]);

  const configured = useMemo(() => pads.filter(p => p.config).sort((a, b) =>
    (a.status?.daysRemaining ?? Infinity) - (b.status?.daysRemaining ?? Infinity)), [pads]);
  const candidates = useMemo(() => pads.filter(p => !p.config &&
    `${p.wellName} ${p.route} ${p.operator}`.toLowerCase().includes(search.toLowerCase())).slice(0, 30), [pads, search]);
  const chosen = pads.find(p => p.wellName === selected);

  const choose = (p: Pad) => {
    setSelected(p.wellName);
    setTankCount(String(p.config?.tankCount ?? 2));
    setHeight(String(p.config?.tankHeightFeet ?? 20));
    setBblFoot(String(p.config?.bblPerFootPerTank ?? 20));
    setDailyUse(String(p.config?.dailyUseBbl ?? 15));
    setInitialLevel('');
    setMessage('');
  };
  const save = async () => {
    const config: Config = { enabled: true, tankCount: Number(tankCount), tankHeightFeet: Number(height),
      bblPerFootPerTank: Number(bblFoot), dailyUseBbl: Number(dailyUse) };
    const initial = initialLevel.trim() ? Number(initialLevel) : undefined;
    if (!selected || !Number.isInteger(config.tankCount) || config.tankCount < 1 || config.tankCount > 3
      || !Number.isFinite(config.tankHeightFeet) || config.tankHeightFeet <= 0
      || !Number.isFinite(config.bblPerFootPerTank) || config.bblPerFootPerTank <= 0
      || !Number.isFinite(config.dailyUseBbl) || config.dailyUseBbl < 0
      || (initial !== undefined && (!Number.isFinite(initial) || initial < 0 || initial > config.tankHeightFeet))) {
      setMessage('Check tank count (1–3), dimensions, daily use, and starting level.'); return;
    }
    setBusy(true);
    try {
      await httpsCallable(getFirebaseFunctions(), 'staffConfigureFreshWaterPad')({
        wellName: selected, config, ...(initial === undefined ? {} : { initialLevelFeet: initial }),
      });
      await refresh();
      setMessage(`${selected} configured${initial === undefined ? '' : ' and starting level saved'}.`);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const publish = async () => {
    setBusy(true);
    try {
      const result = await httpsCallable<Record<string, unknown>, { revision: number }>(
        getFirebaseFunctions(), 'publishJobPacketRevision')({
          requestId: 'fresh-water-tank-refill-water-hauling-revision-5',
          expectedLatestRevision: 4,
          packetDraft,
        });
      setMessage(`Water-hauling packet revision ${result.data.revision} published for this company.`);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return <div className="min-h-screen bg-gray-900 text-white"><AppHeader />
    <main className="max-w-6xl mx-auto p-4 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><Link href="/dispatch" className="text-cyan-400 text-sm">← Dispatch</Link>
          <h1 className="text-2xl font-bold">Fresh Water Tank Refill</h1>
          <p className="text-slate-400 text-sm">Single loads · hourly service · tanks fall between deliveries</p></div>
        <button className="rounded bg-slate-700 px-3 py-2 text-sm" onClick={() => refresh().catch(e => setMessage(e.message || String(e)))}>Refresh levels</button>
      </div>
      {message && <div role="status" className="rounded bg-slate-800 px-3 py-2 text-sm">{message}</div>}
      {canPublish && <section className="rounded border border-cyan-900 bg-slate-800 p-4">
        <h2 className="font-semibold">Activate the refill ticket type</h2>
        <p className="text-xs text-slate-400 mb-3">Publish the immutable water-hauling revision 5 for this company. Existing tickets keep their pinned revision.</p>
        <button disabled={busy} onClick={publish} className="rounded bg-cyan-700 px-3 py-2 text-sm disabled:opacity-50">Publish revision 5</button>
      </section>}
      <section className="rounded border border-slate-700 bg-slate-800 p-4">
        <h2 className="font-semibold mb-2">Refill queue</h2>
        <p className="text-xs text-slate-400 mb-3">Estimated from each pad&apos;s measured level, deliveries, and daily use. Confirm actual level before dispatch.</p>
        {configured.length === 0 ? <p className="text-slate-400">No fresh water pads configured.</p> :
          <div className="grid gap-2 md:grid-cols-2">{configured.map(p => <button key={p.wellName} onClick={() => choose(p)} className="text-left rounded border border-slate-600 p-3 hover:border-cyan-500">
            <div className="flex justify-between gap-2"><strong>{p.wellName}</strong><span className="text-cyan-300">{p.status?.projectedFeet == null ? 'Needs reading' : `${p.status.projectedFeet.toFixed(1)} ft`}</span></div>
            <div className="text-xs text-slate-400">{p.route} · {p.config?.tankCount} tank(s) · {p.status?.dailyUseBbl ?? p.config?.dailyUseBbl} BBL/day · {p.status?.daysRemaining == null ? 'Days unknown' : `${p.status.daysRemaining.toFixed(1)} days to empty`}</div>
          </button>)}</div>}
      </section>
      {canManageWells && <section className="rounded border border-slate-700 bg-slate-800 p-4 space-y-3">
        <h2 className="font-semibold">Pad setup</h2>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a pad to configure" className="w-full rounded bg-slate-900 border border-slate-600 px-3 py-2" />
        <div className="max-h-40 overflow-auto flex flex-wrap gap-2">{candidates.map(p => <button key={p.wellName} onClick={() => choose(p)} className="rounded bg-slate-700 px-2 py-1 text-sm">{p.wellName}</button>)}</div>
        {chosen && <div className="space-y-3 border-t border-slate-600 pt-3">
          <h3 className="font-medium">{chosen.wellName}</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">{([
            ['Tanks (1–3)', tankCount, setTankCount], ['Height (ft)', height, setHeight],
            ['BBL/ft per tank', bblFoot, setBblFoot], ['Daily use (BBL)', dailyUse, setDailyUse],
            ['Starting level (ft)', initialLevel, setInitialLevel],
          ] as const).map(([label, value, setter]) => <label key={label} className="text-xs text-slate-300">{label}<input type="number" min="0" step="any" value={value} onChange={e => setter(e.target.value)} className="mt-1 w-full rounded bg-slate-900 border border-slate-600 px-2 py-2 text-white" /></label>)}</div>
          <p className="text-xs text-slate-400">The starting level is saved only once. Existing tank geometry and use rate require a deliberate migration after deliveries begin.</p>
          <button onClick={save} disabled={busy} className="rounded bg-cyan-700 px-4 py-2 disabled:opacity-50">{busy ? 'Saving…' : 'Save pad setup'}</button>
        </div>}
      </section>}
    </main>
  </div>;
}
