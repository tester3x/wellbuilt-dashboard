'use client';

import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '@/lib/firebase';

type Stop = { name: string; bbls: number };
type Load = { id: string; pickup: string; bbls: number; stops: Stop[]; familyId: string; haulGroupId?: string };
type Scenario = { id: string; kind: 'single' | 'multi_haul' | 'split_ticket'; driverName: string; loads: Load[] };
type DemoDispatch = {
  id: string; exists: boolean; status: string | null; driverStage: string | null;
  driverDest: string | null;
  wellName: string | null; disposal: string | null; bbls: number | null;
  jobType: string | null; operator: string | null; route: string | null;
  currentLevel: string | null; flowRate: string | null; assignedAt: string | null;
  splitGroupId: string | null; splitSequence: number | null; ticketNumber: string | null;
  notes: string | null;
};
type Snapshot = {
  company: string; synthetic: true; enabled: boolean;
  active: { scenario: Scenario; stage: string; dueAt: number } | null;
  featured: Scenario | null; featuredStage: string | null;
  dispatches: DemoDispatch[];
  loads: Array<{ id: string; pickup: string; bbls: number; pullStatus: string;
    tickets: Array<{ id: string; exists: boolean; number: number | null; qty: string | null; destination: string; familyId: string }>;
    invoice: { exists: boolean; status: string | null; totalBBL: number | null; ticketNumbers: string[] } }>;
  history: Array<{ id: string; kind: Scenario['kind']; driverName: string; startedAt: number; closedAt: number }>;
  sequence: number; batchSize: number; batchNumber: number; runInBatch: number;
  nextRunAt: number | null; error: string | null;
};
type View = 'dispatch' | 'mobile' | 'well' | 'tickets' | 'billing';
const nav: Array<{ id: View; label: string }> = [
  { id: 'dispatch', label: 'Dispatch' }, { id: 'mobile', label: 'WB Mobile' },
  { id: 'well', label: 'Well Queue' }, { id: 'tickets', label: 'WB Tickets' },
  { id: 'billing', label: 'WB Billing' },
];
function stageForJob(job: Pick<DemoDispatch, 'driverStage' | 'status'>): string {
  const stages: Record<string, string> = {
    en_route_pickup: 'To Pickup', on_site_pickup: 'At Pickup',
    en_route_dropoff: 'To Drop-off', on_site_dropoff: 'At Drop-off',
  };
  return stages[job.driverStage || ''] || (job.status === 'completed' ? 'Done' : 'Pending');
}
function DemoJobs({ snapshot, clock }: { snapshot: Snapshot; clock: number }) {
  const [tab, setTab] = useState<'active' | 'completed'>('active');
  const [expanded, setExpanded] = useState(true);
  const jobs = snapshot.dispatches.filter(job => job.exists);
  const active = jobs.filter(job => job.status !== 'completed');
  const completed = jobs.filter(job => job.status === 'completed');
  const visible = tab === 'active' ? active : completed;
  const name = snapshot.featured?.driverName || 'Demo driver';
  const pw = visible.filter(job => job.jobType === 'pw').length;
  const sw = visible.filter(job => job.jobType === 'service').length;
  return (
    <div className="dispatch-jobs bg-gray-800 rounded-lg border border-gray-700 flex flex-col min-h-[430px]">
      <div className="flex items-center gap-1 px-4 py-2.5 border-b border-gray-700">
        <button type="button" onClick={() => setTab('active')}
          className={`px-3 py-1 rounded text-sm font-medium ${tab === 'active' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}>
          Active Jobs {active.length > 0 && <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded bg-blue-500/40">{active.length}</span>}
        </button>
        <button type="button" onClick={() => setTab('completed')}
          className={`px-3 py-1 rounded text-sm font-medium ${tab === 'completed' ? 'bg-green-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}>
          Completed {completed.length > 0 && <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded bg-green-600/20 text-green-400">{completed.length}</span>}
        </button>
        <span className="px-3 py-1 text-sm text-gray-400">Projects</span>
        <span className="ml-auto text-[11px] text-amber-300">Read-only demo</span>
      </div>
      <div className="dispatch-jobs-body p-3">
        {!visible.length ? (
          <p className="rounded-lg border border-gray-700/60 bg-gray-900/40 p-6 text-center text-sm text-gray-400">
            {tab === 'active' ? 'The next demo assignment will appear here.' : 'The current run has not closed yet.'}
          </p>
        ) : (
          <div className="border border-gray-700/50 rounded-lg overflow-hidden">
            <button type="button" onClick={() => setExpanded(!expanded)}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-left bg-gray-800 hover:bg-gray-700">
              <span className="w-8 h-8 rounded-full bg-gray-600 text-white flex items-center justify-center text-xs font-bold">{name.charAt(0)}</span>
              <span className="flex-1 min-w-0 flex flex-wrap items-center gap-2 text-sm font-semibold text-white">
                {name}
                {pw > 0 && <span className="px-1.5 py-0.5 bg-blue-600/20 text-blue-400 text-[10px] rounded font-bold">{pw} PW</span>}
                {sw > 0 && <span className="px-1.5 py-0.5 bg-purple-600/20 text-purple-400 text-[10px] rounded font-bold">{sw} SW</span>}
              </span>
              <span className="text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
            </button>
            {expanded && <div className="space-y-1 p-2 bg-gray-900/30">
              {visible.map((job, index) => {
                const pendingMinutes = job.assignedAt ? Math.max(0, Math.floor((clock - Date.parse(job.assignedAt)) / 60_000)) : 0;
                const status = stageForJob(job);
                const split = !!job.splitGroupId;
                return <div key={job.id} className={`py-3 px-4 border rounded-lg ${split ? 'bg-purple-900/25 border-purple-500/50 border-l-[3px]' : 'bg-gray-900/75 border-gray-700/70'}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`inline-flex items-center justify-center w-10 h-5 text-[10px] font-bold rounded ${job.jobType === 'service' ? 'bg-purple-600/30 text-purple-300' : 'bg-blue-600/30 text-blue-300'}`}>
                      {job.jobType === 'service' ? 'SW' : 'PW'}
                    </span>
                    <span className="text-white font-medium text-sm break-words flex-1 min-w-0">{job.wellName || 'Assignment pending'}</span>
                    {split && <span className="inline-flex items-center justify-center h-5 w-[6.5rem] text-[10px] font-bold rounded bg-purple-600/30 text-purple-300">TICKET {String.fromCharCode(64 + (job.splitSequence || 1))}</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs">
                    {job.ticketNumber && <span className="text-gray-400">#{job.ticketNumber}</span>}
                    {job.disposal && <span className="text-cyan-400/70">→ {job.disposal}</span>}
                    {job.operator && <span className="text-gray-300">Operator: {job.operator}</span>}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs text-gray-400">
                    {job.route && <span>Route: <span className="text-gray-200">{job.route}</span></span>}
                    {job.currentLevel && <span>Level at dispatch: <span className="text-gray-200">{job.currentLevel}</span></span>}
                    {job.flowRate && <span>Flow at dispatch: <span className="text-gray-200">{job.flowRate}</span></span>}
                    {job.bbls != null && <span>Planned: <span className="text-gray-200">{job.bbls} BBL</span></span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-3">
                    {tab === 'active' && index === 0 && job.jobType === 'pw' && <span className="inline-flex items-center justify-center h-5 w-[6.5rem] text-[10px] font-bold rounded bg-emerald-600/30 text-emerald-300">★ Next</span>}
                    <span className={`inline-flex items-center justify-center h-5 w-[6.5rem] text-[10px] font-bold rounded ${status === 'Pending' ? 'bg-yellow-600/30 text-yellow-300' : status === 'Done' ? 'bg-green-600/30 text-green-300' : 'bg-blue-600/30 text-blue-300'}`}>
                      {status === 'Pending' && pendingMinutes > 0 ? `Pending · ${pendingMinutes < 60 ? `${pendingMinutes}m` : `${Math.floor(pendingMinutes / 60)}h`}` : status}
                    </span>
                    {job.driverDest && status !== 'Pending' && status !== 'Done' && <span className="text-gray-500 text-xs truncate max-w-[140px]" title={job.driverDest}>{job.driverDest}</span>}
                  </div>
                </div>;
              })}
            </div>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function LiveDemoPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('dispatch');
  const [clock, setClock] = useState(0);
  useEffect(() => {
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let stopped = false;
    let busy = false;
    const fetchSnapshot = async () => {
      if (stopped || busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const response = await httpsCallable<undefined, Snapshot>(getFirebaseFunctions(), 'liveDemoSnapshot')();
        if (!stopped) { setSnapshot(response.data); setError(''); }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : 'Live demo is unavailable.');
      } finally { busy = false; }
    };
    void fetchSnapshot();
    const timer = window.setInterval(() => { void fetchSnapshot(); }, 10_000);
    document.addEventListener('visibilitychange', fetchSnapshot);
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', fetchSnapshot); };
  }, []);
  const featured = snapshot?.featured;
  const activeCount = snapshot?.dispatches.filter(job => job.exists && job.status !== 'completed').length || 0;
  const liveStage = snapshot?.dispatches.find(job => job.exists)?.driverStage ||
    (snapshot?.dispatches.some(job => job.status === 'completed') ? 'completed' : 'pending');
  const remaining = snapshot?.active ? Math.max(0, Math.ceil((snapshot.active.dueAt - clock) / 1_000)) : snapshot?.nextRunAt ? Math.max(0, Math.ceil((snapshot.nextRunAt - clock) / 1_000)) : null;
  return <main className="min-h-screen bg-[#0b1424] text-white">
    <div className="border-b border-amber-600/40 bg-amber-950/20 px-4 py-2 text-xs sm:text-sm flex flex-wrap justify-between gap-2">
      <span><strong className="text-amber-300">LIVE DEMO</strong> · {snapshot?.company || 'Demo company'} · synthetic data · read-only</span>
      <span>{snapshot ? `Set ${snapshot.batchNumber} · run ${snapshot.runInBatch}/${snapshot.batchSize}` : 'Connecting…'}{remaining != null ? ` · next step ${remaining}s` : ''}</span>
    </div>
    <header className="bg-gray-800 border-b border-gray-700">
      <div className="px-3 pt-4 text-center"><h1 className="text-xl sm:text-3xl font-bold">WellBuilt Suite</h1><p className="text-gray-400 text-sm">{snapshot?.company || 'Demo company'} · Operations</p></div>
      <nav aria-label="Demo dashboard navigation" className="flex flex-wrap justify-center gap-x-1 px-2 pt-2">
        {nav.filter(item => item.id !== 'well').map(item => <button key={item.id} type="button" onClick={() => setView(item.id)}
          className={`whitespace-nowrap px-3 py-2 text-sm font-medium border-b-2 ${view === item.id ? 'border-blue-500 text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>{item.label}</button>)}
      </nav>
    </header>
    <div className="px-4 py-4 max-w-[1600px] mx-auto">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
        <span className="text-gray-300">{featured ? `${featured.driverName} · ${featured.id} · ${stageForJob({ driverStage: liveStage, status: liveStage === 'completed' ? 'completed' : 'pending' })}` : 'Waiting for the next run'}</span>
        <button type="button" onClick={() => setView('dispatch')} className="rounded border border-gray-600 px-3 py-1.5 text-gray-300">Watch Dispatch Jobs</button>
      </div>
      {(error || snapshot?.error) && <div role="alert" className="mb-4 rounded border border-amber-600 bg-amber-950/30 p-3 text-sm text-amber-200">{error || `Demo step retrying: ${snapshot?.error}`}</div>}
      {view === 'dispatch' ? <>
        <div className="flex gap-2 border-b border-gray-700 pb-2 mb-3 text-sm">
          <span className="px-3 py-1.5 text-gray-400">Build Job</span><button type="button" onClick={() => setView('well')} className="px-3 py-1.5 text-gray-400">Well Queue</button><span className="px-3 py-1.5 rounded bg-blue-600">Jobs</span>
        </div>
        {snapshot ? <DemoJobs snapshot={snapshot} clock={clock} /> : <div className="p-6 bg-gray-800 rounded-lg text-gray-400">Loading Dispatch Jobs…</div>}
      </> : view === 'mobile' ? <div className="mx-auto max-w-md rounded-2xl border border-gray-700 bg-[#070b15] overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-800 text-center font-bold">WellBuilt Tickets · My Jobs</div>
        <div className="p-5"><p className="text-xs uppercase tracking-widest text-amber-400">{snapshot?.dispatches[0] ? stageForJob(snapshot.dispatches[0]) : 'Pending'}</p><h2 className="mt-2 text-xl font-bold">{featured?.loads[0]?.pickup || 'Waiting for dispatch'}</h2><p className="mt-1 text-gray-400">{featured?.driverName}</p>
          {featured?.loads.map((load, i) => <div key={load.id} className="mt-4 rounded-xl border border-gray-700 bg-[#111a2a] p-4"><strong>Load {i + 1} · {load.bbls} BBL</strong><p className="mt-2 text-sm text-gray-300">Pickup · {load.pickup}</p><p className="mt-1 text-sm text-gray-300">Drop-off · {load.stops.map(stop => stop.name).join(' → ')}</p></div>)}
        </div>
      </div> : view === 'well' ? <div className="rounded-lg border border-gray-700 bg-gray-800 p-4"><h2 className="text-lg font-bold">Well Queue · Pull activity</h2><div className="mt-4 grid gap-2 sm:grid-cols-2">{snapshot?.loads.map(load => <div key={load.id} className="rounded border border-gray-700 bg-gray-900 p-4"><strong>{load.pickup}</strong><p className="mt-2 text-sm text-gray-400">{load.bbls} BBL · {load.pullStatus}</p></div>)}</div></div>
      : view === 'tickets' ? <div className="rounded-lg border border-gray-700 bg-gray-800 p-4"><h2 className="text-lg font-bold">WB Tickets</h2><div className="mt-4 space-y-2">{snapshot?.loads.flatMap(load => load.tickets).map(ticket => <div key={ticket.id} className="rounded border border-gray-700 bg-gray-900 p-4 flex flex-wrap justify-between gap-2"><strong>{ticket.exists ? `#${ticket.number}` : 'Awaiting ticket'}</strong><span>{ticket.destination} · {ticket.qty || 'Planned'} BBL</span></div>)}</div></div>
      : <div className="rounded-lg border border-gray-700 bg-gray-800 p-4"><h2 className="text-lg font-bold">WB Billing</h2><div className="mt-4 space-y-2">{snapshot?.loads.map(load => <div key={load.id} className="rounded border border-gray-700 bg-gray-900 p-4 flex flex-wrap justify-between gap-2"><strong>{load.pickup}</strong><span>{load.invoice.exists ? `${load.invoice.totalBBL} BBL · ${load.invoice.status}` : 'Awaiting tickets'}</span></div>)}</div></div>}
      {view === 'well' && <button type="button" className="mt-4 text-sm text-blue-300" onClick={() => setView('dispatch')}>Back to Dispatch Jobs</button>}
      <p className="mt-5 text-xs text-gray-500">This view shows read-only records from the dedicated demo company. Dashboard actions are disabled.</p>
      {activeCount === 0 && snapshot?.history.length ? <p className="mt-2 text-xs text-gray-500">Latest completed run: {snapshot.history[0].id}</p> : null}
    </div>
  </main>;
}
