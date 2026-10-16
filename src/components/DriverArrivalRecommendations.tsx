'use client';

import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDocs, limit, onSnapshot, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { getFirestoreDb } from '@/lib/firebase';
import type { DriverIdentity } from '@/lib/dispatchDriverIdentity';
import { operationalDriverName } from '@/lib/operationalDriverName';
import { buildArrivalHistory, arrivalPoint, recommendDriverArrivals,
  type ArrivalInvoice, type ArrivalJob, type ArrivalPoint, type ArrivalRecommendation, type ArrivalTravel } from '@/lib/driverArrivalRecommendations';

type Location = { well_name: string; latitude?: number; longitude?: number };
export interface DriverArrivalRecommendationsProps {
  drivers: DriverIdentity[]; jobs: ArrivalJob[]; companyId?: string | null;
  targetName: string; locations: Location[]; jobsComplete: boolean;
  shift: (driver: DriverIdentity) => 'open' | 'none' | 'unknown';
  selectedKeys: ReadonlySet<string>; onSelect: (key: string) => void;
  roadTime?: (from: ArrivalPoint, to: ArrivalPoint) => Promise<ArrivalTravel | null>;
}
const normalized = (s: string) => s.trim().toLowerCase();

/** Advisory only: never creates jobs, changes a queue or restricts driver selection. */
export function DriverArrivalRecommendations(props: DriverArrivalRecommendationsProps) {
  const { drivers, jobs, companyId, targetName, locations, jobsComplete, shift, roadTime } = props;
  const [expanded, setExpanded] = useState(false);
  const [invoices, setInvoices] = useState<ArrivalInvoice[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [historyCapped, setHistoryCapped] = useState(false);
  const [linked, setLinked] = useState<Record<string, ArrivalInvoice>>({});
  const [openInvoices, setOpenInvoices] = useState<ArrivalInvoice[]>([]);
  const [openReady, setOpenReady] = useState(false);
  const [openError, setOpenError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [rows, setRows] = useState<ArrivalRecommendation[]>([]);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const locationIndex = useMemo(() => {
    const result = new Map<string, ArrivalPoint | null>();
    for (const row of locations) {
      const point = arrivalPoint(row.latitude, row.longitude);
      if (!point) continue;
      const name = normalized(row.well_name);
      const prev = result.get(name);
      if (prev === null) continue;
      if (prev && (Math.abs(prev.lat - point.lat) > 0.0001 || Math.abs(prev.lng - point.lng) > 0.0001)) result.set(name, null);
      else result.set(name, point);
    }
    return result;
  }, [locations]);
  const target = locationIndex.get(normalized(targetName)) || null;
  useEffect(() => {
    if (!expanded) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, [expanded]);
  useEffect(() => {
    let alive = true;
    setInvoices([]); setHistoryReady(false); setHistoryError(false); setHistoryCapped(false);
    if (!expanded || !companyId) return;
    const db = getFirestoreDb();
    const load = async () => {
      try {
        const history = await getDocs(query(collection(db, 'invoices'), where('companyId', '==', companyId),
          where('createdAt', '>=', Timestamp.fromMillis(Date.now() - 14 * 86400000)), orderBy('createdAt', 'desc'), limit(600)));
        if (!alive) return;
        const all = new Map<string, ArrivalInvoice>();
        for (const snap of history.docs) {
          const data = snap.data();
          if (data.companyId === companyId && data.status !== 'open') all.set(snap.id, { ...data, id: snap.id } as ArrivalInvoice);
        }
        setInvoices([...all.values()]); setHistoryCapped(history.size === 600); setHistoryReady(true);
      } catch { if (alive) { setHistoryError(true); setHistoryReady(true); } }
    };
    void load();
    return () => { alive = false; };
  }, [expanded, companyId, retry]);
  useEffect(() => {
    setOpenInvoices([]); setOpenReady(false); setOpenError(false);
    if (!expanded || !companyId) return;
    return onSnapshot(query(collection(getFirestoreDb(), 'invoices'), where('companyId', '==', companyId), where('status', '==', 'open')), snapshot => {
      setOpenInvoices(snapshot.docs.filter(s => s.data().companyId === companyId).map(s => ({ ...s.data(), id: s.id } as ArrivalInvoice)));
      setOpenReady(true); setOpenError(false);
    }, () => { setOpenError(true); setOpenReady(true); setOpenInvoices([]); });
  }, [expanded, companyId, retry]);
  const linkKey = JSON.stringify(jobs.filter(j => j.companyId === companyId && j.id && j.invoiceDocId && ['accepted', 'in_progress', 'paused'].includes(j.status))
    .map(j => [j.id, j.invoiceDocId]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  useEffect(() => {
    setLinked({});
    if (!expanded || !companyId) return;
    let alive = true;
    const unsubs = (JSON.parse(linkKey) as string[][]).map(([jobId, invoiceId]) => onSnapshot(doc(getFirestoreDb(), 'invoices', invoiceId), snap => {
      if (!alive) return;
      const data = snap.data();
      setLinked(prev => {
        const next = { ...prev }; delete next[invoiceId];
        if (data?.companyId === companyId && data.dispatchId === jobId) next[invoiceId] = { ...data, id: invoiceId } as ArrivalInvoice;
        return next;
      });
    }, () => { if (alive) setLinked(prev => { const next = { ...prev }; delete next[invoiceId]; return next; }); }));
    return () => { alive = false; unsubs.forEach(fn => fn()); };
  }, [expanded, companyId, linkKey]);
  const combined = useMemo(() => [...new Map([...invoices, ...openInvoices, ...Object.values(linked)].map(i => [i.id, i])).values()], [invoices, openInvoices, linked]);
  const history = useMemo(() => buildArrivalHistory(combined, companyId || '', now), [combined, companyId, now]);
  useEffect(() => {
    let alive = true;
    setRows([]);
    if (!expanded || !companyId || !historyReady || !openReady) return;
    setBusy(true);
    recommendDriverArrivals({ drivers, jobs, invoices: combined, companyId, target, nowMs: now,
      jobsComplete: jobsComplete && !historyError && !openError, history, shift,
      locate: name => locationIndex.get(normalized(name)) || null, roadTime,
    }).then(result => { if (alive) { setRows(result); setBusy(false); } }).catch(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [expanded, companyId, historyReady, openReady, drivers, jobs, combined, target, now, jobsComplete, historyError, openError, history, shift, locationIndex, roadTime]);
  if (!targetName.trim()) return null;
  const onShiftCount = drivers.filter(driver => (!driver.companyId || driver.companyId === companyId) && shift(driver) === 'open').length;
  return <section className="rounded border border-cyan-800/60 bg-gray-950/40 text-xs" data-driver-arrival-recommendations>
    <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-cyan-300" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
      <span>Driver arrival recommendations</span><span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
    </button>
    {expanded && <div className="space-y-2 border-t border-cyan-900/60 p-3">
      <p className="break-words text-gray-300">To {targetName}. After current work; existing queued assignments are shown separately. All drivers remain selectable.</p>
      {!!companyId && <p className="text-cyan-300">Comparing {onShiftCount} on-shift driver{onShiftCount === 1 ? '' : 's'}. Off-shift or unverified drivers remain selectable; no travel lookup is made for them.</p>}
      {!companyId && <p className="text-amber-300">Select a company to compare arrivals.</p>}
      {!!companyId && !target && <p className="text-amber-300">Pickup coordinates unavailable or ambiguous.</p>}
      {(historyError || openError) && <p className="text-amber-300">Timing/job history unavailable. Arrival estimates withheld. <button type="button" className="underline" onClick={() => setRetry(v => v + 1)}>Retry</button></p>}
      {!!companyId && (!historyReady || !openReady || busy) ? <p role="status" className="text-gray-400">Checking current work and travel estimates…</p> : null}
      <div className="max-h-80 space-y-2 overflow-y-auto">
        {rows.map((row, index) => {
          const driver = drivers.find(d => d.key === row.driverKey);
          if (!driver) return null;
          const selected = props.selectedKeys.has(row.driverKey);
          return <div key={row.driverKey} className={`rounded border p-2 ${selected ? 'border-cyan-500 bg-cyan-950/20' : 'border-gray-700'}`}>
            <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left text-white" onClick={() => props.onSelect(row.driverKey)} aria-pressed={selected}>
              <span className="min-w-0 break-words">{row.arrivalMinutes !== null ? `${index + 1}. ` : ''}{operationalDriverName(driver)}</span>
              <span className="shrink-0 text-cyan-300">{row.arrivalMinutes === null ? 'Arrival unknown' : `~${row.arrivalMinutes}m · ${new Date(now + row.arrivalMinutes * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}{selected ? ' ✓' : ''}</span>
            </button>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-gray-400">{row.reasons.map((reason, i) => <li key={i} className="break-words">{reason}</li>)}</ul>
            {row.queueCount > 0 && row.arrivalMinutes === null && <p className="mt-1 text-amber-300">{row.queueCount} queued assignment{row.queueCount === 1 ? '' : 's'}</p>}
          </div>;
        })}
      </div>
      {historyReady && <p className="text-gray-500">{history.length} usable timing samples from the last 14 days{historyCapped ? ' (600-invoice sample limit)' : ''}. Estimates, not a guaranteed finish time. HOS/equipment not verified.</p>}
      <button type="button" className="text-cyan-400 underline" onClick={() => { setNow(Date.now()); setRetry(v => v + 1); }}>Refresh estimates</button>
    </div>}
  </section>;
}
