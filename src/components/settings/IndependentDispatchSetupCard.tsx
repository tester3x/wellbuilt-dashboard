'use client';
import { useEffect, useState } from 'react';
import { independentDispatchDirectory, type IndependentCustomer, type IndependentDirectory } from '@/lib/independentDispatchDirectory';
import { INDEPENDENT_SECTORS, type IndependentSector } from '@/lib/independentDispatchSectors';

const lines = (value: string) => [...new Set(value.split(/\r?\n/).map(item => item.trim()).filter(Boolean))];
const join = (value: string[] | undefined) => (value || []).join('\n');

export function IndependentDispatchSetupCard({ companyId, canEdit }: { companyId: string; canEdit: boolean }) {
  const [directory, setDirectory] = useState<IndependentDirectory | null>(null);
  const [sectors, setSectors] = useState<IndependentSector[]>([]);
  const [communicationChannels, setCommunicationChannels] = useState<('sms' | 'whatsapp')[]>([]);
  const [dispatchPhoneE164, setDispatchPhoneE164] = useState('');
  const [editingId, setEditingId] = useState('');
  const [name, setName] = useState('');
  const [phoneE164, setPhoneE164] = useState('');
  const [customerSectors, setCustomerSectors] = useState<IndependentSector[]>([]);
  const [jobNames, setJobNames] = useState('');
  const [pickups, setPickups] = useState('');
  const [deliveries, setDeliveries] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function refresh() {
    const result = await independentDispatchDirectory({ op: 'list' });
    if (result.companyId !== companyId) throw Error('Company scope changed.');
    setDirectory(result); setSectors(result.sectors); setCommunicationChannels(result.communicationChannels || []);
    setDispatchPhoneE164(result.dispatchPhoneE164 || '');
  }
  useEffect(() => { void refresh().catch(error => setMessage(error instanceof Error ? error.message : 'Unable to load setup.')); }, [companyId]);
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setMessage('');
    try { await action(); await refresh(); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to save.'); }
    finally { setBusy(false); }
  }
  function edit(customer?: IndependentCustomer) {
    setEditingId(customer?.id || ''); setName(customer?.name || ''); setPhoneE164(customer?.phoneE164 || '');
    setCustomerSectors(customer?.sectors || []); setJobNames(join(customer?.jobNames));
    setPickups(join(customer?.pickupLocations)); setDeliveries(join(customer?.deliveryLocations));
  }
  return <section className="rounded-lg border border-cyan-700/40 bg-gray-800 p-4 text-white">
    <h3 className="font-semibold text-cyan-300">Independent Dispatch setup</h3>
    <p className="mt-1 text-xs text-gray-400">Choose the work your company dispatches, then save each customer’s workflows and reusable job names and locations.</p>
    {message && <p role="status" className="mt-2 text-sm text-amber-200">{message}</p>}
    {!directory ? <p className="mt-3 text-sm text-gray-400">Loading setup…</p> : <>
      <fieldset disabled={!canEdit || busy} className="mt-4">
        <legend className="text-sm font-medium">Transportation sectors</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">{INDEPENDENT_SECTORS.map(sector => <label key={sector.id} className="rounded border border-gray-700 p-2 text-sm">
          <input type="checkbox" className="mr-2" checked={sectors.includes(sector.id)} onChange={event => setSectors(current => event.target.checked
            ? [...current, sector.id] : current.filter(id => id !== sector.id))} />{sector.label}
          <span className="block pl-6 text-xs text-gray-400">{sector.description}</span>
        </label>)}</div>
        <button type="button" disabled={!sectors.length || busy} className="mt-2 rounded bg-cyan-700 px-3 py-1.5 text-sm disabled:opacity-40"
          onClick={() => void run(() => independentDispatchDirectory({ op: 'setSectors', sectors }), 'Sectors saved.')}>Save sectors</button>
      </fieldset>
      <fieldset disabled={!canEdit || busy} className="mt-6 border-t border-gray-700 pt-4">
        <legend className="text-sm font-medium">Dispatch communications</legend>
        <p className="mt-1 text-xs text-gray-400">Set the shared dispatch number and channels your company plans to use. The caller ID works only for Dialpad users permitted to place calls from that number. Saving channels does not send messages.</p>
        <label className="mt-2 block text-xs text-gray-300">Shared Dialpad dispatch number (optional, +country code)
          <input type="tel" pattern="\+[1-9][0-9]{7,14}" value={dispatchPhoneE164} onChange={event => setDispatchPhoneE164(event.target.value)}
            placeholder="+15551234567" className="mt-1 block w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" />
        </label>
        <p className="mt-2 text-xs text-gray-400">Planned message channels; Dialpad SMS and WhatsApp delivery are not connected yet.</p>
        <div className="mt-2 flex flex-wrap gap-4 text-sm">{(['sms', 'whatsapp'] as const).map(channel => <label key={channel}>
          <input type="checkbox" className="mr-2" checked={communicationChannels.includes(channel)} onChange={event => setCommunicationChannels(current => event.target.checked
            ? [...current, channel] : current.filter(value => value !== channel))} />{channel === 'sms' ? 'SMS' : 'WhatsApp'}
        </label>)}</div>
        <button type="button" disabled={busy || (!!dispatchPhoneE164 && !/^\+[1-9]\d{7,14}$/.test(dispatchPhoneE164))} className="mt-2 rounded bg-cyan-700 px-3 py-1.5 text-sm disabled:opacity-40"
          onClick={() => void run(() => independentDispatchDirectory({ op: 'setCommunications', communicationChannels, dispatchPhoneE164 }), 'Dispatch communications saved.')}>Save dispatch communications</button>
      </fieldset>
      <div className="mt-6 border-t border-gray-700 pt-4">
        <div className="flex items-center justify-between"><h4 className="font-medium">Customers ({directory.customers.length})</h4>
          {canEdit && <button type="button" className="text-sm text-cyan-300" onClick={() => edit()}>New customer</button>}</div>
        {directory.customers.map(customer => <button type="button" key={customer.id} onClick={() => edit(customer)}
          className="mt-2 block w-full rounded border border-gray-700 p-2 text-left text-sm hover:border-cyan-500">
          {customer.name}<span className="ml-2 text-xs text-gray-400">{customer.sectors.map(id => INDEPENDENT_SECTORS.find(s => s.id === id)?.label || id).join(', ')}</span>
        </button>)}
        {canEdit && <form className="mt-4 grid gap-3" onSubmit={event => { event.preventDefault();
          const id = editingId || crypto.randomUUID();
          void run(() => independentDispatchDirectory({ op: 'saveCustomer', customer: {
            id, name, phoneE164: phoneE164.trim(), sectors: customerSectors, jobNames: lines(jobNames), pickupLocations: lines(pickups),
            deliveryLocations: lines(deliveries), active: true,
          } }), 'Customer saved.').then(() => setEditingId(id));
        }}>
          <h5 className="text-sm font-medium">{editingId ? 'Edit customer' : 'Add customer'}</h5>
          <label className="text-xs text-gray-300">Customer name<input required maxLength={180} value={name} onChange={e => setName(e.target.value)} className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" /></label>
          <label className="text-xs text-gray-300">Customer phone for Dialpad (optional, +country code)<input type="tel" pattern="\\+[1-9][0-9]{7,14}" value={phoneE164} onChange={e => setPhoneE164(e.target.value)} placeholder="+15551234567" className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" /></label>
          <fieldset><legend className="text-xs text-gray-300">Workflows for this customer</legend><div className="mt-1 flex flex-wrap gap-3 text-sm">
            {INDEPENDENT_SECTORS.filter(s => sectors.includes(s.id)).map(sector => <label key={sector.id}><input type="checkbox" checked={customerSectors.includes(sector.id)}
              onChange={event => setCustomerSectors(current => event.target.checked ? [...current, sector.id] : current.filter(id => id !== sector.id))} className="mr-1" />{sector.label}</label>)}
          </div></fieldset>
          <div className="grid gap-3 md:grid-cols-3">{[
            ['Saved job names', jobNames, setJobNames], ['Pickup locations', pickups, setPickups], ['Delivery locations', deliveries, setDeliveries],
          ].map(([label, value, setter]) => <label key={label as string} className="text-xs text-gray-300">{label as string} · one per line
            <textarea rows={4} value={value as string} onChange={e => (setter as (value: string) => void)(e.target.value)}
              className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" /></label>)}</div>
          <button disabled={busy || !name.trim() || !customerSectors.length} className="w-fit rounded bg-blue-700 px-3 py-2 text-sm disabled:opacity-40">Save customer</button>
        </form>}
      </div>
    </>}
  </section>;
}
