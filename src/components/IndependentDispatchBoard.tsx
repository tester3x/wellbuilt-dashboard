'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { independentDispatchJobs, type IndependentJob, type IndependentJobDetails, type IndependentJobStatus } from '@/lib/independentDispatchJobs';
import { listExternalDrivers, type ExternalDriver } from '@/lib/externalAssignmentDelivery';
import { ExternalAssignmentDeliveryPanel } from './ExternalAssignmentDeliveryPanel';

const EMPTY: IndependentJobDetails = { title: '', customer: '', reference: '', pickup: '', destination: '', cargo: '', scheduledAt: '', notes: '' };
const STATUS: Record<IndependentJobStatus, string> = { unassigned: 'Unassigned', assigned: 'Assigned', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const FIELDS = [
  ['title', 'Job name', 180, true], ['customer', 'Customer', 180, true],
  ['reference', 'Customer reference / load number', 120, false],
  ['pickup', 'Pickup address / location', 500, true], ['destination', 'Delivery address / location', 500, true],
  ['cargo', 'Cargo / equipment / quantity', 500, false], ['notes', 'Instructions', 4000, false],
] as const;
const inputClass = 'w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white';
const buttonClass = 'rounded bg-blue-700 px-3 py-2 text-sm text-white disabled:opacity-40';

export function IndependentDispatchBoard({ companyId, canWrite, canManageDrivers }: {
  companyId: string; canWrite: boolean; canManageDrivers: boolean;
}) {
  const [jobs, setJobs] = useState<IndependentJob[]>([]);
  const [drivers, setDrivers] = useState<ExternalDriver[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<IndependentJob | null>(null);
  const [scheduledLocal, setScheduledLocal] = useState('');
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  // Keep create identity through an ambiguous network failure, avoiding duplicate jobs.
  const creation = useRef({ jobId: crypto.randomUUID(), requestId: crypto.randomUUID() });
  const refresh = useCallback(async () => {
    const result = await independentDispatchJobs({ op: 'list' });
    if (result.companyId !== companyId) throw Error('Your staff account belongs to a different company.');
    setJobs(result.jobs || []);
    if (canManageDrivers) setDrivers(await listExternalDrivers());
    setLoaded(true);
  }, [companyId, canManageDrivers]);
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refresh]);
  async function run(payload: Record<string, unknown>, after?: () => void) {
    setBusy(true); setError(''); setNotice('');
    try {
      await independentDispatchJobs(payload);
      after?.();
      setNotice('Saved.');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save. Refresh and try again.'); }
    finally { setBusy(false); }
  }
  function resetForm() {
    setForm(EMPTY); setEditing(null); setScheduledLocal('');
    creation.current = { jobId: crypto.randomUUID(), requestId: crypto.randomUUID() };
  }
  function edit(job: IndependentJob) {
    setEditing(job);
    setForm(Object.fromEntries(Object.keys(EMPTY).map(k => [k, job[k as keyof IndependentJobDetails]])) as IndependentJobDetails);
    const date = job.scheduledAt ? new Date(job.scheduledAt) : null;
    setScheduledLocal(date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
    document.getElementById('independent-job-form')?.scrollIntoView({ behavior: 'smooth' });
  }
  const visible = jobs.filter(job => (filter === 'all' || (filter === 'active' ? !['completed', 'cancelled'].includes(job.status) : filter === job.status))
    && [job.title, job.customer, job.reference, job.pickup, job.destination, job.driverName].join(' ').toLowerCase().includes(search.toLowerCase()));
  return <div className="space-y-4">
    <p className="text-sm text-gray-300">Create customer jobs, assign outside drivers, and record progress. Driver messaging and the WB Dispatch phone app will be connected separately.</p>
    {error && <div role="alert" className="rounded border border-red-700 bg-red-950 p-3 text-red-200">{error}</div>}
    {notice && <p role="status" className="text-green-300">{notice}</p>}
    {canManageDrivers && <ExternalAssignmentDeliveryPanel jobs={[]} canManage={canWrite && canManageDrivers} rosterOnly onRosterChange={refresh} />}
    {canWrite && <form id="independent-job-form" className="rounded border border-gray-700 bg-gray-800 p-4" onSubmit={event => {
      event.preventDefault();
      const job = { ...form, scheduledAt: scheduledLocal ? new Date(scheduledLocal).toISOString() : '' };
      void run({ op: editing ? 'update' : 'create', jobId: editing?.id || creation.current.jobId,
        requestId: editing ? crypto.randomUUID() : creation.current.requestId,
        ...(editing ? { expectedRevision: editing.revision } : {}), job }, resetForm);
    }}>
      <h2 className="mb-3 font-semibold text-cyan-300">{editing ? 'Edit job' : 'New Independent Dispatch job'}</h2>
      <fieldset disabled={busy || !loaded} className="grid gap-3 md:grid-cols-2">
        {FIELDS.map(([key, label, max, required]) => <label key={key} className={`text-xs text-gray-300 ${key === 'notes' ? 'md:col-span-2' : ''}`}>
          {label}{required ? ' *' : ''}
          {key === 'notes' ? <textarea className={inputClass} rows={3} maxLength={max} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} />
            : <input className={inputClass} required={required} maxLength={max} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} />}
        </label>)}
        <label className="text-xs text-gray-300">Scheduled pickup (your local time)<input type="datetime-local" className={inputClass} value={scheduledLocal} onChange={e => setScheduledLocal(e.target.value)} /></label>
        <div className="flex items-end gap-2"><button className={buttonClass}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create job'}</button>
          <button type="button" className="text-sm text-gray-300" onClick={resetForm}>Clear / new job</button></div>
      </fieldset>
    </form>}
    <div className="flex flex-wrap gap-2">
      <input aria-label="Search dispatch jobs" placeholder="Search jobs, customers, locations, drivers…" value={search} onChange={e => setSearch(e.target.value)} className={`${inputClass} flex-1 min-w-48`} />
      <select aria-label="Job status" className={inputClass + ' !w-auto'} value={filter} onChange={e => setFilter(e.target.value)}><option value="active">Active jobs</option><option value="all">All jobs</option>{Object.entries(STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => { setError(''); void refresh().catch(e => setError(e.message)); }}>Refresh</button>
    </div>
    {!loaded ? <p className="text-gray-400">Loading jobs…</p> : !visible.length ? <p className="text-gray-400">No matching jobs.</p> : visible.map(job => <article key={job.id} className="rounded border border-gray-700 bg-gray-800 p-4">
      <div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold text-white">{job.title}</h2><span className="text-cyan-300">{STATUS[job.status]}</span></div>
      <p className="text-sm text-gray-300">{job.customer}{job.reference ? ` · ${job.reference}` : ''}</p>
      <dl className="mt-2 grid gap-2 text-sm md:grid-cols-2"><div><dt className="text-gray-400">Pickup</dt><dd className="whitespace-pre-wrap break-words text-white">{job.pickup}</dd></div><div><dt className="text-gray-400">Delivery</dt><dd className="whitespace-pre-wrap break-words text-white">{job.destination}</dd></div></dl>
      {job.cargo && <p className="mt-2 whitespace-pre-wrap text-sm text-gray-300">Cargo: {job.cargo}</p>}
      {job.scheduledAt && <p className="text-sm text-gray-300">Scheduled: {new Date(job.scheduledAt).toLocaleString()}</p>}
      {job.notes && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-300">{job.notes}</p>}
      <p className="mt-2 text-sm text-amber-200">Driver: {job.driverName || 'Not assigned'}</p>
      {canWrite && <div className="mt-3 flex flex-wrap gap-2">
        {['unassigned', 'assigned'].includes(job.status) && <>
          <button className={buttonClass} disabled={busy} onClick={() => edit(job)}>Edit</button>
          {canManageDrivers && <><select aria-label={`Driver for ${job.title}`} className={inputClass + ' !w-auto'} value={assignments[job.id] || ''} onChange={e => setAssignments({ ...assignments, [job.id]: e.target.value })}><option value="">Choose outside driver…</option>{drivers.filter(d => d.active).map(d => <option key={d.externalDriverId} value={d.externalDriverId}>{d.displayName}</option>)}</select>
          <button disabled={busy || !assignments[job.id]} className={buttonClass} onClick={() => void run({ op: 'assign', jobId: job.id, expectedRevision: job.revision, requestId: crypto.randomUUID(), externalDriverId: assignments[job.id] })}>{job.externalDriverId ? 'Reassign' : 'Assign'}</button></>}
        </>}
        {(job.status === 'assigned' || job.status === 'in_progress') && <button disabled={busy} className={buttonClass} onClick={() => void run({ op: 'status', jobId: job.id, expectedRevision: job.revision, requestId: crypto.randomUUID(), status: job.status === 'assigned' ? 'in_progress' : 'completed' })}>{job.status === 'assigned' ? 'Mark started' : 'Mark completed'}</button>}
        {!['completed', 'cancelled'].includes(job.status) && <button disabled={busy} className="rounded border border-red-700 px-3 py-2 text-sm text-red-300" onClick={() => { if (window.confirm(`Cancel ${job.title}? Its history will be retained.`)) void run({ op: 'status', jobId: job.id, expectedRevision: job.revision, requestId: crypto.randomUUID(), status: 'cancelled' }); }}>Cancel job</button>}
      </div>}
      <p className="mt-2 text-xs text-gray-500">Progress recorded by dispatch staff · last updated {new Date(job.updatedAt).toLocaleString()}</p>
    </article>)}
  </div>;
}
