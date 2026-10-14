'use client';

import { useEffect, useRef, useState } from 'react';
import { signInWithCustomToken } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { getDemoViewerAuth, getDemoViewerFunctions, getFirebaseFunctions } from '@/lib/firebase';

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
  companyProfile: { name: string; logoUrl: string; primaryColor: string; invoicingMode: string;
    wellMonitoring: boolean; splitTickets: boolean; liveDispatchSync: boolean };
  active: { scenario: Scenario; stage: string; dueAt: number; startedAt: number; loadIndex?: number } | null;
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
    en_route_pickup: 'En Route · Pickup', on_site_pickup: 'At Pickup',
    en_route_dropoff: 'To Drop-off', on_site_dropoff: 'At Drop-off',
  };
  return stages[job.driverStage || ''] || (job.status === 'completed' ? 'Done' : 'Pending');
}
type PhysicalJob = { load: Load; dispatches: DemoDispatch[]; lead: DemoDispatch };
function physicalJobs(snapshot: Pick<Snapshot, 'featured' | 'dispatches'>): PhysicalJob[] {
  return (snapshot.featured?.loads || []).flatMap(load => {
    const dispatches = snapshot.dispatches.filter(job => job.exists && job.id.startsWith(`${load.id}-leg-`));
    return dispatches.length ? [{ load, dispatches, lead: dispatches[0] }] : [];
  });
}
function currentPhysicalJob(snapshot: Pick<Snapshot, 'featured' | 'dispatches'>): PhysicalJob | undefined {
  const jobs = physicalJobs(snapshot);
  return jobs.find(job => job.lead.status !== 'completed') || jobs[jobs.length - 1];
}
type DemoPhase = 'building' | 'drawer' | 'review' | 'to_pickup' | 'pickup' | 'driving' | 'dropoff' | 'complete';
const STEP_MS = 15_000;
const BUILD_MS = 60_000;
function demoPhase(snapshot: Snapshot | null, clock: number): DemoPhase {
  const job = snapshot ? currentPhysicalJob(snapshot)?.lead : undefined;
  if (!job) return 'building';
  if (job.status === 'completed' && snapshot?.active?.stage === 'pending'
    && (snapshot.active.loadIndex || 0) > 0) return 'drawer';
  if (job.status === 'completed') return 'complete';
  if (job.driverStage === 'on_site_dropoff') return 'dropoff';
  if (job.driverStage === 'en_route_dropoff') return 'driving';
  if (job.driverStage === 'on_site_pickup') return 'pickup';
  if (job.driverStage === 'en_route_pickup') return 'to_pickup';
  const pendingElapsed = snapshot?.active?.stage === 'accepted'
    ? clock - (snapshot.active.dueAt - STEP_MS) : 0;
  return pendingElapsed >= 3_000 ? 'review' : 'drawer';
}
const stepCopy: Record<DemoPhase, string> = {
  building: 'Dispatch builds the PW job while the driver waits for an assignment', drawer: 'Dispatch sends the job; it appears in Jobs and the driver drawer',
  review: 'The driver taps the job, reviews it, then taps Start Job', to_pickup: 'Dispatch changes from Pending to En Route · Pickup', pickup: 'The driver arrives at pickup',
  driving: 'The load leaves pickup and the well pull is recorded',
  dropoff: 'The driver arrives at the destination',
  complete: 'The ticket closes and billing receives the load',
};

