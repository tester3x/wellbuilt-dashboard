'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ExternalDriver } from '@/lib/externalAssignmentDelivery';
import { saveExternalDriver } from '@/lib/externalAssignmentDelivery';
import type { LinkedWellBuiltDriver } from '@/lib/independentDispatchJobs';
import type { IndependentCustomer } from '@/lib/independentDispatchDirectory';
import { listIndependentDriverProfiles, saveIndependentDriverProfile,
  type IndependentDriverProfile, type IndependentDriverProfileInput } from '@/lib/independentDriverProfiles';

const inputClass = 'w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white';

export function IndependentDriverProfilesPanel({ drivers, wbDrivers, customers, initiallyOpen = false, onRosterChange }: {
  drivers: ExternalDriver[]; wbDrivers: LinkedWellBuiltDriver[]; customers: IndependentCustomer[]; initiallyOpen?: boolean;
  onRosterChange?: (drivers: ExternalDriver[]) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [profiles, setProfiles] = useState<IndependentDriverProfile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedKey, setSelectedKey] = useState('');
  const [hasWellBuiltAccount, setHasWellBuiltAccount] = useState(false);
  const [outsideDraft, setOutsideDraft] = useState({ name: '', active: true, shiftPreference: 'unset' as ExternalDriver['shiftPreference'] });
  const [form, setForm] = useState<IndependentDriverProfileInput | null>(null);
  const [addCustomerId, setAddCustomerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const roster = useMemo(() => [
    ...drivers.map(driver => ({ key: `outside:${driver.externalDriverId}`, name: driver.displayName, phoneE164: driver.phoneE164, active: driver.active })),
    ...wbDrivers.map(driver => ({ key: `wellbuilt:${driver.driverId}`, name: driver.displayName, phoneE164: '', active: driver.active })),
  ].sort((a, b) => a.name.localeCompare(b.name)), [drivers, wbDrivers]);
  useEffect(() => {
    if (!open) return;
    void listIndependentDriverProfiles().then(next => { setProfiles(next); setLoaded(true); })
      .catch(error => setMessage(error instanceof Error ? error.message : 'Unable to load driver profiles.'));
  }, [open]);
  const selected = roster.find(driver => driver.key === selectedKey);
  const savedProfile = profiles.find(profile => profile.driverKey === selectedKey);
  const isNewOutside = !!form && selectedKey.startsWith('outside:') && !selected;
  function chooseDriver(key: string) {
    const saved = profiles.find(profile => profile.driverKey === key);
    const rosterDriver = roster.find(driver => driver.key === key);
    const outside = drivers.find(driver => `outside:${driver.externalDriverId}` === key);
    setSelectedKey(key); setMessage('');
    setOutsideDraft({ name: outside?.displayName || '', active: outside?.active ?? true, shiftPreference: outside?.shiftPreference || 'unset' });
    setForm(!key ? null : saved ? { driverKey: saved.driverKey, phoneE164: saved.phoneE164 ?? rosterDriver?.phoneE164 ?? '',
      whatsappName: saved.whatsappName ?? '', primaryCustomerId: saved.primaryCustomerId,
      standingWork: saved.standingWork, sideJobs: saved.sideJobs, shiftPreference: outside?.shiftPreference || saved.shiftPreference || 'unset', operatorNotes: saved.operatorNotes }
      : { driverKey: key, phoneE164: rosterDriver?.phoneE164 || '', whatsappName: '', primaryCustomerId: '', standingWork: '', sideJobs: 'ask', shiftPreference: outside?.shiftPreference || 'unset', operatorNotes: [] });
  }
  function addOutsideDriver() {
    const key = `outside:${crypto.randomUUID()}`;
    chooseDriver(key);
  }
  return <section className="rounded-lg border border-cyan-800 bg-gray-800 p-4">
    <button type="button" aria-expanded={open} onClick={() => { setOpen(value => !value); setSelectedKey(''); setForm(null); setLoaded(false); }}
      className="flex w-full items-center justify-between gap-3 text-left">
      <span><span className="block font-semibold text-cyan-300">Independent Dispatch drivers</span>
        <span className="text-xs text-gray-400">One profile for contacts, shift preference, standing work, and operator notes</span></span>
      <span aria-hidden="true" className="text-cyan-300">{open ? '▾' : '▸'}</span>
    </button>
    {open && <div className="mt-3 space-y-3">
      <p className="text-xs text-gray-300">These notes help dispatch plan work. Pending review does not block a driver, change operator eligibility, or notify management. Confirm route timing before assigning a side job.</p>
      {message && <p role="status" className="rounded bg-gray-900 p-2 text-sm text-gray-200">{message}</p>}
      <label className="flex items-center gap-2 text-sm text-gray-200"><input type="checkbox" checked={hasWellBuiltAccount} onChange={event => {
        setHasWellBuiltAccount(event.target.checked); chooseDriver('');
      }} />Has a WellBuilt account</label>
      {hasWellBuiltAccount && wbDrivers.length === 0 && <p className="text-xs text-amber-200">No linked WellBuilt drivers are available for this dispatch company yet.</p>}
      <div className="flex flex-wrap items-end gap-2"><label className="min-w-52 flex-1 text-xs text-gray-300">Driver
        <select aria-label="Driver profile" className={inputClass} disabled={!loaded} value={selectedKey} onChange={event => chooseDriver(event.target.value)}>
          <option value="">Choose driver…</option>
          {roster.filter(driver => driver.key.startsWith(hasWellBuiltAccount ? 'wellbuilt:' : 'outside:')).map(driver =>
            <option key={driver.key} value={driver.key}>{driver.name}{driver.active ? '' : ' · inactive'}</option>)}
          {isNewOutside && <option value={selectedKey}>{outsideDraft.name || 'New outside driver'}</option>}
        </select>
      </label>{!hasWellBuiltAccount && <button type="button" disabled={!loaded} className="rounded bg-amber-700 px-3 py-2 text-sm text-white disabled:opacity-40" onClick={addOutsideDriver}>Add outside driver</button>}</div>
      {form && (selected || isNewOutside) && <form className="space-y-3 rounded border border-gray-700 p-3" onSubmit={event => {
        event.preventDefault(); setBusy(true); setMessage('');
        void (async () => {
          if (selectedKey.startsWith('outside:')) {
            const existing = drivers.find(driver => `outside:${driver.externalDriverId}` === selectedKey);
            if (!existing || existing.displayName !== outsideDraft.name.trim() || existing.active !== outsideDraft.active
              || (existing.shiftPreference || 'unset') !== outsideDraft.shiftPreference) {
              const savedDriver = await saveExternalDriver({ externalDriverId: selectedKey.slice(8), displayName: outsideDraft.name.trim(),
                phoneE164: existing?.phoneE164 || '', channels: existing?.channels || [], active: outsideDraft.active,
                shiftPreference: outsideDraft.shiftPreference });
              onRosterChange?.([...drivers.filter(driver => driver.externalDriverId !== savedDriver.externalDriverId), savedDriver]);
            }
          }
          const saved = await saveIndependentDriverProfile(form, savedProfile?.revision || 0);
          setProfiles(current => [...current.filter(profile => profile.driverKey !== saved.driverKey), saved]);
          setMessage('Driver profile saved. Operator review notes remain nonbinding.');
        })().catch(error => setMessage(error instanceof Error ? error.message : 'Unable to save driver profile.'))
          .finally(() => setBusy(false));
      }}>
        <h3 className="font-medium text-white">{selected?.name || 'New outside driver'}</h3>
        {!hasWellBuiltAccount && <div className="grid gap-3 md:grid-cols-3">
          <label className="text-xs text-gray-300">Driver name<input aria-label="Driver name" required maxLength={120} className={inputClass} value={outsideDraft.name}
            onChange={event => setOutsideDraft({ ...outsideDraft, name: event.target.value })} /></label>
          <label className="text-xs text-gray-300">Usual shift<select aria-label="Usual shift" className={inputClass} value={outsideDraft.shiftPreference}
            onChange={event => { const shiftPreference = event.target.value as ExternalDriver['shiftPreference']; setOutsideDraft({ ...outsideDraft, shiftPreference }); setForm({ ...form, shiftPreference }); }}>
            <option value="unset">Not set</option><option value="day">Day</option><option value="night">Night</option><option value="either">Either</option>
          </select></label>
          <label className="flex items-center gap-2 text-xs text-gray-300"><input type="checkbox" checked={outsideDraft.active}
            onChange={event => setOutsideDraft({ ...outsideDraft, active: event.target.checked })} />Active for new assignments</label>
        </div>}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-xs text-gray-300">Driver phone (international format)
            <input aria-label="Driver phone (international format)" type="tel" autoComplete="tel" pattern="\+[1-9][0-9]{7,14}" title="Use + followed by country code and phone number, with no spaces" className={inputClass}
              placeholder="+17015550123" value={form.phoneE164 || ''}
              onChange={event => setForm({ ...form, phoneE164: event.target.value.trim() })} />
          </label>
          <label className="text-xs text-gray-300">WhatsApp name (optional)
            <input aria-label="WhatsApp name (optional)" className={inputClass} maxLength={80}
              placeholder="Name shown in WhatsApp" value={form.whatsappName || ''}
              onChange={event => setForm({ ...form, whatsappName: event.target.value })} />
          </label>
        </div>
        <p className="text-xs text-gray-400">The job card uses these contact details. Leave WhatsApp name blank to show the driver&apos;s roster name.</p>
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
          {hasWellBuiltAccount && <label className="text-xs text-gray-300">Usual shift
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
