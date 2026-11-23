'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ExternalDriver } from '@/lib/externalAssignmentDelivery';
import type { LinkedWellBuiltDriver } from '@/lib/independentDispatchJobs';
import type { IndependentCustomer } from '@/lib/independentDispatchDirectory';
import { listIndependentDriverProfiles, saveIndependentDriverProfile,
  type IndependentDriverProfile, type IndependentDriverProfileInput } from '@/lib/independentDriverProfiles';

const inputClass = 'w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white';

export function IndependentDriverProfilesPanel({ drivers, wbDrivers, customers, initiallyOpen = false }: {
  drivers: ExternalDriver[]; wbDrivers: LinkedWellBuiltDriver[]; customers: IndependentCustomer[]; initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [profiles, setProfiles] = useState<IndependentDriverProfile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedKey, setSelectedKey] = useState('');
  const [form, setForm] = useState<IndependentDriverProfileInput | null>(null);
  const [addCustomerId, setAddCustomerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const roster = useMemo(() => [
    ...drivers.map(driver => ({ key: `outside:${driver.externalDriverId}`, name: driver.displayName, active: driver.active })),
    ...wbDrivers.map(driver => ({ key: `wellbuilt:${driver.driverId}`, name: driver.displayName, active: driver.active })),
  ].sort((a, b) => a.name.localeCompare(b.name)), [drivers, wbDrivers]);
  useEffect(() => {
    if (!open) return;
    void listIndependentDriverProfiles().then(next => { setProfiles(next); setLoaded(true); })
      .catch(error => setMessage(error instanceof Error ? error.message : 'Unable to load driver profiles.'));
  }, [open]);
  const selected = roster.find(driver => driver.key === selectedKey);
  const savedProfile = profiles.find(profile => profile.driverKey === selectedKey);
  return <section className="rounded-lg border border-cyan-800 bg-gray-800 p-4">
    <button type="button" aria-expanded={open} onClick={() => { setOpen(value => !value); setSelectedKey(''); setForm(null); setLoaded(false); }}
      className="flex w-full items-center justify-between gap-3 text-left">
      <span><span className="block font-semibold text-cyan-300">Independent Dispatch driver profiles</span>
        <span className="text-xs text-gray-400">Standing work and operator review notes for outside and linked drivers</span></span>
      <span aria-hidden="true" className="text-cyan-300">{open ? '▾' : '▸'}</span>
    </button>
    {open && <div className="mt-3 space-y-3">
      <p className="text-xs text-gray-300">These notes help dispatch plan work. Pending review does not block a driver, change operator eligibility, or notify management. Confirm route timing before assigning a side job.</p>
      {message && <p role="status" className="rounded bg-gray-900 p-2 text-sm text-gray-200">{message}</p>}
      <label className="block text-xs text-gray-300">Driver
        <select aria-label="Driver profile" className={inputClass} disabled={!loaded} value={selectedKey} onChange={event => {
          const key = event.target.value;
          const saved = profiles.find(profile => profile.driverKey === key);
          setSelectedKey(key); setMessage('');
          setForm(!key ? null : saved ? { driverKey: saved.driverKey, primaryCustomerId: saved.primaryCustomerId,
            standingWork: saved.standingWork, sideJobs: saved.sideJobs, shiftPreference: saved.shiftPreference || 'unset', operatorNotes: saved.operatorNotes }
            : { driverKey: key, primaryCustomerId: '', standingWork: '', sideJobs: 'ask', shiftPreference: 'unset', operatorNotes: [] });
        }}>
          <option value="">Choose driver…</option>
          {roster.map(driver => <option key={driver.key} value={driver.key}>{driver.name} · {driver.key.startsWith('wellbuilt:') ? 'WellBuilt' : 'outside'}{driver.active ? '' : ' · inactive'}</option>)}
        </select>
      </label>
      {form && selected && <form className="space-y-3 rounded border border-gray-700 p-3" onSubmit={event => {
        event.preventDefault(); setBusy(true); setMessage('');
        void saveIndependentDriverProfile(form, savedProfile?.revision || 0).then(saved => {
          setProfiles(current => [...current.filter(profile => profile.driverKey !== saved.driverKey), saved]);
          setMessage('Driver profile saved. Operator review notes remain nonbinding.');
        }).catch(error => setMessage(error instanceof Error ? error.message : 'Unable to save driver profile.'))
          .finally(() => setBusy(false));
      }}>
        <h3 className="font-medium text-white">{selected.name}</h3>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-xs text-gray-300">Primary customer / operator
            <select aria-label="Primary customer" className={inputClass} value={form.primaryCustomerId}
              onChange={event => setForm({ ...form, primaryCustomerId: event.target.value })}>
              <option value="">None recorded</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-300">Side jobs
            <select aria-label="Side jobs" className={inputClass} value={form.sideJobs}
              onChange={event => setForm({ ...form, sideJobs: event.target.value as IndependentDriverProfileInput['sideJobs'] })}>
              <option value="ask">Check with dispatch</option><option value="yes">Can take side jobs when they fit</option><option value="no">Standing work only</option>
            </select>
          </label>
          {selected.key.startsWith('wellbuilt:') && <label className="text-xs text-gray-300">Usual shift
            <select aria-label="Usual shift" className={inputClass} value={form.shiftPreference || 'unset'}
              onChange={event => setForm({ ...form, shiftPreference: event.target.value as IndependentDriverProfileInput['shiftPreference'] })}>
              <option value="unset">Not set</option><option value="day">Day</option><option value="night">Night</option><option value="either">Either</option>
            </select>
          </label>}
        </div>
        <label className="block text-xs text-gray-300">Standing route or customer work
          <textarea aria-label="Standing work" className={inputClass} rows={2} maxLength={1000} value={form.standingWork}
            onChange={event => setForm({ ...form, standingWork: event.target.value })}
            placeholder="Describe the work that stays with this driver. Add timing when known." />
        </label>
        <div className="space-y-2 border-t border-gray-700 pt-3">
          <h4 className="text-sm font-medium text-cyan-200">Operator review notes</h4>
          {form.operatorNotes.map((note, index) => <div key={note.customerId} className="rounded border border-gray-700 bg-gray-900/50 p-3">
            <div className="flex justify-between gap-2 text-sm text-white"><span>{customers.find(customer => customer.id === note.customerId)?.name || note.customerId}</span>
              <button type="button" className="text-xs text-gray-300 underline" onClick={() => setForm({ ...form, operatorNotes: form.operatorNotes.filter((_, i) => i !== index) })}>Remove note</button></div>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <label className="text-xs text-gray-300">Dispatch observation<textarea aria-label={`Dispatch observation for ${note.customerId}`} maxLength={1000} rows={2} className={inputClass} value={note.dispatchNote}
                onChange={event => setForm({ ...form, operatorNotes: form.operatorNotes.map((item, i) => i === index ? { ...item, dispatchNote: event.target.value } : item) })} /></label>
              <label className="text-xs text-gray-300">Operator feedback<textarea aria-label={`Operator feedback for ${note.customerId}`} maxLength={1000} rows={2} className={inputClass} value={note.operatorFeedback}
                onChange={event => setForm({ ...form, operatorNotes: form.operatorNotes.map((item, i) => i === index ? { ...item, operatorFeedback: event.target.value } : item) })} /></label>
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs text-amber-200"><input type="checkbox" checked={note.reviewPending}
              onChange={event => setForm({ ...form, operatorNotes: form.operatorNotes.map((item, i) => i === index ? { ...item, reviewPending: event.target.checked } : item) })} />Mark for management review</label>
          </div>)}
          <div className="flex flex-wrap items-end gap-2"><label className="min-w-44 flex-1 text-xs text-gray-300">Add customer / operator
            <select aria-label="Operator for review note" className={inputClass} value={addCustomerId} onChange={event => setAddCustomerId(event.target.value)}>
              <option value="">Choose…</option>{customers.filter(customer => !form.operatorNotes.some(note => note.customerId === customer.id)).map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
            </select></label>
            <button type="button" disabled={!addCustomerId || form.operatorNotes.length >= 20} className="rounded bg-gray-700 px-3 py-2 text-sm text-white disabled:opacity-40" onClick={() => {
              setForm({ ...form, operatorNotes: [...form.operatorNotes, { customerId: addCustomerId, dispatchNote: '', operatorFeedback: '', reviewPending: false }] });
              setAddCustomerId('');
            }}>Add note</button></div>
        </div>
        <button disabled={busy} className="rounded bg-blue-700 px-3 py-2 text-sm text-white disabled:opacity-40">{busy ? 'Saving…' : 'Save driver profile'}</button>
      </form>}
    </div>}
  </section>;
}
