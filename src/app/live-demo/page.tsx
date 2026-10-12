'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '@/lib/firebase';

type Stop = { name: string; bbls: number };
type Load = { id: string; pickup: string; bbls: number; stops: Stop[]; familyId: string; haulGroupId?: string };
type Scenario = {
  id: string; kind: 'single' | 'multi_haul' | 'split_ticket';
  driverName: string; loads: Load[];
};
type Snapshot = {
  company: string; synthetic: true; enabled: boolean;
  active: { scenario: Scenario; stage: string; dueAt: number; startedAt: number } | null;
  history: Array<{ id: string; kind: Scenario['kind']; driverName: string; startedAt: number; closedAt: number }>;
  dispatches: Array<{ id: string; exists: boolean; status: string | null }>;
  sequence: number; startedToday: number; dailyCap: number; error: string | null; observedAt: number;
};

const stageNames: Record<string, string> = {
  pending: 'Dispatching', accepted: 'Job accepted', at_pickup: 'At pickup',
  departed: 'Loaded · en route', at_dropoff: 'At destination', closed: 'Closing tickets',
};
const kindNames: Record<Scenario['kind'], string> = {
  single: 'Production water', multi_haul: 'Multi-haul', split_ticket: 'Split ticket',
};

export default function LiveDemoPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stopped = false;
    let busy = false;
    const fetchSnapshot = async () => {
      if (stopped || busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const call = httpsCallable<undefined, Snapshot>(getFirebaseFunctions(), 'liveDemoSnapshot');
        const response = await call();
        if (!stopped) { setSnapshot(response.data); setError(''); }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : 'Live demo is unavailable.');
      } finally { busy = false; }
    };
    void fetchSnapshot();
    const timer = window.setInterval(() => { void fetchSnapshot(); }, 10_000);
    document.addEventListener('visibilitychange', fetchSnapshot);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', fetchSnapshot);
    };
  }, []);

  const active = snapshot?.active;
  return (
    <main className="min-h-screen bg-[#08101e] px-4 py-6 text-slate-100 sm:px-8 sm:py-10">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.26em] text-cyan-300">WellBuilt · live operations</p>
            <h1 className="mt-2 text-3xl font-bold sm:text-5xl">A load from dispatch to ticket</h1>
            <p className="mt-3 max-w-2xl text-slate-300">Synthetic drivers and locations move through the real WellBuilt backend under a dedicated demo company.</p>
          </div>
          <Link href="/demo" className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:border-cyan-400">Try location setup</Link>
        </div>

        <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
          <span className={`rounded-full px-3 py-1 font-semibold ${snapshot?.enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700 text-slate-300'}`}>
            {snapshot?.enabled ? '● Live demo running' : snapshot ? 'Paused' : 'Connecting…'}
          </span>
          <span className="rounded-full bg-blue-500/15 px-3 py-1 text-blue-200">Demo company</span>
          <span className="rounded-full bg-amber-500/15 px-3 py-1 text-amber-200">Synthetic data</span>
          {snapshot && <span className="text-slate-400">{snapshot.startedToday} of {snapshot.dailyCap} runs today</span>}
        </div>

        {error && <div role="alert" className="mb-6 rounded-xl border border-rose-500/50 bg-rose-950/40 p-4 text-rose-200">{error}</div>}
        {snapshot?.error && <div role="alert" className="mb-6 rounded-xl border border-amber-500/50 bg-amber-950/30 p-4 text-amber-200">The current demo step is retrying: {snapshot.error}</div>}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
          <section className="rounded-2xl border border-slate-700 bg-[#111c2e] p-5 sm:p-7">
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Current run</p>
                <h2 className="mt-1 text-2xl font-bold">{active ? kindNames[active.scenario.kind] : 'Waiting for the next load'}</h2>
              </div>
              {active && <span className="rounded-lg bg-cyan-500/20 px-3 py-2 font-semibold text-cyan-200">{stageNames[active.stage] || active.stage}</span>}
            </div>
            {active ? (
              <>
                <div className="mb-5 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-300">
                  <span>Driver <strong className="text-white">{active.scenario.driverName}</strong></span>
                  <span>Run <strong className="font-mono text-white">{active.scenario.id}</strong></span>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {active.scenario.loads.map((load, i) => (
                    <div key={load.id} className="rounded-xl border border-slate-600 bg-[#0b1525] p-5">
                      <div className="mb-4 flex items-center justify-between gap-2">
                        <strong className="text-lg">Load {i + 1}</strong>
                        <span className="rounded-full bg-emerald-600/20 px-3 py-1 text-sm font-bold text-emerald-300">{load.bbls} BBL</span>
                      </div>
                      <p className="text-xs uppercase tracking-wide text-slate-400">Pickup</p>
                      <p className="mt-1 font-semibold">{load.pickup}</p>
                      <div className="my-4 border-l-2 border-cyan-700 pl-4">
                        {load.stops.map((stop, index) => (
                          <div key={`${stop.name}-${index}`} className="py-2">
                            <p className="text-xs uppercase tracking-wide text-slate-400">Drop-off {index + 1}</p>
                            <p className="font-semibold">{stop.name} <span className="text-cyan-300">· {stop.bbls} BBL</span></p>
                          </div>
                        ))}
                      </div>
                      <p className="break-all text-xs text-slate-500">Ticket family {load.familyId}</p>
                      {load.haulGroupId && <p className="mt-1 break-all text-xs text-violet-300">Shared haul {load.haulGroupId}</p>}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="rounded-xl border border-dashed border-slate-600 p-8 text-center text-slate-400">
                {snapshot?.enabled ? 'The next run starts automatically while this page is open.' : 'The demo is paused.'}
              </p>
            )}
          </section>

          <aside className="rounded-2xl border border-slate-700 bg-[#111c2e] p-5 sm:p-7">
            <h2 className="text-xl font-bold">Backend status</h2>
            <p className="mt-2 text-sm text-slate-400">These dispatch records are read back from the same database used by WellBuilt Dispatch.</p>
            <div className="mt-5 space-y-3">
              {snapshot?.dispatches.length ? snapshot.dispatches.map(dispatch => (
                <div key={dispatch.id} className="rounded-lg bg-[#0b1525] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="break-all font-mono text-xs text-slate-300">{dispatch.id}</span>
                    <span className={`shrink-0 text-xs font-bold ${dispatch.exists ? 'text-emerald-300' : 'text-amber-300'}`}>{dispatch.status || 'Creating'}</span>
                  </div>
                </div>
              )) : <p className="text-sm text-slate-500">No active dispatch yet.</p>}
            </div>
          </aside>
        </div>

        <section className="mt-5 rounded-2xl border border-slate-700 bg-[#111c2e] p-5 sm:p-7">
          <h2 className="text-xl font-bold">Recent completed runs</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {snapshot?.history.length ? snapshot.history.map(run => (
              <div key={run.id} className="rounded-lg border border-slate-700 bg-[#0b1525] p-4">
                <p className="font-semibold">{kindNames[run.kind]}</p>
                <p className="mt-1 text-sm text-slate-300">{run.driverName}</p>
                <p className="mt-2 font-mono text-xs text-slate-500">{run.id} · {new Date(run.closedAt).toLocaleTimeString()}</p>
              </div>
            )) : <p className="text-sm text-slate-500">Runs will appear here as they close.</p>}
          </div>
        </section>
      </div>
    </main>
  );
}
