'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { independentDispatchJobs, type IndependentJob, type IndependentJobDetails, type IndependentJobStatus, type LinkedWellBuiltDriver } from '@/lib/independentDispatchJobs';
import { listExternalDrivers, type ExternalDriver } from '@/lib/externalAssignmentDelivery';
import { ExternalAssignmentDeliveryPanel } from './ExternalAssignmentDeliveryPanel';
import { independentDispatchDirectory, type IndependentDirectory } from '@/lib/independentDispatchDirectory';
import { SECTOR_FIELDS, sectorLabel, type IndependentSector } from '@/lib/independentDispatchSectors';
import { dialpadCallHref } from '@/lib/dialpad';
import { parsePastedJobRequest, type ParsedJobRequest } from '@/lib/independentRequestParser';
import { ACTIVE_LANES, pickupTiming, sortDispatchJobs } from '@/lib/independentDispatchBoard';
import { driverAvailability } from '@/lib/independentDriverAvailability';
import { listIndependentDriverProfiles, type IndependentDriverProfile } from '@/lib/independentDriverProfiles';
import { IndependentDriverPicker, type SelectedDriverShifts } from './IndependentDriverPicker';
import { IndependentWhatsAppLinks } from './IndependentWhatsAppLinks';
import { normalizeWhatsAppNumber } from '@/lib/independentWhatsAppDispatch';

const EMPTY: IndependentJobDetails = { title: '', customer: '', reference: '', pickup: '', destination: '', cargo: '', scheduledAt: '', notes: '',
  jobContactName: '', jobContactRole: '', jobContactPhoneE164: '', shift: '', ongoing: false, requestedDriverCount: null };
