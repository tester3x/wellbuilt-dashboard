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
type Well = { wellName: string; route: string; operator: string };
type TankGroup = { groupId: string; name: string; wellNames: string[]; route: string; operator: string; config: Config;
  status: null | { projectedFeet: number | null; dailyUseBbl: number; daysRemaining: number | null; asOfUTC: string } };

export default function FreshWaterDispatchPage() {
  const { user, userCompany } = useAuth();
  const canManageWells = hasCapability(user, 'manageWells', userCompany);
  const canPublish = hasCapability(user, 'manageDrivers', userCompany);
  const [wells, setWells] = useState<Well[]>([]);
  const [groups, setGroups] = useState<TankGroup[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [groupName, setGroupName] = useState('');
  const [linkedWells, setLinkedWells] = useState<string[]>([]);
  const [tankCount, setTankCount] = useState('2');
  const [height, setHeight] = useState('20');
  const [bblFoot, setBblFoot] = useState('20');
  const [dailyUse, setDailyUse] = useState('15');
  const [initialLevel, setInitialLevel] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');

  const refresh = useCallback(async () => {
    const call = httpsCallable<Record<string, never>, { ok: boolean; wells: Well[]; groups: TankGroup[] }>(
      getFirebaseFunctions(), 'staffListFreshWaterTankGroups');
    const result = await call({});
    setWells(result.data.wells || []);
    setGroups(result.data.groups || []);
  }, []);
  useEffect(() => { if (user) refresh().catch(e => setMessage(e.message || String(e))); }, [user, refresh]);

  const configured = useMemo(() => [...groups].sort((a, b) =>
    (a.status?.daysRemaining ?? Infinity) - (b.status?.daysRemaining ?? Infinity)), [groups]);
  const used = useMemo(() => new Set(groups.flatMap(group => group.wellNames)), [groups]);
  const available = useMemo(() => wells.filter(well =>
    (!used.has(well.wellName) || linkedWells.includes(well.wellName))
    && `${well.wellName} ${well.route} ${well.operator}`.toLowerCase().includes(search.toLowerCase())).slice(0, 100),
  [wells, used, linkedWells, search]);
  const selectedGroup = groups.find(group => group.groupId === selectedId);
  const selectedRoute = wells.find(well => linkedWells.includes(well.wellName))?.route;

  const choose = (group: TankGroup) => {
    setSelectedId(group.groupId); setGroupName(group.name); setLinkedWells(group.wellNames);
    setTankCount(String(group.config.tankCount)); setHeight(String(group.config.tankHeightFeet));
    setBblFoot(String(group.config.bblPerFootPerTank)); setDailyUse(String(group.config.dailyUseBbl));
    setInitialLevel(''); setMessage('');
  };
  const newGroup = () => {
    setSelectedId(''); setGroupName(''); setLinkedWells([]);
    setTankCount('2'); setHeight('20'); setBblFoot('20'); setDailyUse('15');
    setInitialLevel(''); setMessage('');
  };
  const toggleWell = (name: string) => setLinkedWells(current => current.includes(name)
    ? current.filter(item => item !== name) : [...current, name]);

  const save = async () => {
    const config: Config = { enabled: true, tankCount: Number(tankCount), tankHeightFeet: Number(height),
      bblPerFootPerTank: Number(bblFoot), dailyUseBbl: Number(dailyUse) };
    const initial = initialLevel.trim() ? Number(initialLevel) : undefined;
    if (!groupName.trim() || linkedWells.length < 1
      || new Set(linkedWells.map(name => wells.find(well => well.wellName === name)?.route.toLowerCase())).size !== 1
      || !Number.isInteger(config.tankCount) || config.tankCount < 1 || config.tankCount > 3
      || !Number.isFinite(config.tankHeightFeet) || config.tankHeightFeet <= 0
      || !Number.isFinite(config.bblPerFootPerTank) || config.bblPerFootPerTank <= 0
      || !Number.isFinite(config.dailyUseBbl) || config.dailyUseBbl < 0
      || (initial !== undefined && (!Number.isFinite(initial) || initial < 0 || initial > config.tankHeightFeet))) {
      setMessage('Name the tank group, link wells on one route, and check the tank measurements and starting level.'); return;
    }
    setBusy(true);
    try {
      await httpsCallable(getFirebaseFunctions(), 'staffConfigureFreshWaterTankGroup')({
        ...(selectedId ? { groupId: selectedId } : {}), name: groupName.trim(), wellNames: linkedWells,
        config, ...(initial === undefined ? {} : { initialLevelFeet: initial }),
      });
      await refresh();
      setMessage(`${groupName.trim()} saved${initial === undefined ? '' : ' with its starting level'}.`);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const publish = async () => {
    setBusy(true);
    try {
      const result = await httpsCallable<Record<string, unknown>, { revision: number }>(
        getFirebaseFunctions(), 'publishJobPacketRevision')({
          requestId: 'fresh-water-tank-refill-water-hauling-revision-5', expectedLatestRevision: 4, packetDraft,
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
          <p className="text-slate-400 text-sm">One physical tank group can supply several wells. Only linked wells appear in refill work.</p></div>
        <button className="rounded bg-slate-700 px-3 py-2 text-sm" onClick={() => refresh().catch(e => setMessage(e.message || String(e)))}>Refresh levels</button>
      </div>
      {message && <div role="status" className="rounded bg-slate-800 px-3 py-2 text-sm">{message}</div>}
      {canPublish && <section className="rounded border border-cyan-900 bg-slate-800 p-4">
        <h2 className="font-semibold">Activate the refill ticket type</h2>
        <p className="text-xs text-slate-400 mb-3">Publish water-hauling revision 5 for this company. Existing tickets keep their pinned revision.</p>
        <button disabled={busy} onClick={publish} className="rounded bg-cyan-700 px-3 py-2 text-sm disabled:opacity-50">Publish revision 5</button>
      </section>}
      <section className="rounded border border-slate-700 bg-slate-800 p-4">
        <h2 className="font-semibold mb-2">Refill queue</h2>
        <p className="text-xs text-slate-400 mb-3">One row per tank group. Confirm the actual level before dispatch.</p>
        {configured.length === 0 ? <p className="text-slate-400">No fresh-water tank groups configured.</p> :
          <div className="grid gap-2 md:grid-cols-2">{configured.map(group => <button key={group.groupId} onClick={() => choose(group)} className="text-left rounded border border-slate-600 p-3 hover:border-cyan-500">
            <div className="flex justify-between gap-2"><strong>{group.name}</strong><span className="text-cyan-300">{group.status?.projectedFeet == null ? 'Needs reading' : `${group.status.projectedFeet.toFixed(1)} ft`}</span></div>
            <div className="text-xs text-slate-400">{group.wellNames.join(', ')} · {group.config.tankCount} tank(s) · {group.config.tankHeightFeet} ft high · {group.status?.dailyUseBbl ?? group.config.dailyUseBbl} BBL/day · {group.status?.daysRemaining == null ? 'Days unknown' : `${group.status.daysRemaining.toFixed(1)} days to empty`}</div>
          </button>)}</div>}
      </section>
      {canManageWells && <section className="rounded border border-slate-700 bg-slate-800 p-4 space-y-3">
        <div className="flex justify-between gap-3"><h2 className="font-semibold">Tank group setup</h2><button onClick={newGroup} className="rounded bg-slate-700 px-3 py-1 text-sm">New group</button></div>
        <p className="text-xs text-slate-400">Name the physical tank group, select every well it supplies, and enter this group&apos;s own tank dimensions. Wells without a fresh-water tank stay unlinked.</p>
        <label className="block text-xs text-slate-300">Group name<input value={groupName} onChange={e => setGroupName(e.target.value)} placeholder="e.g. Gabriel 1, 4, 5, 6" className="mt-1 w-full rounded bg-slate-900 border border-slate-600 px-3 py-2" /></label>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find wells to link" className="w-full rounded bg-slate-900 border border-slate-600 px-3 py-2" />
        <div className="max-h-48 overflow-auto rounded border border-slate-600">{available.map(well => <label key={well.wellName} className="flex items-center gap-2 px-3 py-2 border-b border-slate-700 text-sm">
          <input type="checkbox" checked={linkedWells.includes(well.wellName)} disabled={!!selectedRoute && selectedRoute !== well.route && !linkedWells.includes(well.wellName)} onChange={() => toggleWell(well.wellName)} />
          <span>{well.wellName}</span><span className="text-slate-500">{well.route}</span>
        </label>)}</div>
        {selectedGroup && <p className="text-xs text-cyan-300">Editing {selectedGroup.name}</p>}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">{([
          ['Tanks (1–3)', tankCount, setTankCount], ['Height per tank (ft)', height, setHeight],
          ['BBL/ft per tank', bblFoot, setBblFoot], ['Daily use (BBL)', dailyUse, setDailyUse],
          ['Starting level (ft)', initialLevel, setInitialLevel],
        ] as const).map(([label, value, setter]) => <label key={label} className="text-xs text-slate-300">{label}<input type="number" min="0" step="any" value={value} onChange={e => setter(e.target.value)} className="mt-1 w-full rounded bg-slate-900 border border-slate-600 px-2 py-2 text-white" /></label>)}</div>
        <p className="text-xs text-slate-400">Starting level is saved once. After deliveries begin, changes to tank geometry or linked wells require a deliberate inventory migration.</p>
        <button onClick={save} disabled={busy} className="rounded bg-cyan-700 px-4 py-2 disabled:opacity-50">{busy ? 'Saving…' : 'Save tank group'}</button>
      </section>}
    </main>
  </div>;
}