function formatCountdown(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function typedPreview(value: string, progress: number, start: number, end: number): string {
  if (progress < start) return '';
  if (progress >= end) return value;
  const length = Math.max(1, Math.ceil(value.length * (progress - start) / (end - start)));
  return value.slice(0, length);
}
function nextPwBuildAt(snapshot: Snapshot): number | null {
  const stages = ['planning', 'pending', 'accepted', 'at_pickup', 'departed', 'at_dropoff', 'closed'];
  const active = snapshot.active;
  let startAt = snapshot.nextRunAt;
  let sequence = snapshot.sequence + 1;
  if (active) {
    const remainingStages = Math.max(0, stages.length - 1 - stages.indexOf(active.stage));
    const remainingLoads = active.scenario.loads.length - 1 - (active.loadIndex || 0);
    startAt = active.dueAt + (remainingStages + remainingLoads * 6) * STEP_MS
      + (active.stage === 'planning' ? BUILD_MS - STEP_MS : 0) + 25_000;
  }
  if (startAt == null) return null;
  while (sequence % 7 === 0) {
    // Split-ticket runs still play, but the guided Dispatch builder waits for PW.
    startAt += BUILD_MS + 5 * STEP_MS + 25_000;
    sequence += 1;
  }
  return startAt;
}

function DemoBuilder({ scenario, progress, dispatched, showCursor }: { scenario: Scenario | null; progress: number; dispatched: boolean; showCursor: boolean }) {
  const load = scenario?.loads[0];
  const split = scenario?.kind === 'split_ticket';
  const root = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState({ x: 42, y: 115 });
  const cursorStep = progress < .03 ? 0 : progress < .12 ? 1 : progress < .15 ? 2
    : progress < .24 ? 3 : progress < .29 ? 4 : progress < .42 ? 5
      : progress < .45 ? 6 : progress < .58 ? 7 : progress < .61 ? 8
        : progress < .7 ? 9 : progress < .76 ? 10 : progress < .89 ? 11 : 12;
  const pickup = load?.pickup || '';
  const dropoff = load?.stops[0]?.name || '';
  const driver = scenario?.driverName || '';
  const fieldStyle = 'mt-1 min-h-9 rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white';
  const suggestionStyle = 'absolute left-0 right-0 top-full z-10 mt-1 rounded border border-cyan-600 bg-[#101a2b] p-1 text-sm text-white shadow-xl';
  useEffect(() => {
    if (!showCursor) return;
    const placeCursor = () => {
      const container = root.current;
      const target = container?.querySelector<HTMLElement>(`[data-demo-cursor="${cursorStep}"]`);
      if (!container || !target) return;
      const parentRect = container.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      setCursor({ x: rect.left - parentRect.left + Math.min(rect.width - 24, cursorStep === 6 ? rect.width / 2 : 105),
        y: rect.top - parentRect.top + (cursorStep === 6 ? rect.height / 2 : rect.height - 13) });
    };
    placeCursor();
    window.addEventListener('resize', placeCursor);
    return () => window.removeEventListener('resize', placeCursor);
  }, [cursorStep, showCursor]);
  return <div ref={root} className="relative rounded-lg border border-purple-700/70 bg-gray-800 p-4">
    <div className="flex items-center justify-between border-b border-gray-700 pb-3 text-xs">
      <div className="flex gap-2"><span className={`rounded px-3 py-1.5 ${!split ? 'bg-blue-700 text-white' : 'text-gray-400'}`}>PW</span><span className={`rounded px-3 py-1.5 ${split ? 'bg-purple-700 text-white' : 'text-gray-400'}`}>SW</span><span className="px-3 py-1.5 text-gray-400">Projects</span></div>
      <span className="text-gray-400">Build Job</span>
    </div>
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      <div className="relative text-xs text-gray-400">Customer / Operator
        <div data-demo-cursor="0" className={fieldStyle}>{progress >= .12 ? 'Demo Operator' : <span className="text-gray-500">Select customer…</span>}</div>
        {progress >= .03 && progress < .12 && <div className={suggestionStyle}>
          <div data-demo-cursor="1" className="rounded bg-cyan-800/60 px-3 py-2 text-white">Demo Operator</div>
          <div className="px-3 py-2 text-gray-400">Other operator</div>
        </div>}
      </div>
      <div className="relative text-xs text-gray-400">Service Type
        <div data-demo-cursor="2" className={fieldStyle}>{progress >= .24 ? split ? 'Service Work · Split Ticket' : 'Production Water' : <span className="text-gray-500">Select type…</span>}</div>
        {progress >= .15 && progress < .24 && <div className={suggestionStyle}>
          <div data-demo-cursor="3" className="rounded bg-cyan-800/60 px-3 py-2 text-white">{split ? 'Service Work' : 'Production Water'}</div>
          <div className="px-3 py-2 text-gray-400">{split ? 'Production Water' : 'Service Work'}</div>
        </div>}
      </div>
      <div className="relative text-xs text-gray-400">Well / Location
        <div data-demo-cursor="4" className={fieldStyle}>{progress >= .42 ? pickup : typedPreview(pickup, progress, .29, .39) || <span className="text-gray-500">Search wells…</span>}{progress >= .29 && progress < .42 && <span className="ml-0.5 animate-pulse text-cyan-300">│</span>}</div>
        {progress >= .29 && progress < .42 && <div className={suggestionStyle}>
          <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-cyan-300">Matching wells</div>
          <div data-demo-cursor="5" className="rounded bg-cyan-800/60 px-3 py-2 text-white">{pickup}</div>
          <div className="px-3 py-2 text-gray-400">Demo Well 2</div>
        </div>}
      </div>
      <div className="relative text-xs text-gray-400">Drop-off
        <div data-demo-cursor="6" className={fieldStyle}>{progress >= .58 ? dropoff : typedPreview(dropoff, progress, .45, .55) || <span className="text-gray-500">Search SWD or location…</span>}{progress >= .45 && progress < .58 && <span className="ml-0.5 animate-pulse text-cyan-300">│</span>}</div>
        {progress >= .45 && progress < .58 && <div className={suggestionStyle}>
          <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-cyan-300">Matching locations</div>
          <div data-demo-cursor="7" className="rounded bg-cyan-800/60 px-3 py-2 text-white">{dropoff}</div>
          <div className="px-3 py-2 text-gray-400">Demo SWD 1</div>
        </div>}
      </div>
      <div className="relative text-xs text-gray-400">Driver
        <div data-demo-cursor="8" className={fieldStyle}>{progress >= .7 ? driver : <span className="text-gray-500">Select driver…</span>}</div>
        {progress >= .61 && progress < .7 && <div className={suggestionStyle}>
          <div data-demo-cursor="9" className="rounded bg-cyan-800/60 px-3 py-2 text-white">{driver}</div>
          <div className="px-3 py-2 text-gray-400">Another demo driver</div>
        </div>}
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs text-gray-400">
        <div>Loads<div data-demo-cursor="10" className={fieldStyle}>{progress >= .76 ? scenario?.loads.length : <span className="text-gray-500">#</span>}</div></div>
        <div>BBLs per load<div data-demo-cursor="11" className={fieldStyle}>{typedPreview(String(load?.bbls || ''), progress, .78, .87) || <span className="text-gray-500">BBLs</span>}{progress >= .78 && progress < .87 && <span className="ml-0.5 animate-pulse text-cyan-300">│</span>}</div></div>
      </div>
    </div>
    {scenario && scenario.loads.length > 1 && progress >= .88 && <div className="mt-3 space-y-1 text-xs text-purple-300">{scenario.loads.map((item, index) => <p key={item.id}>Load {index + 1}: {item.pickup} → {item.stops.map(stop => stop.name).join(' → ')} · {item.bbls} BBL · separate ticket family</p>)}</div>}
    {split && progress >= .88 && <p className="mt-3 text-xs text-purple-300">Split A pickup · {load?.bbls} BBL → {load?.stops.map((stop, i) => `Split ${String.fromCharCode(66 + i)}: ${stop.name} ${stop.bbls} BBL`).join(' · ')}</p>}
    <div className="mt-5 flex gap-2"><span className="rounded border border-gray-600 px-4 py-2 text-xs">Clear</span><div data-demo-cursor="12" className={`flex-1 rounded py-2 text-center text-sm font-semibold transition-transform ${dispatched ? 'bg-green-600 text-white' : progress >= .95 ? 'bg-blue-700 text-white scale-[.98]' : progress >= .89 ? 'bg-blue-600 text-white animate-pulse' : 'bg-gray-600 text-gray-300'}`}>{dispatched ? '✓ Dispatched' : progress >= .95 ? 'Clicking Dispatch…' : 'Dispatch'}</div></div>
    {showCursor && <div aria-hidden="true" className="pointer-events-none absolute z-20 transition-[left,top,transform] duration-700 ease-in-out" style={{ left: cursor.x, top: cursor.y, transform: progress >= .95 && !dispatched ? 'scale(.78)' : 'scale(1)' }}>
      {progress >= .95 && !dispatched && <span className="absolute -left-3 -top-3 h-8 w-8 animate-ping rounded-full bg-cyan-300/70" />}
      <svg width="30" height="36" viewBox="0 0 30 36" fill="none" className="relative drop-shadow-[0_2px_3px_rgba(0,0,0,.8)]"><path d="M3 2v27l7.3-6.5 5.1 10.4 4.7-2.3-5-10.1H25L3 2Z" fill="white" stroke="#111827" strokeWidth="2" strokeLinejoin="round" /></svg>
    </div>}
  </div>;
}

function DemoPhone({ scenario, phase, dispatches, onClose, detailOpen, onOpen, timeToStart }: {
  scenario: Scenario | null; phase: DemoPhase; dispatches: DemoDispatch[];
  onClose: () => void; detailOpen: boolean; onOpen: () => void; timeToStart: number;
}) {
  const current = physicalJobs({ featured: scenario, dispatches }).find(item => item.lead.status !== 'completed')
    || physicalJobs({ featured: scenario, dispatches }).at(-1);
  const job = current?.lead;
  const load = current?.load || scenario?.loads[0];
  const review = phase !== 'drawer' || detailOpen;
  return <aside aria-label="Driver phone demo" className="fixed bottom-3 right-3 z-50 w-[min(340px,calc(100vw-24px))] max-h-[min(620px,calc(100vh-24px))] overflow-auto rounded-[24px] border-4 border-slate-600 bg-[#080d19] text-white shadow-[0_16px_55px_rgba(0,0,0,.7)]">
    <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3 text-xs"><span>10:24 ◉ ▰▰</span><strong>WB T · {scenario?.driverName || 'Driver'}</strong><button type="button" onClick={onClose} aria-label="Close driver phone" className="text-lg text-gray-400">×</button></div>
    {phase === 'building' ? <div className="p-4"><p className="text-sm font-bold text-amber-400">Job Drawer</p><p className="mt-1 text-xs text-gray-400">{scenario?.driverName}</p><div className="mt-5 rounded-xl border border-dashed border-slate-600 bg-[#151d2e] p-5 text-center"><p className="text-lg">🚚</p><p className="mt-2 text-sm font-semibold">Waiting for Dispatch</p><p className="mt-2 text-xs text-gray-400">The PW job will appear here as soon as Dispatch sends it.</p></div></div> : !review ? <div className="p-4"><p className="mb-3 text-sm font-bold text-amber-400">Job Drawer</p><p className="mb-3 text-xs text-gray-400">Today&apos;s jobs · {scenario?.driverName}</p>
      {physicalJobs({ featured: scenario, dispatches }).filter(item => item.lead.status !== 'completed').map((item, index) => <button key={item.load.id} type="button" onClick={onOpen} className="relative mb-2 w-full rounded-xl border border-amber-700/70 bg-[#151d2e] p-4 text-left"><span className="text-[10px] font-bold uppercase text-amber-400">Pending dispatch · Load {index + 1}{item.dispatches.length > 1 ? ` · ${item.dispatches.length} linked split jobs` : ''}</span><p className="mt-2 font-semibold">{item.load.pickup}</p><p className="mt-1 text-xs text-cyan-300">→ {item.load.stops.map(stop => stop.name).join(' → ')}</p><p className="mt-2 text-xs text-gray-400">{item.load.bbls} BBL · Tap to open</p>{timeToStart < STEP_MS - 1_500 && <span aria-hidden="true" className="absolute bottom-2 right-3 animate-bounce text-xl">👆</span>}</button>)}
    </div> : <div className="p-4"><p className="text-[10px] font-bold uppercase tracking-widest text-amber-400">{phase === 'review' || phase === 'drawer' ? 'Job Review' : stageForJob(job || { driverStage: null, status: null })}</p><h2 className="mt-2 text-lg font-bold">{load?.pickup}</h2><p className="mt-1 text-sm text-blue-300">{load?.stops.map(stop => stop.name).join(' → ')}</p><p className="mt-1 text-xs text-gray-400">Demo Operator · {load?.bbls} BBL</p>
      <div className="mt-5 rounded-lg border border-slate-700 p-3 text-xs"><p className="font-bold text-amber-400">PICKUP</p><p className="mt-1">{load?.pickup}</p><p className="mt-3 font-bold text-purple-300">DROP-OFF</p><p className="mt-1">{load?.stops.map(stop => `${stop.name} · ${stop.bbls} BBL`).join(' / ')}</p></div>
      <div className={`relative mt-5 rounded-lg bg-amber-400 px-4 py-3 text-center text-sm font-bold text-black ${phase === 'review' && timeToStart <= 3_000 ? 'animate-pulse' : ''}`}>{phase === 'review' || phase === 'drawer' ? 'Start Job' : phase === 'to_pickup' ? 'En route to pickup' : phase === 'pickup' ? 'Pickup recorded' : phase === 'driving' ? 'En route to drop-off' : phase === 'dropoff' ? 'At drop-off' : 'Ticket completed'}{phase === 'review' && timeToStart <= 3_000 && <span aria-hidden="true" className="absolute -bottom-2 right-6 text-xl">👆</span>}</div>
    </div>}
    <div className="border-t border-slate-800 p-3 text-center text-[10px] text-gray-500">Live demo company · read-only phone view</div>
  </aside>;
}
function DemoJobs({ snapshot, clock }: { snapshot: Snapshot; clock: number }) {
  const [tab, setTab] = useState<'active' | 'completed'>('active');
  const [expanded, setExpanded] = useState(true);
  const jobs = physicalJobs(snapshot);
  const active = jobs.filter(job => job.lead.status !== 'completed');
  const completed = jobs.filter(job => job.lead.status === 'completed');
  const visible = tab === 'active' ? active : completed;
  const name = snapshot.featured?.driverName || 'Demo driver';
  const pw = visible.filter(job => job.lead.jobType === 'pw').length;
  const sw = visible.filter(job => job.lead.jobType === 'service').length;
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
              {visible.map(({ load, lead: job, dispatches }, index) => {
                const pendingMinutes = job.assignedAt ? Math.max(0, Math.floor((clock - Date.parse(job.assignedAt)) / 60_000)) : 0;
                const freshAssignment = !!job.assignedAt && clock - Date.parse(job.assignedAt) < 5_000;
                const status = stageForJob(job);
                const split = dispatches.length > 1;
                return <div key={load.id} className={`py-3 px-4 border rounded-lg ${freshAssignment ? 'ring-2 ring-cyan-400/70' : ''} ${split ? 'bg-purple-900/25 border-purple-500/50 border-l-[3px]' : 'bg-gray-900/75 border-gray-700/70'}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`inline-flex items-center justify-center w-10 h-5 text-[10px] font-bold rounded ${job.jobType === 'service' ? 'bg-purple-600/30 text-purple-300' : 'bg-blue-600/30 text-blue-300'}`}>
                      {job.jobType === 'service' ? 'SW' : 'PW'}
                    </span>
                    <span className="text-white font-medium text-sm break-words flex-1 min-w-0">{load.pickup}</span>
                    {split && <span className="rounded bg-purple-600/30 px-2 py-0.5 text-[10px] font-bold text-purple-300">1 LOAD · {dispatches.length} SPLIT JOBS</span>}
                    {snapshot.featured?.kind === 'multi_haul' && <span className="rounded bg-cyan-600/20 px-2 py-0.5 text-[10px] font-bold text-cyan-300">MULTI-HAUL · LOAD {snapshot.featured.loads.findIndex(item => item.id === load.id) + 1} OF {snapshot.featured.loads.length}</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs">
                    {job.ticketNumber && <span className="text-gray-400">#{job.ticketNumber}</span>}
                    <span className="text-cyan-400/70">→ {load.stops.map(stop => stop.name).join(' → ')}</span>
                    {job.operator && <span className="text-gray-300">Operator: {job.operator}</span>}
                  </div>
                  {split && <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-purple-200"><span>Split A · pickup {load.bbls} BBL</span>{load.stops.map((stop, stopIndex) => <span key={`${load.id}-stop-${stopIndex}`}>Split {String.fromCharCode(66 + stopIndex)} · {stop.name} {stop.bbls} BBL</span>)}</div>}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs text-gray-400">
                    {job.route && <span>Route: <span className="text-gray-200">{job.route}</span></span>}
                    {job.currentLevel && <span>Level at dispatch: <span className="text-gray-200">{job.currentLevel}</span></span>}
                    {job.flowRate && <span>Flow at dispatch: <span className="text-gray-200">{job.flowRate}</span></span>}
                    {job.bbls != null && <span>Planned: <span className="text-gray-200">{job.bbls} BBL</span></span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-3">
                    {tab === 'active' && index === 0 && job.jobType === 'pw' && <span className="inline-flex items-center justify-center h-5 w-[6.5rem] text-[10px] font-bold rounded bg-emerald-600/30 text-emerald-300">★ Next</span>}
                    <span className={`inline-flex items-center justify-center h-5 min-w-[6.5rem] px-1 text-[10px] font-bold rounded ${status === 'Pending' ? 'bg-yellow-600/30 text-yellow-300' : status === 'Done' ? 'bg-green-600/30 text-green-300' : 'bg-blue-600/30 text-blue-300'}`}>
                      {status === 'Pending' && pendingMinutes > 0 ? `Pending · ${pendingMinutes < 60 ? `${pendingMinutes}m` : `${Math.floor(pendingMinutes / 60)}h`}` : status}
                    </span>
                    {freshAssignment && <span className="text-[10px] font-bold text-cyan-300">Just added</span>}
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
  const [entered, setEntered] = useState(false);
  const [viewerError, setViewerError] = useState('');
  const [authAttempt, setAuthAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('dispatch');
  const [dispatchTab, setDispatchTab] = useState<'build' | 'jobs'>('jobs');
  const [walkthrough, setWalkthrough] = useState(false);
  const [guideRunId, setGuideRunId] = useState<string | null>(null);
  const [guideBuildStartedAt, setGuideBuildStartedAt] = useState<number | null>(null);
  const [guideDispatchedAt, setGuideDispatchedAt] = useState<number | null>(null);
  const [guideEndedAt, setGuideEndedAt] = useState<number | null>(null);
  const [phoneVisible, setPhoneVisible] = useState(false);
  const [phoneDetailOpen, setPhoneDetailOpen] = useState(false);
  const [clock, setClock] = useState(0);
  const activeRunId = snapshot?.active?.scenario.id;
  useEffect(() => {
    if (activeRunId) setPhoneVisible(true);
  }, [activeRunId]);
  useEffect(() => { setWalkthrough(true); }, []);
  useEffect(() => {
    let stopped = false;
    const openViewer = async () => {
      try {
        const response = await httpsCallable<undefined, { customToken: string; companyId: string; role: string }>(
          getFirebaseFunctions(), 'demoViewerSession')();
        if (response.data.companyId !== 'wellbuilt-demo' || response.data.role !== 'demo_viewer') throw new Error('Demo viewer scope mismatch');
        const credential = await signInWithCustomToken(getDemoViewerAuth(), response.data.customToken);
        const token = await credential.user.getIdTokenResult();
        if (credential.user.uid !== 'wellbuilt-demo-shared-viewer' || token.claims.staffCompanyId !== 'wellbuilt-demo'
          || token.claims.staffRole !== 'demo_viewer' || token.claims.isDemo !== true) throw new Error('Demo viewer identity mismatch');
        if (!stopped) { setEntered(true); setViewerError(''); }
      } catch (cause) {
        if (!stopped) setViewerError(cause instanceof Error ? cause.message : 'Demo viewer sign-in failed.');
      }
    };
    void openViewer();
    return () => { stopped = true; };
  }, [authAttempt]);
  useEffect(() => {
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!entered) return;
    let stopped = false;
    let busy = false;
    let timer: number | undefined;
    let nextDueAt: number | null = null;
    const fetchSnapshot = async () => {
      if (stopped || busy) return;
      if (timer !== undefined) window.clearTimeout(timer);
      if (document.visibilityState === 'hidden') {
        timer = window.setTimeout(fetchSnapshot, 4_000);
        return;
      }
      busy = true;
      try {
        const response = await httpsCallable<undefined, Snapshot>(getDemoViewerFunctions(), 'liveDemoSnapshot')();
        if (!stopped) { setSnapshot(response.data); setError(''); nextDueAt = response.data.active?.dueAt || null; }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : 'Live demo is unavailable.');
      } finally {
        busy = false;
        if (!stopped) {
          const toTransition = nextDueAt == null ? Infinity : nextDueAt - Date.now();
          timer = window.setTimeout(fetchSnapshot, toTransition >= -4_000 && toTransition <= 4_000 ? 750 : 4_000);
        }
      }
    };
    void fetchSnapshot();
    document.addEventListener('visibilitychange', fetchSnapshot);
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); document.removeEventListener('visibilitychange', fetchSnapshot); };
  }, [entered]);
  const featured = snapshot?.featured;
  const backendPhase = demoPhase(snapshot, clock);
  const guided = walkthrough && !!guideRunId && featured?.id === guideRunId;
  const jobVisible = !!snapshot?.dispatches.some(job => job.exists);
  const phase = guided && backendPhase === 'review' && guideDispatchedAt != null && clock - guideDispatchedAt < 4_000
    ? 'drawer' : backendPhase;
  useEffect(() => {
    if (jobVisible) setDispatchTab('jobs');
  }, [jobVisible, featured?.id]);
  useEffect(() => {
    if (guided && jobVisible && guideDispatchedAt == null) setGuideDispatchedAt(Date.now());
  }, [guided, jobVisible, guideDispatchedAt]);
  const guideElapsed = guideEndedAt == null ? 0 : clock - guideEndedAt;
  const displayView: View = guided
    ? phase === 'complete' ? guideElapsed < 5_000 ? 'tickets' : 'billing' : 'dispatch'
    : view;
  const displayDispatchTab = guided ? phase === 'building' ? 'build' : 'jobs' : dispatchTab;
  const buildStartAt = guided && guideBuildStartedAt != null ? guideBuildStartedAt : snapshot?.active?.startedAt || clock;
  const buildProgress = snapshot?.active && phase === 'building'
    ? Math.min(1, Math.max(0, (clock - buildStartAt) / Math.max(1, snapshot.active.dueAt - buildStartAt)))
    : 0;
  const phoneReady = !!snapshot?.active && (jobVisible || (phase === 'building' && buildProgress >= .88));
  useEffect(() => {
    if (!walkthrough || !snapshot) return;
    if (!guideRunId && snapshot.active?.stage === 'pending' && !snapshot.dispatches.some(job => job.exists)
      && snapshot.active.scenario.kind !== 'split_ticket' && snapshot.active.dueAt - Date.now() >= 15_000) {
      setGuideRunId(snapshot.active.scenario.id);
      setGuideBuildStartedAt(Date.now());
      setGuideDispatchedAt(null);
      setGuideEndedAt(null);
      setPhoneVisible(true);
      setPhoneDetailOpen(false);
    } else if (guideRunId && snapshot.featured?.id === guideRunId && demoPhase(snapshot, Date.now()) === 'complete' && guideEndedAt == null) {
      setGuideEndedAt(Date.now());
    }
  }, [walkthrough, guideRunId, guideEndedAt, snapshot]);
  useEffect(() => {
    if (walkthrough && guideEndedAt != null && clock - guideEndedAt >= 13_000) {
      setWalkthrough(false);
      setGuideRunId(null);
      setGuideBuildStartedAt(null);
      setGuideDispatchedAt(null);
      setPhoneVisible(false);
      setView('dispatch');
    }
  }, [walkthrough, guideEndedAt, clock]);
  useEffect(() => { setPhoneDetailOpen(false); }, [snapshot?.active?.loadIndex]);
  const exitWalkthrough = () => {
    setWalkthrough(false);
    setGuideRunId(null);
    setGuideBuildStartedAt(null);
    setGuideDispatchedAt(null);
    setPhoneVisible(false);
  };
  const replayWalkthrough = () => {
    setWalkthrough(true);
    setGuideRunId(null);
    setGuideBuildStartedAt(null);
    setGuideDispatchedAt(null);
    setGuideEndedAt(null);
    setPhoneVisible(true);
    setView('dispatch');
  };
  const navigate = (target: View) => {
    if (walkthrough) exitWalkthrough();
    setView(target);
  };
  const activeCount = snapshot ? physicalJobs(snapshot).filter(job => job.lead.status !== 'completed').length : 0;
  const liveStage = snapshot
    ? currentPhysicalJob(snapshot)?.lead.driverStage || (snapshot.dispatches.some(job => job.status === 'completed') ? 'completed' : 'pending')
    : 'pending';
  const remaining = snapshot?.active ? Math.max(0, Math.ceil((snapshot.active.dueAt - clock) / 1_000)) : snapshot?.nextRunAt ? Math.max(0, Math.ceil((snapshot.nextRunAt - clock) / 1_000)) : null;
  const nextPwAt = snapshot ? nextPwBuildAt(snapshot) : null;
  const timeToStart = snapshot?.active?.stage === 'accepted' ? Math.max(0, snapshot.active.dueAt - clock) : STEP_MS;
  const scheduleLabel = guided
    ? phase === 'complete' ? 'Run complete'
      : (snapshot?.active?.dueAt || 0) <= clock ? phase === 'building' ? 'Dispatching…' : 'Updating live status…'
        : `${phase === 'building' ? 'Dispatch in' : 'Next scene'} ${formatCountdown((snapshot?.active?.dueAt || clock) - clock)}`
    : nextPwAt == null ? 'Scheduling next run…'
      : nextPwAt <= clock ? 'Starting next PW build…' : `Next PW build ~${formatCountdown(nextPwAt - clock)}`;
  if (!entered) return <main className="flex min-h-screen items-center justify-center bg-[#0b1424] p-4 text-white">
    <section className="w-full max-w-md rounded-xl border border-cyan-800/70 bg-gray-800 p-8 shadow-2xl">
      <div className="mb-7 text-center"><img src="/live-demo/logo.svg" alt="WellBuilt Demo Hauling logo" className="mx-auto mb-4 h-20 w-20" />
        <h1 className="text-2xl font-bold">WellBuilt Demo Hauling</h1><p className="mt-2 text-sm text-gray-400">Signing in to the demo company</p></div>
      {viewerError ? <><p role="alert" className="mb-4 text-sm text-amber-300">{viewerError}</p><button type="button" onClick={() => { setViewerError(''); setAuthAttempt(value => value + 1); }} className="w-full rounded-lg bg-cyan-600 px-4 py-3 font-semibold text-white hover:bg-cyan-500">Try again</button></>
        : <p className="text-center text-sm text-gray-300">Opening the shared viewer account…</p>}
      <p className="mt-4 text-center text-xs text-gray-400">Synthetic jobs · read-only viewer</p>
    </section>
  </main>;
  return <main className="min-h-screen bg-[#0b1424] text-white">
    <div className="border-b border-amber-600/40 bg-amber-950/20 px-4 py-2 text-xs sm:text-sm flex flex-wrap justify-between gap-2">
      <span><strong className="text-amber-300">LIVE DEMO</strong> · {snapshot?.company || 'Demo company'} · synthetic data · read-only</span>
      <span>{snapshot ? `Set ${snapshot.batchNumber} · run ${snapshot.runInBatch}/${snapshot.batchSize}` : 'Connecting…'}{remaining != null ? remaining > 0 ? ` · next step ${remaining}s` : ' · processing next step…' : ''}</span>
    </div>
    <header className="bg-gray-800 border-b border-gray-700">
      <div className="flex items-center justify-center gap-3 px-3 pt-4 text-center"><img src={snapshot?.companyProfile?.logoUrl || '/live-demo/logo.svg'} alt="Demo company logo" className="h-12 w-12 rounded-xl" /><div><h1 className="text-xl sm:text-3xl font-bold">WellBuilt Suite</h1><p className="text-gray-400 text-sm">{snapshot?.companyProfile?.name || 'WellBuilt Demo Hauling'} · Operations</p></div></div>
      <nav aria-label="Demo dashboard navigation" className="flex flex-wrap justify-center gap-x-1 px-2 pt-2">
        {nav.filter(item => item.id !== 'well').map(item => <button key={item.id} type="button" onClick={() => navigate(item.id)}
          className={`whitespace-nowrap px-3 py-2 text-sm font-medium border-b-2 ${displayView === item.id ? 'border-blue-500 text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>{item.label}</button>)}
      </nav>
    </header>
    <div className="px-4 py-4 max-w-[1600px] mx-auto">
      <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-cyan-700 bg-cyan-950/40 p-3 text-sm">
        <span><strong className="text-cyan-300">{walkthrough ? 'Walkthrough' : 'Live schedule'}</strong> · {guided ? stepCopy[phase] : walkthrough ? 'The next PW job will build in Dispatch' : 'Watch the next PW job build from the beginning'}{guided && phase === 'complete' ? ` · ${guideElapsed < 5_000 ? 'Tickets' : 'Billing'}` : ''}</span>
        <div className="flex items-center gap-3"><span className="font-mono text-lg font-semibold tabular-nums text-cyan-200">{scheduleLabel}</span>
          {walkthrough ? <button type="button" onClick={exitWalkthrough} className="rounded border border-cyan-700 px-3 py-1 text-cyan-200">Explore live demo</button>
            : <button type="button" onClick={replayWalkthrough} className="rounded border border-cyan-700 px-3 py-1 text-cyan-200">Watch next PW job</button>}
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
        <span className="text-gray-300">{featured ? `${featured.driverName} · ${featured.id} · ${phase === 'building' ? 'Building job' : stageForJob({ driverStage: liveStage, status: liveStage === 'completed' ? 'completed' : 'pending' })}` : 'Waiting for the next run'}</span>
        <div className="flex flex-wrap gap-2">
          {phoneReady && <button type="button" onClick={() => setPhoneVisible(value => !value)} className="rounded border border-gray-600 px-3 py-1.5 text-gray-300">{phoneVisible ? 'Hide' : 'Show'} driver phone</button>}
          <button type="button" onClick={() => navigate('dispatch')} className="rounded border border-gray-600 px-3 py-1.5 text-gray-300">Watch Dispatch Jobs</button>
        </div>
      </div>
      {(error || snapshot?.error) && <div role="alert" className="mb-4 rounded border border-amber-600 bg-amber-950/30 p-3 text-sm text-amber-200">{error || `Demo step retrying: ${snapshot?.error}`}</div>}
      {displayView === 'dispatch' ? <>
        <div className="flex gap-2 border-b border-gray-700 pb-2 mb-3 text-sm">
          <button type="button" onClick={() => { if (walkthrough) exitWalkthrough(); setDispatchTab('build'); }} className={`px-3 py-1.5 rounded ${displayDispatchTab === 'build' ? 'bg-blue-600 text-white' : 'text-gray-400'}`}>Build Job</button>
          <button type="button" onClick={() => navigate('well')} className="px-3 py-1.5 text-gray-400">Well Queue</button>
          <button type="button" onClick={() => { if (walkthrough) exitWalkthrough(); setDispatchTab('jobs'); }} className={`px-3 py-1.5 rounded ${displayDispatchTab === 'jobs' ? 'bg-blue-600 text-white' : 'text-gray-400'}`}>Jobs</button>
        </div>
        {displayDispatchTab === 'build' ? <DemoBuilder scenario={featured || null} progress={buildProgress} dispatched={false} showCursor={guided && phase === 'building'} />
          : snapshot ? <DemoJobs snapshot={snapshot} clock={clock} /> : <div className="p-6 bg-gray-800 rounded-lg text-gray-400">Loading Dispatch Jobs…</div>}
        {guided && phase === 'driving' && <div className="mt-3 rounded-lg border border-cyan-800 bg-cyan-950/20 p-3 text-sm text-cyan-200">WB Mobile receives the pull packet as the truck leaves pickup. The Dispatch status now reads To Drop-off.</div>}
      </> : displayView === 'mobile' || displayView === 'well' ? <div className="rounded-lg border border-gray-700 bg-gray-800 p-4"><h2 className="text-lg font-bold">{displayView === 'well' ? 'Well Queue' : 'WB Mobile'} · Pull activity</h2><div className="mt-4 grid gap-2 sm:grid-cols-2">{snapshot?.loads.filter(load => displayView === 'well' || load.pullStatus !== 'awaiting pickup').map(load => <div key={load.id} className="rounded border border-gray-700 bg-gray-900 p-4"><strong>{load.pickup}</strong><p className="mt-2 text-sm text-gray-400">{load.bbls} BBL · {load.pullStatus}</p></div>)}{snapshot?.loads.every(load => load.pullStatus === 'awaiting pickup') && displayView === 'mobile' && <p className="text-sm text-gray-400">No pull packet has arrived yet.</p>}</div></div>
      : displayView === 'tickets' ? <div className="rounded-lg border border-gray-700 bg-gray-800 p-4"><h2 className="text-lg font-bold">WB Tickets</h2><div className="mt-4 space-y-2">{snapshot?.loads.flatMap(load => load.tickets).filter(ticket => ticket.exists).map(ticket => <div key={ticket.id} className="rounded border border-gray-700 bg-gray-900 p-4 flex flex-wrap justify-between gap-2"><strong>#{ticket.number}</strong><span>{ticket.destination} · {ticket.qty} BBL</span></div>)}{!snapshot?.loads.some(load => load.tickets.some(ticket => ticket.exists)) && <p className="text-sm text-gray-400">No ticket yet. It appears after the driver closes the job.</p>}</div></div>
      : <div className="rounded-lg border border-gray-700 bg-gray-800 p-4"><h2 className="text-lg font-bold">WB Billing</h2><div className="mt-4 space-y-2">{snapshot?.loads.filter(load => load.invoice.exists).map(load => <div key={load.id} className="rounded border border-gray-700 bg-gray-900 p-4 flex flex-wrap justify-between gap-2"><strong>{load.pickup}</strong><span>{load.invoice.totalBBL} BBL · {load.invoice.status}</span></div>)}{!snapshot?.loads.some(load => load.invoice.exists) && <p className="text-sm text-gray-400">No invoice yet. It appears when tickets close.</p>}</div></div>}
      {displayView === 'well' && <button type="button" className="mt-4 text-sm text-blue-300" onClick={() => navigate('dispatch')}>Back to Dispatch Jobs</button>}
      <p className="mt-5 text-xs text-gray-500">This view shows read-only records from the dedicated demo company. Dashboard actions are disabled.</p>
      {activeCount === 0 && snapshot?.history.length ? <p className="mt-2 text-xs text-gray-500">Latest completed run: {snapshot.history[0].id}</p> : null}
    </div>
    {phoneVisible && phoneReady && <DemoPhone scenario={featured || null} phase={phase} dispatches={snapshot?.dispatches || []} onClose={() => setPhoneVisible(false)} detailOpen={phoneDetailOpen} onOpen={() => setPhoneDetailOpen(true)} timeToStart={timeToStart} />}
  </main>;
}