const STATUS: Record<IndependentJobStatus, string> = { unassigned: 'Unassigned', assigned: 'Assigned', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const FIELDS = [
  ['title', 'Job name', 180, true],
  ['reference', 'Customer reference / load number', 120, false],
  ['pickup', 'Pickup address / location', 500, true], ['destination', 'Delivery address / location', 500, true],
  ['cargo', 'Cargo / equipment / quantity', 500, false], ['notes', 'Instructions', 4000, false],
] as const;
const inputClass = 'w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white';
const buttonClass = 'rounded bg-blue-700 px-3 py-2 text-sm text-white disabled:opacity-40';
function jobCrew(job: IndependentJob) {
  if (Array.isArray(job.drivers)) return job.drivers;
  const shift = job.shift === 'day' || job.shift === 'night' ? job.shift : '';
  if (job.externalDriverId) return [{ key: `outside:${job.externalDriverId}`, name: job.driverName || '', source: 'outside' as const, shift }];
  if (job.wbDriverId) return [{ key: `wellbuilt:${job.wbDriverId}`, name: job.driverName || '', source: 'wellbuilt' as const, shift }];
  return [];
}

function JobDialpadLinks({ job, directory, drivers }: { job: IndependentJob; directory: IndependentDirectory | null; drivers: ExternalDriver[] }) {
  const customer = directory?.customers.find(item => item.id === job.customerId);
  const customerHref = dialpadCallHref(customer?.phoneE164, job.id, directory?.dispatchPhoneE164);
  const contactHref = dialpadCallHref(job.jobContactPhoneE164, job.id, directory?.dispatchPhoneE164);
  const driverLinks = jobCrew(job).filter(member => member.source === 'outside').map(member => ({
    name: member.name, key: member.key,
    href: dialpadCallHref(drivers.find(driver => `outside:${driver.externalDriverId}` === member.key)?.phoneE164, job.id, directory?.dispatchPhoneE164),
  })).filter(link => link.href);
  if (!customerHref && !contactHref && !driverLinks.length) return null;
  return <div className="mt-2 flex flex-wrap gap-3 text-sm text-cyan-300 underline">
    {customerHref && <a href={customerHref}>Call customer in Dialpad</a>}
    {contactHref && <a href={contactHref}>Call job contact in Dialpad</a>}
    {driverLinks.map(link => <a key={link.key} href={link.href || undefined}>{driverLinks.length === 1 ? 'Call driver in Dialpad' : `Call ${link.name} in Dialpad`}</a>)}
  </div>;
}

export function IndependentDispatchBoard({ companyId, canWrite, canManageDrivers }: {
  companyId: string; canWrite: boolean; canManageDrivers: boolean;
}) {
  const [jobs, setJobs] = useState<IndependentJob[]>([]);
  const [drivers, setDrivers] = useState<ExternalDriver[]>([]);
  const [wbDrivers, setWbDrivers] = useState<LinkedWellBuiltDriver[]>([]);
  const [driverProfiles, setDriverProfiles] = useState<IndependentDriverProfile[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<IndependentJob | null>(null);
  const [scheduledLocal, setScheduledLocal] = useState('');
  const [estimatedEndLocal, setEstimatedEndLocal] = useState('');
  const [availabilityNow, setAvailabilityNow] = useState(() => Date.now());
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [jobActionError, setJobActionError] = useState<{ jobId: string; message: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [assignments, setAssignments] = useState<Record<string, SelectedDriverShifts>>({});
  const [directory, setDirectory] = useState<IndependentDirectory | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [contactId, setContactId] = useState('');
  const [newCustomer, setNewCustomer] = useState(false);
  const [saveCustomer, setSaveCustomer] = useState(false);
  const [sector, setSector] = useState<IndependentSector | ''>('');
  const [sectorFields, setSectorFields] = useState<Record<string, string>>({});
  const [categoryId, setCategoryId] = useState('');
  const [asset, setAsset] = useState('');
  const [pastedRequest, setPastedRequest] = useState('');
  const [parseReport, setParseReport] = useState<ParsedJobRequest | null>(null);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [appHeaderHeight, setAppHeaderHeight] = useState(0);
  const needsDriverDialog = useRef<HTMLDialogElement>(null);
  // Keep create identity through an ambiguous network failure, avoiding duplicate jobs.
  const creation = useRef({ jobId: crypto.randomUUID(), requestId: crypto.randomUUID() });
  useEffect(() => {
    const header = document.querySelector<HTMLElement>('header');
    if (!header) return;
    const measure = () => setAppHeaderHeight(Math.ceil(header.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  const refresh = useCallback(async () => {
    const result = await independentDispatchJobs({ op: 'list' });
    if (result.companyId !== companyId) throw Error('Your staff account belongs to a different company.');
    setJobs(result.jobs || []);
    setWbDrivers(result.wbDrivers || []);
    const setup = await independentDispatchDirectory({ op: 'list' });
    if (setup.companyId !== companyId) throw Error('Your directory belongs to a different company.');
    setDirectory(setup);
    if (canManageDrivers) setDrivers(await listExternalDrivers());
    setLoaded(true);
  }, [companyId, canManageDrivers]);
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refresh]);
  useEffect(() => { if (canManageDrivers) void listIndependentDriverProfiles().then(setDriverProfiles).catch(() => setDriverProfiles([])); }, [canManageDrivers, companyId]);
  useEffect(() => { const timer = window.setInterval(() => setAvailabilityNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  async function run(payload: Record<string, unknown>, after?: () => void) {
    setBusy(true); setError(''); setJobActionError(null); setNotice('');
    try {
      await independentDispatchJobs(payload);
      after?.();
      setNotice('Saved.');
      await refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unable to save. Refresh and try again.';
      setError(message);
      if (typeof payload.jobId === 'string') setJobActionError({ jobId: payload.jobId, message });
    }
    finally { setBusy(false); }
  }
  function resetForm() {
    setForm(EMPTY); setEditing(null); setScheduledLocal(''); setEstimatedEndLocal(''); setCustomerId(''); setContactId(''); setNewCustomer(false); setSaveCustomer(false); setSector(''); setSectorFields({}); setCategoryId(''); setAsset('');
    setPastedRequest(''); setParseReport(null);
    creation.current = { jobId: crypto.randomUUID(), requestId: crypto.randomUUID() };
  }
  function scrollBelowBoardToolbar(targetId: string) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      const toolbar = document.querySelector<HTMLElement>('[data-testid="independent-board-toolbar"]');
      if (!target) return;
      const offset = appHeaderHeight + (toolbar?.getBoundingClientRect().height || 0) + 16;
      window.scrollTo({ top: Math.max(0, window.scrollY + target.getBoundingClientRect().top - offset), behavior: 'smooth' });
    }));
  }
  function returnToBoardJob(job: IndependentJob) {
    setIntakeOpen(false); setSelectedJobId(job.id); setFilter(job.status); setSearch('');
    scrollBelowBoardToolbar(`independent-job-${job.id}`);
  }
  function leaveEdit() {
    const job = editing;
    resetForm();
    if (job) returnToBoardJob(job);
  }
  function edit(job: IndependentJob) {
    setSelectedJobId(job.id);
    setIntakeOpen(true);
    setEditing(job);
    setForm({ ...EMPTY, ...Object.fromEntries(Object.keys(EMPTY).map(k => [k, job[k as keyof IndependentJobDetails] ?? EMPTY[k as keyof IndependentJobDetails]])) } as IndependentJobDetails);
    setCustomerId(job.customerId || ''); setNewCustomer(!!job.sector && !job.customerId); setSaveCustomer(false);
    const savedContact = directory?.customers.find(customer => customer.id === job.customerId)?.contacts?.find(contact =>
      contact.name === job.jobContactName && contact.phoneE164 === job.jobContactPhoneE164 && contact.role === job.jobContactRole);
    setContactId(savedContact?.id || '');
    setSector((job.sector as IndependentSector) || ''); setSectorFields(job.sectorFields || {});
    setCategoryId(job.categoryId || ''); setAsset(job.asset || '');
    const date = job.scheduledAt ? new Date(job.scheduledAt) : null;
    setScheduledLocal(date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
    const end = job.estimatedEndAt ? new Date(job.estimatedEndAt) : null;
    setEstimatedEndLocal(end ? new Date(end.getTime() - end.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
    scrollBelowBoardToolbar('independent-job-form');
  }
  const visible = jobs.filter(job => (filter === 'all' || (filter === 'active' ? !['completed', 'cancelled'].includes(job.status) : filter === job.status))
    && [job.title, job.customer, job.reference, job.pickup, job.destination, ...jobCrew(job).map(driver => driver.name), job.jobContactName].join(' ').toLowerCase().includes(search.toLowerCase()));
  const lanes = filter === 'active' ? ACTIVE_LANES : filter === 'all'
    ? [...ACTIVE_LANES, { status: 'completed' as const, label: 'Completed', hint: 'Finished work' }, { status: 'cancelled' as const, label: 'Cancelled', hint: 'Retained history' }]
    : [{ status: filter as IndependentJobStatus, label: STATUS[filter as IndependentJobStatus], hint: '' }];
  const displayedLanes = filter === 'active' ? lanes.filter(lane => visible.some(job => job.status === lane.status)) : lanes;
  const workingLaneCount = displayedLanes.filter(lane => lane.status === 'assigned' || lane.status === 'in_progress').length;
  const selectedCustomer = directory?.customers.find(customer => customer.id === customerId);
  const availableCategories = (selectedCustomer?.workCategories || []).filter(category => category.sector === sector);
  const selectedCategory = availableCategories.find(category => category.id === categoryId);
  const availableSectors = newCustomer ? directory?.sectors || [] : (selectedCustomer?.sectors || []).filter(id => directory?.sectors.includes(id));
  function canAddSelection(job: IndependentJob, replacing = false) {
    const selected = Object.keys(assignments[job.id] || {});
    if (!selected.length || (!replacing && jobCrew(job).length + selected.length > 30)) return false;
    return selected.every(key => {
      const active = key.startsWith('outside:') ? drivers.some(driver => `outside:${driver.externalDriverId}` === key && driver.active)
        : wbDrivers.some(driver => `wellbuilt:${driver.driverId}` === key && driver.active);
      return active && !jobCrew(job).some(member => member.key === key)
        && driverAvailability(job, key, jobs, active, availabilityNow).available;
    });
  }
  function crewRow(job: IndependentJob, driver: ReturnType<typeof jobCrew>[number]) {
    const missingPhone = driver.source === 'outside' && !normalizeWhatsAppNumber(
      drivers.find(profile => `outside:${profile.externalDriverId}` === driver.key)?.phoneE164);
    return <div key={driver.key} className="grid min-h-[4.75rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-t border-gray-700/70 px-2 py-2 first:border-t-0">
      <div className="min-w-0">
        <p className={`flex flex-wrap items-center gap-1 text-xs ${missingPhone ? 'text-red-300' : 'text-white'}`}>
          <span className="min-w-0 break-words whitespace-normal" title={driver.name}>{driver.name}{driver.source === 'wellbuilt' ? ' · WB' : ''}</span>
          {missingPhone && <span className="rounded border border-red-600 bg-red-950/80 px-1 py-0.5 text-[10px] font-semibold text-red-200">No Contact Info</span>}
        </p>
        {!driver.shift && crewShift(driver) && <p className="text-[10px] text-gray-400">Using {crewShift(driver)} shift from profile</p>}
      </div>
      {canWrite && canManageDrivers && ['assigned', 'in_progress'].includes(job.status) && <div className="flex flex-col items-end gap-1 text-xs">
        <select aria-label={`Assignment shift for ${driver.name} on ${job.title}`} value={crewShift(driver)} disabled={busy}
          className="rounded border border-gray-600 bg-gray-950 px-1 py-0.5 text-xs text-white"
          onChange={event => void run({ op: 'setDriverShift', jobId: job.id, expectedRevision: job.revision,
            requestId: crypto.randomUUID(), driverKey: driver.key, shift: event.target.value })}>
          <option value="" disabled>Set shift</option><option value="day">Day</option><option value="night">Night</option>
        </select>
        <div className="flex items-center justify-end gap-2">
          <button type="button" disabled={busy || Object.keys(assignments[job.id] || {}).length !== 1 || !canAddSelection(job, true)}
            className="text-cyan-300 underline disabled:opacity-40" title="Replace with the selected driver" onClick={() => {
              const key = Object.keys(assignments[job.id] || {})[0];
              const [kind, id] = key.split(':'); if (!id) return;
              void run({ op: 'replaceDriver', jobId: job.id, driverKey: driver.key, expectedRevision: job.revision, requestId: crypto.randomUUID(),
                shift: assignments[job.id]?.[key] ?? driver.shift ?? '', ...(kind === 'wellbuilt' ? { wbDriverId: id } : { externalDriverId: id }) },
                () => setAssignments(current => ({ ...current, [job.id]: {} })));
            }}>Swap</button>
          <button type="button" disabled={busy || (job.status === 'in_progress' && jobCrew(job).length === 1)}
            className="text-red-300 underline disabled:opacity-40" onClick={() => void run({ op: 'removeDriver', jobId: job.id,
              driverKey: driver.key, expectedRevision: job.revision, requestId: crypto.randomUUID() })}>Remove</button>
        </div>
      </div>}
    </div>;
  }
  function crewShift(driver: ReturnType<typeof jobCrew>[number]): '' | 'day' | 'night' {
    if (driver.shift === 'day' || driver.shift === 'night') return driver.shift;
    const preference = driver.source === 'outside'
      ? drivers.find(item => `outside:${item.externalDriverId}` === driver.key)?.shiftPreference
      : driverProfiles.find(item => item.driverKey === driver.key)?.shiftPreference;
    return preference === 'day' || preference === 'night' ? preference : '';
  }
  function chooseSavedCustomer(id: string) {
    const next = directory?.customers.find(customer => customer.id === id);
    const retainParsed = !!parseReport && !customerId;
    setNewCustomer(false); setSaveCustomer(false); setCustomerId(next?.id || ''); setContactId('');
    setForm(current => ({ ...current, customer: next?.name || '',
      ...(retainParsed ? {} : { title: '', pickup: '', destination: '', jobContactName: '', jobContactRole: '', jobContactPhoneE164: '' }) }));
    const choices = (next?.sectors || []).filter(value => directory?.sectors.includes(value));
    const parsedSector = retainParsed ? parseReport?.sector : '';
    const nextSector = parsedSector && choices.includes(parsedSector) ? parsedSector : choices.length === 1 ? choices[0] : '';
    setSector(nextSector);
    setSectorFields(retainParsed && nextSector === parsedSector ? parseReport?.sectorFields || {} : {});
    setCategoryId(''); setAsset('');
  }
  function fillFromRequest() {
    if (!directory || !pastedRequest.trim() || editing) return;
    const result = parsePastedJobRequest(pastedRequest, directory);
    const customer = directory.customers.find(item => item.id === result.customerId);
    setCustomerId(result.customerId);
    setContactId('');
    setNewCustomer(!!result.customerLabel && !customer && result.customerSuggestions.length === 0); setSaveCustomer(false);
    setSector(result.sector);
    setSectorFields(result.sectorFields);
    setCategoryId(''); setAsset('');
    setScheduledLocal(result.scheduledLocal);
    setEstimatedEndLocal('');
    setForm({ ...EMPTY, ...result.fields, customer: customer?.name || result.customerLabel });
    setParseReport(result);
    document.getElementById('independent-job-form')?.scrollIntoView({ behavior: 'smooth' });
  }
  return <div className="flex flex-col gap-4">
    {error && <div role="alert" className="rounded border border-red-700 bg-red-950 p-3 text-red-200">{error}</div>}
    {notice && <p role="status" className="text-green-300">{notice}</p>}
    <section aria-labelledby="dispatch-board-title" className="space-y-4">
    <div data-testid="independent-board-toolbar" className="sticky z-30 space-y-3 rounded-lg border border-gray-700 bg-gray-900/95 p-3 shadow-lg backdrop-blur" style={{ top: appHeaderHeight }}>
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 id="dispatch-board-title" className="text-lg font-semibold text-white">Dispatch board</h2><p className="text-sm text-gray-400">Save requests now. Assign a driver when one is available. Assigned WellBuilt drivers do not receive these jobs in their phone app yet.</p></div>
        <div className="flex flex-wrap items-center gap-3">{canManageDrivers && <Link href="/dispatch/independent/drivers/" className="text-sm text-cyan-300 underline">Driver profiles</Link>}{canWrite && <button type="button" aria-expanded={intakeOpen} aria-controls="independent-intake" className={buttonClass} onClick={() => { setIntakeOpen(true); scrollBelowBoardToolbar('independent-intake'); }}>New job / paste request</button>}</div>
        <div className="flex flex-wrap gap-2 text-xs"><span className="rounded bg-amber-900/40 px-2 py-1 text-amber-200">{jobs.filter(job => job.status === 'unassigned').length} need drivers</span><span className="rounded bg-blue-900/40 px-2 py-1 text-blue-200">{jobs.filter(job => job.status === 'assigned').length} assigned</span><span className="rounded bg-emerald-900/40 px-2 py-1 text-emerald-200">{jobs.filter(job => job.status === 'in_progress').length} in progress</span></div>
      </div>
    <div className="flex flex-wrap gap-2">
      <input aria-label="Search dispatch jobs" placeholder="Search jobs, customers, locations, drivers…" value={search} onChange={e => setSearch(e.target.value)} className={`${inputClass} flex-1 min-w-48`} />
      <select aria-label="Job status" className={inputClass + ' !w-auto'} value={filter} onChange={e => setFilter(e.target.value)}><option value="active">Active jobs</option><option value="all">All jobs</option>{Object.entries(STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => { setError(''); void refresh().catch(e => setError(e.message)); }}>Refresh</button>
    </div>
    </div>
    {!loaded ? <p className="text-gray-400">Loading jobs…</p> : displayedLanes.length === 0 ? <p className="rounded border border-dashed border-gray-700 p-4 text-sm text-gray-400">No active jobs. New requests will appear here.</p> : <div className={`grid items-start gap-3 ${filter === 'active' ? 'lg:grid-cols-2' : lanes.length > 1 ? 'lg:grid-cols-3' : ''}`}>
      {displayedLanes.map(lane => {
        const isWaitingQueue = filter === 'active' && lane.status === 'unassigned';
        const laneJobs = sortDispatchJobs(visible.filter(job => job.status === lane.status), ['completed', 'cancelled'].includes(lane.status));
        const cards = <div className={isWaitingQueue || (filter === 'active' && workingLaneCount === 1) ? 'grid gap-3 lg:grid-cols-2 2xl:grid-cols-3' : 'space-y-3'}>{laneJobs.length === 0 ? <p className="rounded border border-dashed border-gray-700 p-4 text-sm text-gray-500">No jobs here.</p> : laneJobs.map(job => <article key={job.id} id={`independent-job-${job.id}`} tabIndex={0} aria-label={`${job.customer} · ${job.title}`}
          onClickCapture={() => setSelectedJobId(job.id)} onFocusCapture={() => setSelectedJobId(job.id)}
          onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setSelectedJobId(job.id); } }}
          className={`min-w-0 rounded border p-4 transition-colors ${selectedJobId === job.id ? 'border-amber-400 bg-amber-950/30 ring-2 ring-amber-400/70 shadow-lg shadow-amber-950/30' : `bg-gray-800 ${job.status === 'unassigned' ? 'border-amber-700/70' : 'border-gray-700'}`}`}>
      <div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold text-white">{job.title}</h2><span className="text-cyan-300">{STATUS[job.status]}</span></div>
      <p className="text-sm text-gray-300">{job.customer}{job.sector ? ` · ${sectorLabel(job.sector)}` : ''}{job.reference ? ` · ${job.reference}` : ''}</p>
      {(job.categoryId || job.asset) && <p className="text-sm text-cyan-200">{directory?.customers.find(customer => customer.id === job.customerId)?.workCategories?.find(category => category.id === job.categoryId)?.name || (job.categoryId ? 'Archived category' : '')}{job.asset ? ` · ${job.asset}` : ''}</p>}
      <p className={`mt-2 text-sm font-medium ${pickupTiming(job) === 'overdue' && !['completed', 'cancelled'].includes(job.status) ? 'text-red-300' : pickupTiming(job) === 'soon' ? 'text-amber-200' : 'text-gray-300'}`}>Pickup: {job.scheduledAt ? new Date(job.scheduledAt).toLocaleString() : 'Time not set'}{pickupTiming(job) === 'overdue' && !['completed', 'cancelled'].includes(job.status) ? ' · Past requested time' : ''}</p>
      {job.estimatedEndAt && <p className="text-sm text-gray-300">Estimated finish: {new Date(job.estimatedEndAt).toLocaleString()}</p>}
      {(job.shift || job.ongoing) && <p className="text-sm text-cyan-200">{job.shift === 'day' ? 'Day shift' : job.shift === 'night' ? 'Night shift' : job.shift === 'both' ? 'Day and night shifts' : 'Any shift'}{job.ongoing ? ' · Ongoing work' : ''}</p>}
      {job.requestedDriverCount && <p className="text-sm text-amber-200">Drivers requested: {job.requestedDriverCount} · Assigned: {jobCrew(job).length}{jobCrew(job).length < job.requestedDriverCount ? ` · ${job.requestedDriverCount - jobCrew(job).length} still needed` : ''}</p>}
      {job.jobContactName && <p className="text-sm text-gray-300">Job contact: {job.jobContactName}{job.jobContactRole ? ` · ${job.jobContactRole}` : ''}{job.jobContactPhoneE164 ? ` · ${job.jobContactPhoneE164}` : ''}</p>}
      <JobDialpadLinks job={job} directory={directory} drivers={drivers} />
      {canWrite && <IndependentWhatsAppLinks job={job} />}
      <dl className="mt-2 grid gap-2 text-sm md:grid-cols-2"><div><dt className="text-gray-400">Pickup</dt><dd className="whitespace-pre-wrap break-words text-white">{job.pickup}</dd></div><div><dt className="text-gray-400">Delivery</dt><dd className="whitespace-pre-wrap break-words text-white">{job.destination}</dd></div></dl>
      {(job.cargo || job.notes || (job.sector && Object.values(job.sectorFields || {}).some(Boolean))) && <details className="mt-3 rounded border border-gray-700 bg-gray-900/60 p-2 text-sm"><summary className="cursor-pointer text-cyan-200">Details and instructions</summary>
        {job.cargo && <p className="mt-2 whitespace-pre-wrap break-words text-gray-300">Cargo: {job.cargo}</p>}
        {job.sector && job.sectorFields && <dl className="mt-2 grid gap-1 text-xs text-gray-300">{SECTOR_FIELDS[job.sector as IndependentSector]?.map(field => job.sectorFields?.[field.key] ? <div key={field.key}><dt className="inline text-gray-400">{field.label}: </dt><dd className="inline">{job.sectorFields[field.key]}</dd></div> : null)}</dl>}
        {job.notes && <p className="mt-2 whitespace-pre-wrap break-words text-gray-300">{job.notes}</p>}
      </details>}
      <div className="mt-2 text-sm text-amber-200">{jobCrew(job).length ? <><span className="font-medium">Drivers ({jobCrew(job).length})</span>
        <div className="mt-2 grid w-full grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3">
          {(['day', 'night'] as const).map(shift => <div key={shift} role="region" aria-label={`${shift === 'day' ? 'Day' : 'Night'} Shift drivers`} className="min-w-0 rounded border border-gray-700 bg-gray-900/70 px-3 py-2">
            <div className="flex items-center justify-between gap-2 border-b border-gray-700 pb-1 text-xs font-semibold text-cyan-200"><span>{shift === 'day' ? 'Day Shift' : 'Night Shift'}</span><span aria-label={`${jobCrew(job).filter(driver => crewShift(driver) === shift).length} ${shift} shift drivers`}>{jobCrew(job).filter(driver => crewShift(driver) === shift).length}</span></div>
            <div className="h-[15rem] overflow-y-auto">{jobCrew(job).filter(driver => crewShift(driver) === shift).map(driver => crewRow(job, driver))}</div>
          </div>)}
        </div>
        {jobCrew(job).some(driver => !crewShift(driver)) && <div className="mx-auto mt-2 w-full max-w-2xl text-xs text-gray-300">
          <p>Shift needs review ({jobCrew(job).filter(driver => !crewShift(driver)).length})</p>
          {jobCrew(job).filter(driver => !crewShift(driver)).map(driver => crewRow(job, driver))}
        </div>}
      </> : 'Needs a driver'}</div>
      {canWrite && canManageDrivers && ['unassigned', 'assigned', 'in_progress'].includes(job.status) && <p className="mt-3 text-xs text-gray-400" title="ID has no verified HOS feed; dispatch decides whether to assign.">HOS unverified</p>}
      {canWrite && <div className="mt-2">
        {canManageDrivers && ['unassigned', 'assigned', 'in_progress'].includes(job.status) && <IndependentDriverPicker job={job} jobs={jobs} outside={drivers} linked={wbDrivers} profiles={driverProfiles}
          now={availabilityNow} selected={assignments[job.id] || {}} disabled={busy}
          onChange={next => setAssignments(current => ({ ...current, [job.id]: next }))} />}
        <div className="mt-2 flex flex-wrap items-center gap-2">
        {['unassigned', 'assigned', 'in_progress'].includes(job.status) && <>
          {['unassigned', 'assigned'].includes(job.status) && <button className={buttonClass} disabled={busy} onClick={() => { if (isWaitingQueue) needsDriverDialog.current?.close(); edit(job); }}>Edit</button>}
          {canManageDrivers && <button disabled={busy || !canAddSelection(job)} className={buttonClass} onClick={() => {
            const selected = Object.entries(assignments[job.id] || {}).map(([key, shift]) => ({ key, shift }));
            if (!selected.length) return;
            void run({ op: 'addDrivers', jobId: job.id, expectedRevision: job.revision, requestId: crypto.randomUUID(), drivers: selected },
              () => setAssignments(current => ({ ...current, [job.id]: {} })));
          }}>{jobCrew(job).length ? 'Add selected drivers' : 'Assign selected drivers'}</button>}
        </>}
        {(job.status === 'assigned' || job.status === 'in_progress') && <button disabled={busy} className={buttonClass} onClick={() => void run({ op: 'status', jobId: job.id, expectedRevision: job.revision, requestId: crypto.randomUUID(), status: job.status === 'assigned' ? 'in_progress' : 'completed' })}>{job.status === 'assigned' ? 'Mark started' : 'Mark completed'}</button>}
        </div>
      </div>}
      {jobActionError?.jobId === job.id && <p role="alert" className="mt-2 text-sm text-red-300">Assignment was not saved: {jobActionError.message}</p>}
      <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
        <p className="text-xs text-gray-500">Progress recorded by dispatch staff · last updated {new Date(job.updatedAt).toLocaleString()}</p>
        {canWrite && !['completed', 'cancelled'].includes(job.status) && <button disabled={busy} className="rounded border border-red-700 px-3 py-2 text-sm text-red-300" onClick={() => { if (window.confirm(`Cancel ${job.title}? Its history will be retained.`)) void run({ op: 'status', jobId: job.id, expectedRevision: job.revision, requestId: crypto.randomUUID(), status: 'cancelled' }); }}>Cancel job</button>}
      </div>
    </article>)}</div>;
        return <section key={lane.status} aria-label={`${lane.label} jobs`} className={`min-w-0 rounded-lg border ${isWaitingQueue ? 'border-amber-700/70 bg-amber-950/20' : 'border-gray-700 bg-gray-950/60'} p-3 ${filter === 'active' && (isWaitingQueue || workingLaneCount === 1) ? 'lg:col-span-2' : ''}`}>
          {isWaitingQueue ? <>
            <button type="button" className="flex w-full items-center justify-between gap-3 text-left" onClick={() => needsDriverDialog.current?.showModal()}>
              <span className="flex items-center gap-2 font-semibold text-amber-100">Needs a driver <span className="rounded bg-amber-700 px-2 py-0.5 text-sm text-white">{laneJobs.length}</span></span>
              <span className="text-sm text-cyan-200">Review and assign →</span>
            </button>
            <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-3">{laneJobs.slice(0, 3).map(job => <div key={job.id} className="min-w-0 rounded border border-amber-900/60 bg-gray-900/70 px-3 py-2">
              <p className="truncate font-medium text-white">{job.customer} · {job.title}</p>
              <p className="truncate text-gray-300">Pickup {job.scheduledAt ? new Date(job.scheduledAt).toLocaleString() : 'time not set'} · {job.pickup}{job.requestedDriverCount ? ` · ${job.requestedDriverCount} drivers requested` : ''}</p>
            </div>)}</div>
            {laneJobs.length > 3 && <p className="mt-2 text-xs text-amber-200">+{laneJobs.length - 3} more waiting</p>}
            <dialog ref={needsDriverDialog} aria-label="Jobs needing a driver" className="fixed inset-0 m-auto max-h-[90vh] w-[min(96vw,90rem)] max-w-none overflow-y-auto rounded-xl border border-amber-700 bg-gray-950 p-4 text-white shadow-2xl backdrop:bg-black/75">
              <div className="mb-4 flex items-start justify-between gap-3"><div><h3 className="text-xl font-semibold">Needs a driver <span className="text-amber-300">{laneJobs.length}</span></h3><p className="text-sm text-gray-300">Review requests and assign drivers. Press Escape or Close to return to the board.</p></div><button type="button" className={buttonClass} onClick={() => needsDriverDialog.current?.close()}>Close</button></div>
              {cards}
            </dialog>
          </> : <>
            <div className="mb-3 flex items-start justify-between gap-2"><div><h3 className="font-semibold text-white">{lane.label}</h3>{lane.hint && <p className="text-xs text-gray-400">{lane.hint}</p>}</div><span className="rounded bg-gray-800 px-2 py-0.5 text-sm text-gray-200">{laneJobs.length}</span></div>
            {cards}
          </>}
        </section>;
      })}
    </div>}
    </section>
    <div id="independent-intake" hidden={!intakeOpen} className="max-w-5xl space-y-4">
    {canWrite && <section className="rounded border border-cyan-800 bg-cyan-950/20 p-4" aria-labelledby="paste-request-title">
      <h2 id="paste-request-title" className="font-semibold text-cyan-300">Paste a job request</h2>
      <p className="mt-1 text-sm text-gray-300">Paste a text or WhatsApp request, then review the filled form. Nothing is saved or sent until you create the job. Phone requests can be entered directly below.</p>
      <textarea aria-label="Job request text" value={pastedRequest} onChange={event => setPastedRequest(event.target.value)}
        maxLength={10000} rows={5} placeholder={'Customer: Example Hauling\nSector: Water hauling\nJob: Production water run\nPickup: Well pad\nDelivery: Disposal site\nBarrels: 120'}
        className={`${inputClass} mt-3`} />
      <button type="button" className={`${buttonClass} mt-2 px-3 py-2`} disabled={!loaded || !pastedRequest.trim() || !!editing}
        onClick={fillFromRequest}>Fill job form from text</button>
      {editing && <p className="mt-2 text-sm text-amber-200">Finish editing or choose Clear / new job before parsing another request.</p>}
      {parseReport && <div role="status" className="mt-3 space-y-1 text-sm text-gray-200">
        <p>Initial extraction applied. Check every field before creating the job.</p>
        {parseReport.missing.filter(item => item !== 'Customer' || (!customerId && !newCustomer)).length > 0
          && <p className="text-amber-200">Still needed: {parseReport.missing.filter(item => item !== 'Customer' || (!customerId && !newCustomer)).join(', ')}.</p>}
        {parseReport.warnings.map(warning => <p key={warning} className="text-amber-200">{warning}</p>)}
      </div>}
    </section>}
    {canWrite && <form id="independent-job-form" className={`rounded p-4 ${editing ? 'border-2 border-amber-400 bg-amber-950/30 ring-2 ring-amber-500/30 shadow-xl shadow-amber-950/30' : 'border border-gray-700 bg-gray-800'}`} onSubmit={event => {
      event.preventDefault();
      const job = { ...form, scheduledAt: scheduledLocal ? new Date(scheduledLocal).toISOString() : '',
        estimatedEndAt: estimatedEndLocal ? new Date(estimatedEndLocal).toISOString() : '',
        ...(sector ? { ...(customerId ? { customerId } : {}), sector, sectorFields } : {}),
        ...(customerId ? { categoryId, asset: categoryId ? asset.trim() : '' } : {}) };
      void run({ op: editing ? 'update' : 'create', jobId: editing?.id || creation.current.jobId,
        requestId: editing ? crypto.randomUUID() : creation.current.requestId,
        ...(editing ? { expectedRevision: editing.revision } : {}),
        ...(!editing && newCustomer && saveCustomer ? { saveCustomer: true } : {}), job }, () => {
          const editedJob = editing;
          resetForm();
          if (editedJob) returnToBoardJob(editedJob);
          else requestAnimationFrame(() => document.getElementById('dispatch-board-title')?.scrollIntoView({ behavior: 'smooth' }));
        });
    }}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2"><div><h2 className={`text-lg font-semibold ${editing ? 'text-amber-200' : 'text-cyan-300'}`}>{editing ? `Editing job: ${editing.title}` : 'New Independent Dispatch job'}</h2>{editing && <p className="mt-1 text-sm text-amber-100">{editing.customer} · Review the details below, then Save changes.</p>}</div><button type="button" className="text-sm text-cyan-200 underline" onClick={editing ? leaveEdit : () => setIntakeOpen(false)}>{editing ? 'Cancel edit / back to board' : 'Hide intake'}</button></div>
      <fieldset disabled={busy || !loaded} className="grid gap-3 md:grid-cols-2">
        {(!editing || editing.sector) ? <>
          <div className="text-xs text-gray-300">Customer *<select aria-label="Customer" required value={newCustomer ? '__new__' : customerId} className={inputClass} onChange={event => {
            if (event.target.value === '__new__') { setNewCustomer(true); setSaveCustomer(false); setCustomerId(''); setContactId('');
              setForm(current => ({ ...current, customer: parseReport?.customerLabel || '',
                ...(parseReport ? {} : { jobContactName: '', jobContactRole: '', jobContactPhoneE164: '' }) }));
              setSector(parseReport?.sector || ''); setSectorFields(parseReport?.sectorFields || {}); setCategoryId(''); setAsset(''); return; }
            chooseSavedCustomer(event.target.value);
          }}><option value="">Choose customer…</option>{directory?.customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}<option value="__new__">NEW customer…</option></select>
            {newCustomer && <div className="mt-2 space-y-2"><label className="block">NEW customer · enter the official company name
              <input aria-label="New customer's official company name" required maxLength={180} value={form.customer}
                onChange={event => setForm(current => ({ ...current, customer: event.target.value }))} className={inputClass} />
            </label>{!editing && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={saveCustomer} onChange={event => setSaveCustomer(event.target.checked)} />Save this customer for future jobs</label>}</div>}
            {!!parseReport?.customerSuggestions.length && !customerId && <div className="mt-2 text-amber-200">Possible saved customers — confirm the company: {parseReport.customerSuggestions.map(suggestion => <button key={suggestion.id} type="button" className="mr-2 underline" onClick={() => chooseSavedCustomer(suggestion.id)}>{suggestion.name}{suggestion.sectorMatch ? ' · matches job sector' : ''}</button>)}</div>}
          </div>
          <label className="text-xs text-gray-300">Transportation sector *<select aria-label="Transportation sector" required value={sector} className={inputClass} onChange={event => { setSector(event.target.value as IndependentSector); setSectorFields({}); setCategoryId(''); setAsset(''); }}>
            <option value="">{availableSectors.length ? 'Choose sector…' : 'Choose a customer first…'}</option>
            {availableSectors.map(id => <option key={id} value={id}>{sectorLabel(id)}</option>)}
          </select></label>
        </> : <label className="text-xs text-gray-300">Customer *<input required maxLength={180} value={form.customer} onChange={event => setForm({ ...form, customer: event.target.value })} className={inputClass} /></label>}
        {(!!availableCategories.length || !!categoryId) && <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
          <label className="text-xs text-gray-300">Customer category<select aria-label="Customer category" value={categoryId} className={inputClass} onChange={event => { setCategoryId(event.target.value); setAsset(''); }}>
            <option value="">General job / no category</option>{categoryId && !selectedCategory && <option value={categoryId}>Archived category</option>}{availableCategories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select></label>
          {selectedCategory && <label className="text-xs text-gray-300">Rig, site, or asset<input aria-label="Rig, site, or asset" list="independent-category-assets" maxLength={180} value={asset} onChange={event => setAsset(event.target.value)} className={inputClass} />
            <datalist id="independent-category-assets">{selectedCategory.assets.map(value => <option key={value} value={value} />)}</datalist>
          </label>}
          {selectedCategory?.sourceChannels.length ? <p className="text-xs text-gray-400 md:col-span-2">Known source channels: {selectedCategory.sourceChannels.join(', ')}. Select the actual job details from the request.</p> : null}
        </div>}
        <div className="rounded border border-cyan-700/40 bg-cyan-950/20 p-3 md:col-span-2">
          <h3 className="text-sm font-medium text-cyan-300">Company man / job contact</h3>
          <p className="mt-1 text-xs text-gray-400">Choose this job’s contact or enter the person and phone supplied with the request. Changes here apply to this job only.</p>
          {!!selectedCustomer?.contacts?.length && <label className="mt-2 block text-xs text-gray-300">Saved customer contacts
            <select aria-label="Saved job contact" value={contactId} className={inputClass} onChange={event => {
              const contact = selectedCustomer.contacts?.find(item => item.id === event.target.value);
              setContactId(contact?.id || '');
              setForm(current => ({ ...current, jobContactName: contact?.name || '', jobContactRole: contact?.role || '', jobContactPhoneE164: contact?.phoneE164 || '' }));
            }}><option value="">Enter a contact for this job…</option>{selectedCustomer.contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.name}{contact.role ? ` · ${contact.role}` : ''}</option>)}</select>
          </label>}
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <label className="text-xs text-gray-300">Contact name<input maxLength={120} value={form.jobContactName || ''} onChange={event => { setContactId(''); setForm(current => ({ ...current, jobContactName: event.target.value })); }} className={inputClass} /></label>
            <label className="text-xs text-gray-300">Role / title<input maxLength={80} value={form.jobContactRole || ''} onChange={event => { setContactId(''); setForm(current => ({ ...current, jobContactRole: event.target.value })); }} placeholder="Company man" className={inputClass} /></label>
            <label className="text-xs text-gray-300">Contact phone (+country code)<input type="tel" pattern="\+[1-9][0-9]{7,14}" value={form.jobContactPhoneE164 || ''} onChange={event => { setContactId(''); setForm(current => ({ ...current, jobContactPhoneE164: event.target.value })); }} placeholder="+17015550123" className={inputClass} /></label>
          </div>
        </div>
        {FIELDS.map(([key, label, max, required]) => <label key={key} className={`text-xs text-gray-300 ${key === 'notes' ? 'md:col-span-2' : ''}`}>
          {label}{required ? ' *' : ''}
          {key === 'notes' ? <textarea className={inputClass} rows={3} maxLength={max} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} />
            : <input list={key === 'title' ? 'independent-job-names' : key === 'pickup' ? 'independent-pickups' : key === 'destination' ? 'independent-deliveries' : undefined}
              className={inputClass} required={required} maxLength={max} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} />}
        </label>)}
        <datalist id="independent-job-names">{selectedCustomer?.jobNames.map(value => <option key={value} value={value} />)}</datalist>
        <datalist id="independent-pickups">{selectedCustomer?.pickupLocations.map(value => <option key={value} value={value} />)}</datalist>
        <datalist id="independent-deliveries">{selectedCustomer?.deliveryLocations.map(value => <option key={value} value={value} />)}</datalist>
        {sector && <div className="rounded border border-cyan-700/50 bg-cyan-950/20 p-3 md:col-span-2">
          <h3 className="mb-2 text-sm font-semibold text-cyan-300">{sectorLabel(sector)} details</h3>
          <div className="grid gap-3 md:grid-cols-2">{SECTOR_FIELDS[sector].map(field => <label key={field.key} className="text-xs text-gray-300">
            {field.label}{field.required ? ' *' : ''}
            {field.options ? <select aria-label={field.label} required={field.required} value={sectorFields[field.key] || ''} className={inputClass}
              onChange={event => setSectorFields(current => ({ ...current, [field.key]: event.target.value }))}>
              <option value="">Choose…</option>{field.options.map(value => <option key={value} value={value}>{value}</option>)}
            </select> : <input aria-label={field.label} required={field.required} type={field.type || 'text'} min={field.type === 'number' ? 0.01 : undefined}
              step={field.type === 'number' ? '0.01' : undefined} maxLength={160} value={sectorFields[field.key] || ''}
              onChange={event => setSectorFields(current => ({ ...current, [field.key]: event.target.value }))} className={inputClass} />}
          </label>)}</div>
        </div>}
        <label className="text-xs text-gray-300">Scheduled pickup (your local time)<input type="datetime-local" className={inputClass} value={scheduledLocal} onChange={e => setScheduledLocal(e.target.value)} /></label>
        <label className="text-xs text-gray-300">Estimated finish (your local time)<input type="datetime-local" className={inputClass} value={estimatedEndLocal} min={scheduledLocal || undefined} onChange={e => setEstimatedEndLocal(e.target.value)} /></label>
        <label className="text-xs text-gray-300">Shift<select aria-label="Job shift" className={inputClass} value={form.shift || ''} onChange={e => setForm(current => ({ ...current, shift: e.target.value as IndependentJobDetails['shift'] }))}><option value="">Not specified</option><option value="day">Day shift</option><option value="night">Night shift</option><option value="both">Day and night shifts</option></select></label>
        <label className="text-xs text-gray-300">Drivers requested<input aria-label="Drivers requested" type="number" min={1} max={30} step={1} className={inputClass} value={form.requestedDriverCount ?? ''} onChange={e => setForm(current => ({ ...current, requestedDriverCount: e.target.value ? Number(e.target.value) : null }))} /></label>
        <label className="flex items-center gap-2 text-sm text-gray-200"><input type="checkbox" checked={form.ongoing || false} onChange={e => setForm(current => ({ ...current, ongoing: e.target.checked }))} />Ongoing / recurring work</label>
        <p className="text-xs text-gray-400 md:col-span-2">If the finish is unknown, an assigned driver stays unavailable for other jobs until this job is completed or cancelled.</p>
        <div className="flex items-end gap-2"><button disabled={!editing && ((!customerId && !newCustomer) || !sector || !form.customer.trim())} className={buttonClass}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create job'}</button>
          <button type="button" className="text-sm text-gray-300" onClick={resetForm}>Clear / new job</button></div>
      </fieldset>
    </form>}
    </div>
    {canManageDrivers && <div><ExternalAssignmentDeliveryPanel jobs={[]} canManage={canWrite && canManageDrivers} rosterOnly onRosterChange={refresh} /></div>}
  </div>;
}
