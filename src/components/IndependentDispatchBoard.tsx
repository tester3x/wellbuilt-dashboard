'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { independentDispatchJobs, type IndependentJob, type IndependentJobDetails, type IndependentJobStatus, type LinkedWellBuiltDriver } from '@/lib/independentDispatchJobs';
import { listExternalDrivers, type ExternalDriver } from '@/lib/externalAssignmentDelivery';
import { ExternalAssignmentDeliveryPanel } from './ExternalAssignmentDeliveryPanel';
import { independentDispatchDirectory, type IndependentDirectory } from '@/lib/independentDispatchDirectory';
import { SECTOR_FIELDS, sectorLabel, type IndependentSector } from '@/lib/independentDispatchSectors';
import { dialpadCallHref } from '@/lib/dialpad';
import { parsePastedJobRequest, type ParsedJobRequest } from '@/lib/independentRequestParser';

const EMPTY: IndependentJobDetails = { title: '', customer: '', reference: '', pickup: '', destination: '', cargo: '', scheduledAt: '', notes: '' };
const STATUS: Record<IndependentJobStatus, string> = { unassigned: 'Unassigned', assigned: 'Assigned', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const FIELDS = [
  ['title', 'Job name', 180, true],
  ['reference', 'Customer reference / load number', 120, false],
  ['pickup', 'Pickup address / location', 500, true], ['destination', 'Delivery address / location', 500, true],
  ['cargo', 'Cargo / equipment / quantity', 500, false], ['notes', 'Instructions', 4000, false],
] as const;
const inputClass = 'w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white';
const buttonClass = 'rounded bg-blue-700 px-3 py-2 text-sm text-white disabled:opacity-40';

function JobDialpadLinks({ job, directory, drivers }: { job: IndependentJob; directory: IndependentDirectory | null; drivers: ExternalDriver[] }) {
  const customer = directory?.customers.find(item => item.id === job.customerId);
  const driver = drivers.find(item => item.externalDriverId === job.externalDriverId);
  const customerHref = dialpadCallHref(customer?.phoneE164, job.id);
  const driverHref = dialpadCallHref(driver?.phoneE164, job.id);
  if (!customerHref && !driverHref) return null;
  return <div className="mt-2 flex flex-wrap gap-3 text-sm text-cyan-300 underline">
    {customerHref && <a href={customerHref}>Call customer in Dialpad</a>}
    {driverHref && <a href={driverHref}>Call driver in Dialpad</a>}
  </div>;
}

export function IndependentDispatchBoard({ companyId, canWrite, canManageDrivers }: {
  companyId: string; canWrite: boolean; canManageDrivers: boolean;
}) {
  const [jobs, setJobs] = useState<IndependentJob[]>([]);
  const [drivers, setDrivers] = useState<ExternalDriver[]>([]);
  const [wbDrivers, setWbDrivers] = useState<LinkedWellBuiltDriver[]>([]);
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
  const [directory, setDirectory] = useState<IndependentDirectory | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [sector, setSector] = useState<IndependentSector | ''>('');
  const [sectorFields, setSectorFields] = useState<Record<string, string>>({});
  const [pastedRequest, setPastedRequest] = useState('');
  const [parseReport, setParseReport] = useState<ParsedJobRequest | null>(null);
  // Keep create identity through an ambiguous network failure, avoiding duplicate jobs.
  const creation = useRef({ jobId: crypto.randomUUID(), requestId: crypto.randomUUID() });
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
    setForm(EMPTY); setEditing(null); setScheduledLocal(''); setCustomerId(''); setSector(''); setSectorFields({});
    setPastedRequest(''); setParseReport(null);
    creation.current = { jobId: crypto.randomUUID(), requestId: crypto.randomUUID() };
  }
  function edit(job: IndependentJob) {
    setEditing(job);
    setForm(Object.fromEntries(Object.keys(EMPTY).map(k => [k, job[k as keyof IndependentJobDetails]])) as IndependentJobDetails);
    setCustomerId(job.customerId || ''); setSector((job.sector as IndependentSector) || ''); setSectorFields(job.sectorFields || {});
    const date = job.scheduledAt ? new Date(job.scheduledAt) : null;
    setScheduledLocal(date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
    document.getElementById('independent-job-form')?.scrollIntoView({ behavior: 'smooth' });
  }
  const visible = jobs.filter(job => (filter === 'all' || (filter === 'active' ? !['completed', 'cancelled'].includes(job.status) : filter === job.status))
    && [job.title, job.customer, job.reference, job.pickup, job.destination, job.driverName].join(' ').toLowerCase().includes(search.toLowerCase()));
  const selectedCustomer = directory?.customers.find(customer => customer.id === customerId);
  const availableSectors = (selectedCustomer?.sectors || []).filter(id => directory?.sectors.includes(id));
  function fillFromRequest() {
    if (!directory || !pastedRequest.trim() || editing) return;
    const result = parsePastedJobRequest(pastedRequest, directory);
    const customer = directory.customers.find(item => item.id === result.customerId);
    setCustomerId(result.customerId);
    setSector(customer ? result.sector : '');
    setSectorFields(customer ? result.sectorFields : {});
    setScheduledLocal(result.scheduledLocal);
    setForm({ ...EMPTY, ...result.fields, customer: customer?.name || '' });
    setParseReport(result);
    document.getElementById('independent-job-form')?.scrollIntoView({ behavior: 'smooth' });
  }
  return <div className="space-y-4">
    <p className="text-sm text-gray-300">Create customer jobs with sector-specific details, assign outside or linked WellBuilt drivers, and record progress. Assigning a WellBuilt driver here does not send a job to their phone app yet.</p>
    {error && <div role="alert" className="rounded border border-red-700 bg-red-950 p-3 text-red-200">{error}</div>}
    {notice && <p role="status" className="text-green-300">{notice}</p>}
    {canManageDrivers && <ExternalAssignmentDeliveryPanel jobs={[]} canManage={canWrite && canManageDrivers} rosterOnly onRosterChange={refresh} />}
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
        {parseReport.missing.length > 0 && <p className="text-amber-200">Still needed: {parseReport.missing.join(', ')}.</p>}
        {parseReport.warnings.map(warning => <p key={warning} className="text-amber-200">{warning}</p>)}
      </div>}
    </section>}
    {canWrite && <form id="independent-job-form" className="rounded border border-gray-700 bg-gray-800 p-4" onSubmit={event => {
      event.preventDefault();
      const job = { ...form, scheduledAt: scheduledLocal ? new Date(scheduledLocal).toISOString() : '',
        ...(sector && customerId ? { customerId, sector, sectorFields } : {}) };
      void run({ op: editing ? 'update' : 'create', jobId: editing?.id || creation.current.jobId,
        requestId: editing ? crypto.randomUUID() : creation.current.requestId,
        ...(editing ? { expectedRevision: editing.revision } : {}), job }, resetForm);
    }}>
      <h2 className="mb-3 font-semibold text-cyan-300">{editing ? 'Edit job' : 'New Independent Dispatch job'}</h2>
      <fieldset disabled={busy || !loaded} className="grid gap-3 md:grid-cols-2">
        {(!editing || editing.sector) ? <>
          <label className="text-xs text-gray-300">Customer *<select aria-label="Customer" required value={customerId} className={inputClass} onChange={event => {
            const next = directory?.customers.find(customer => customer.id === event.target.value);
            const retainParsed = !!parseReport && !customerId;
            setCustomerId(next?.id || ''); setForm(current => ({ ...current, customer: next?.name || '',
              ...(retainParsed ? {} : { title: '', pickup: '', destination: '' }) }));
            const choices = (next?.sectors || []).filter(id => directory?.sectors.includes(id));
            const parsedSector = retainParsed ? parseReport?.sector : '';
            const nextSector = parsedSector && choices.includes(parsedSector) ? parsedSector : choices.length === 1 ? choices[0] : '';
            setSector(nextSector);
            setSectorFields(retainParsed && nextSector === parsedSector ? parseReport?.sectorFields || {} : {});
          }}><option value="">Choose customer…</option>{directory?.customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
          <label className="text-xs text-gray-300">Transportation sector *<select aria-label="Transportation sector" required value={sector} className={inputClass} onChange={event => { setSector(event.target.value as IndependentSector); setSectorFields({}); }}>
            <option value="">{availableSectors.length ? 'Choose sector…' : 'Choose a customer first…'}</option>
            {availableSectors.map(id => <option key={id} value={id}>{sectorLabel(id)}</option>)}
          </select></label>
        </> : <label className="text-xs text-gray-300">Customer *<input required maxLength={180} value={form.customer} onChange={event => setForm({ ...form, customer: event.target.value })} className={inputClass} /></label>}
        {!directory?.customers.length && <p className="text-sm text-amber-200 md:col-span-2">Add a customer in <a href="/settings" className="underline">Independent Dispatch settings</a> before creating a sector job.</p>}
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
        <div className="flex items-end gap-2"><button disabled={!editing && (!customerId || !sector)} className={buttonClass}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create job'}</button>
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
      <p className="text-sm text-gray-300">{job.customer}{job.sector ? ` · ${sectorLabel(job.sector)}` : ''}{job.reference ? ` · ${job.reference}` : ''}</p>
      <JobDialpadLinks job={job} directory={directory} drivers={drivers} />
      <dl className="mt-2 grid gap-2 text-sm md:grid-cols-2"><div><dt className="text-gray-400">Pickup</dt><dd className="whitespace-pre-wrap break-words text-white">{job.pickup}</dd></div><div><dt className="text-gray-400">Delivery</dt><dd className="whitespace-pre-wrap break-words text-white">{job.destination}</dd></div></dl>
      {job.cargo && <p className="mt-2 whitespace-pre-wrap text-sm text-gray-300">Cargo: {job.cargo}</p>}
      {job.sector && job.sectorFields && <dl className="mt-2 grid gap-1 text-xs text-gray-300 md:grid-cols-2">{SECTOR_FIELDS[job.sector as IndependentSector]?.map(field => job.sectorFields?.[field.key] ? <div key={field.key}><dt className="inline text-gray-400">{field.label}: </dt><dd className="inline">{job.sectorFields[field.key]}</dd></div> : null)}</dl>}
      {job.scheduledAt && <p className="text-sm text-gray-300">Scheduled: {new Date(job.scheduledAt).toLocaleString()}</p>}
      {job.notes && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-300">{job.notes}</p>}
      <p className="mt-2 text-sm text-amber-200">Driver: {job.driverName || 'Not assigned'}{job.driverSource === 'wellbuilt' ? ' · WellBuilt account' : ''}</p>
      {canWrite && <div className="mt-3 flex flex-wrap gap-2">
        {['unassigned', 'assigned'].includes(job.status) && <>
          <button className={buttonClass} disabled={busy} onClick={() => edit(job)}>Edit</button>
          {canManageDrivers && <><select aria-label={`Driver for ${job.title}`} className={inputClass + ' !w-auto'} value={assignments[job.id] || ''} onChange={e => setAssignments({ ...assignments, [job.id]: e.target.value })}>
            <option value="">Choose driver…</option>
            <optgroup label="Drivers without WellBuilt accounts">{drivers.filter(d => d.active).map(d => <option key={d.externalDriverId} value={`outside:${d.externalDriverId}`}>{d.displayName}</option>)}</optgroup>
            <optgroup label="Linked WellBuilt accounts">{wbDrivers.map(d => <option key={d.driverId} value={`wellbuilt:${d.driverId}`}>{d.displayName}</option>)}</optgroup>
          </select>
          <button disabled={busy || !assignments[job.id]} className={buttonClass} onClick={() => {
            const [kind, id] = (assignments[job.id] || '').split(':');
            if (!id) return;
            void run({ op: 'assign', jobId: job.id, expectedRevision: job.revision, requestId: crypto.randomUUID(),
              ...(kind === 'wellbuilt' ? { wbDriverId: id } : { externalDriverId: id }) });
          }}>{job.externalDriverId || job.wbDriverId ? 'Reassign' : 'Assign'}</button></>}
        </>}
        {(job.status === 'assigned' || job.status === 'in_progress') && <button disabled={busy} className={buttonClass} onClick={() => void run({ op: 'status', jobId: job.id, expectedRevision: job.revision, requestId: crypto.randomUUID(), status: job.status === 'assigned' ? 'in_progress' : 'completed' })}>{job.status === 'assigned' ? 'Mark started' : 'Mark completed'}</button>}
        {!['completed', 'cancelled'].includes(job.status) && <button disabled={busy} className="rounded border border-red-700 px-3 py-2 text-sm text-red-300" onClick={() => { if (window.confirm(`Cancel ${job.title}? Its history will be retained.`)) void run({ op: 'status', jobId: job.id, expectedRevision: job.revision, requestId: crypto.randomUUID(), status: 'cancelled' }); }}>Cancel job</button>}
      </div>}
      <p className="mt-2 text-xs text-gray-500">Progress recorded by dispatch staff · last updated {new Date(job.updatedAt).toLocaleString()}</p>
    </article>)}
  </div>;
}
