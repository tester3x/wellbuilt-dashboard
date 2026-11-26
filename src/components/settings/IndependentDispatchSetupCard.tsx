'use client';
import { useEffect, useState } from 'react';
import { independentDispatchCatalog, independentDispatchDirectory, type IndependentCustomer, type IndependentCustomerCategory, type IndependentCustomerContact, type IndependentDirectory } from '@/lib/independentDispatchDirectory';
import { INDEPENDENT_SECTORS, type IndependentSector } from '@/lib/independentDispatchSectors';
import type { NdicOperator } from '@/lib/firestoreWells';

const lines = (value: string) => [...new Set(value.split(/\r?\n/).map(item => item.trim()).filter(Boolean))];
const join = (value: string[] | undefined) => (value || []).join('\n');
const normalizeName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const catalogSearchMatches = (name: string, query: string) => {
  const term = query.trim().toLowerCase();
  if (!term) return true;
  if (name.toLowerCase().includes(term)) return true;
  const legalName = name.toUpperCase();
  return (/^(chord|chorde|cord)( energy)?$/.test(term) && /OASIS|WHITING|ENERPLUS/.test(legalName))
    || (/^exxon(mobil)?$/.test(term) && legalName.includes('XTO'));
};

export function IndependentDispatchSetupCard({ companyId, canEdit }: { companyId: string; canEdit: boolean }) {
  const [directory, setDirectory] = useState<IndependentDirectory | null>(null);
  const [sectors, setSectors] = useState<IndependentSector[]>([]);
  const [communicationChannels, setCommunicationChannels] = useState<('sms' | 'whatsapp')[]>([]);
  const [dispatchPhoneE164, setDispatchPhoneE164] = useState('');
  const [catalogOperators, setCatalogOperators] = useState<string[]>([]);
  const [availableOperators, setAvailableOperators] = useState<NdicOperator[]>([]);
  const [operatorSearch, setOperatorSearch] = useState('');
  const [editingId, setEditingId] = useState('');
  const [name, setName] = useState('');
  const [alternateNames, setAlternateNames] = useState('');
  const [phoneE164, setPhoneE164] = useState('');
  const [contacts, setContacts] = useState<IndependentCustomerContact[]>([]);
  const [workCategories, setWorkCategories] = useState<IndependentCustomerCategory[]>([]);
  const [customerSectors, setCustomerSectors] = useState<IndependentSector[]>([]);
  const [jobNames, setJobNames] = useState('');
  const [pickups, setPickups] = useState('');
  const [deliveries, setDeliveries] = useState('');
  const [customerCatalogOperators, setCustomerCatalogOperators] = useState<string[]>([]);
  const [customerCatalogSearch, setCustomerCatalogSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function refresh() {
    const result = await independentDispatchDirectory({ op: 'list' });
    if (result.companyId !== companyId) throw Error('Company scope changed.');
    setDirectory(result); setSectors(result.sectors); setCommunicationChannels(result.communicationChannels || []);
    setDispatchPhoneE164(result.dispatchPhoneE164 || '');
    setCatalogOperators(result.catalogOperators || []);
  }
  useEffect(() => { void refresh().catch(error => setMessage(error instanceof Error ? error.message : 'Unable to load setup.')); }, [companyId]);
  useEffect(() => { void independentDispatchCatalog().then(result => setAvailableOperators(result.operators))
    .catch(() => setMessage('Well catalog unavailable; saved customer locations remain usable.')); }, []);
  async function run(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true); setMessage('');
    try { await action(); await refresh(); setMessage(success); return true; }
    catch (error) { const detail = error instanceof Error ? error.message : 'Unable to save.';
      setMessage(detail.includes('customer_name_conflict') ? 'That company name or alternate name is already used by another saved customer.'
        : detail.includes('duplicate_customer_name_or_alias') ? 'Remove a repeated company name or alternate name.' : detail); return false; }
    finally { setBusy(false); }
  }
  function edit(customer?: IndependentCustomer) {
    setEditingId(customer?.id || ''); setName(customer?.name || ''); setAlternateNames(join(customer?.alternateNames)); setPhoneE164(customer?.phoneE164 || '');
    setContacts(customer?.contacts || []);
    setWorkCategories(customer?.workCategories || []);
    setCustomerSectors(customer?.sectors || []); setJobNames(join(customer?.jobNames));
    setPickups(join(customer?.pickupLocations)); setDeliveries(join(customer?.deliveryLocations));
    setCustomerCatalogOperators(customer?.wellCatalogOperators || []); setCustomerCatalogSearch('');
  }
  const enteredAliases = lines(alternateNames);
  const enteredIdentifiers = [name, ...enteredAliases].map(normalizeName).filter(Boolean);
  const repeatedIdentifier = new Set(enteredIdentifiers).size !== enteredIdentifiers.length;
  const conflictingCustomers = directory?.customers.filter(customer => customer.id !== editingId
    && enteredIdentifiers.some(identifier => [customer.name, ...(customer.alternateNames || [])]
      .some(savedName => normalizeName(savedName) === identifier))) || [];
  function changeContact(id: string, patch: Partial<IndependentCustomerContact>) {
    setContacts(current => current.map(contact => contact.id === id ? { ...contact, ...patch } : contact));
  }
  function changeCategory(id: string, patch: Partial<IndependentCustomerCategory>) {
    setWorkCategories(current => current.map(category => category.id === id ? { ...category, ...patch } : category));
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
        <legend className="text-sm font-medium">NDIC well data sources</legend>
        <p className="mt-1 text-xs text-gray-400">These are registered well operators, not your dispatch customers. Search Chord to find its Oasis, Whiting, and Enerplus records, or ExxonMobil to find XTO. An empty list makes all sources available. Manage paying customers below.</p>
        <input aria-label="Find NDIC operator" value={operatorSearch} onChange={event => setOperatorSearch(event.target.value)} placeholder="Find NDIC operator, e.g. XTO"
          className="mt-2 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" />
        <div className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded border border-gray-700 p-2">
          {availableOperators.filter(operator => catalogSearchMatches(operator.name, operatorSearch))
            .map(operator => <label key={operator.name} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={catalogOperators.includes(operator.name)} onChange={event => setCatalogOperators(current => event.target.checked
                ? [...current, operator.name] : current.filter(name => name !== operator.name))} />{operator.name}{operator.state ? ` (${operator.state})` : ''}
            </label>)}
        </div>
        <p className="mt-1 text-xs text-gray-400">{catalogOperators.length ? `${catalogOperators.length} NDIC sources selected` : 'All NDIC sources available'}</p>
        <button type="button" disabled={busy || catalogOperators.length > 50 || !availableOperators.length} className="mt-2 rounded bg-cyan-700 px-3 py-1.5 text-sm disabled:opacity-40"
          onClick={() => void run(() => independentDispatchDirectory({ op: 'setCatalogOperators', catalogOperators }), 'NDIC source list saved.')}>Save NDIC source list</button>
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
            id, name, alternateNames: lines(alternateNames), phoneE164: phoneE164.trim(), contacts, sectors: customerSectors,
            wellCatalogOperators: customerCatalogOperators,
            workCategories: workCategories.map(category => ({ ...category, sourceChannels: lines(join(category.sourceChannels)), assets: lines(join(category.assets)) })),
            jobNames: lines(jobNames), pickupLocations: lines(pickups),
            deliveryLocations: lines(deliveries), active: true,
          } }), 'Customer saved.').then(saved => { if (saved) setEditingId(id); });
        }}>
          <h5 className="text-sm font-medium">{editingId ? 'Edit customer' : 'Add customer'}</h5>
          <label className="text-xs text-gray-300">Customer name<input required maxLength={180} value={name} onChange={e => setName(e.target.value)} className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" /></label>
          <label className="text-xs text-gray-300">Alternate names or abbreviations · one per line
            <textarea rows={3} value={alternateNames} onChange={e => setAlternateNames(e.target.value)} placeholder={"Bob's\nBHS"}
              className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" />
            <span className="mt-1 block text-gray-400">A unique alternate name fills this official company on pasted jobs. The customer picker and jobs show only the official name.</span>
            {repeatedIdentifier && <span className="mt-1 block text-amber-200">This profile repeats a company name or alternate name.</span>}
            {!!conflictingCustomers.length && <span className="mt-1 block text-amber-200">Name already used by {conflictingCustomers.map(customer => customer.name).join(', ')}. Keep it on only one customer.</span>}
          </label>
          <label className="text-xs text-gray-300">Customer phone for Dialpad (optional, +country code)<input type="tel" pattern="\\+[1-9][0-9]{7,14}" value={phoneE164} onChange={e => setPhoneE164(e.target.value)} placeholder="+15551234567" className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" /></label>
          <fieldset className="rounded border border-gray-700 p-3"><legend className="px-1 text-sm font-medium">Well data for this customer (optional)</legend>
            <p className="mb-2 text-xs text-gray-400">The customer is who requests and pays for the work. Add the NDIC operator whose wells they use: Tallgrass can use XTO wells while the job still names Tallgrass. Leave this empty for customers using only saved custom locations.</p>
            <div className="flex flex-wrap gap-2">{customerCatalogOperators.map(operator => <span key={operator} className="rounded border border-cyan-700 px-2 py-1 text-xs text-cyan-200">
              {operator} <button type="button" className="ml-2 text-red-200 underline" onClick={() => setCustomerCatalogOperators(current => current.filter(name => name !== operator))}>Remove</button>
            </span>)}</div>
            <input aria-label="Find NDIC wells for this customer" value={customerCatalogSearch} onChange={event => setCustomerCatalogSearch(event.target.value)} placeholder="Search NDIC operator, e.g. XTO"
              className="mt-2 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" />
            {customerCatalogSearch.trim() && <div className="mt-1 max-h-36 overflow-y-auto rounded border border-gray-700 p-1">
              {availableOperators.filter(operator => catalogSearchMatches(operator.name, customerCatalogSearch)
                && !customerCatalogOperators.includes(operator.name)).slice(0, 20).map(operator => <button key={operator.name} type="button"
                  disabled={customerCatalogOperators.length >= 10} onClick={() => { setCustomerCatalogOperators(current => [...current, operator.name]); setCustomerCatalogSearch(''); }}
                  className="block w-full p-1 text-left text-xs text-cyan-200 hover:bg-gray-700 disabled:opacity-40">Add {operator.name}{operator.state ? ` (${operator.state})` : ''}</button>)}
            </div>}
          </fieldset>
          <fieldset className="rounded border border-gray-700 p-3"><legend className="px-1 text-sm font-medium">Company men / job contacts</legend>
            <p className="mb-2 text-xs text-gray-400">Save everyone this customer may assign to a job. Choose the right person separately on each dispatch.</p>
            <div className="space-y-3">{contacts.map((contact, index) => <div key={contact.id} className="grid gap-2 rounded border border-gray-700 p-2 sm:grid-cols-3">
              <label className="text-xs text-gray-300">Contact name<input required maxLength={120} value={contact.name} onChange={event => changeContact(contact.id, { name: event.target.value })} className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" /></label>
              <label className="text-xs text-gray-300">Role / title<input maxLength={80} value={contact.role} onChange={event => changeContact(contact.id, { role: event.target.value })} placeholder="Company man, lead, boss…" className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" /></label>
              <label className="text-xs text-gray-300">Phone (+country code)<input type="tel" pattern="\+[1-9][0-9]{7,14}" value={contact.phoneE164} onChange={event => changeContact(contact.id, { phoneE164: event.target.value })} placeholder="+17015550123" className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" /></label>
              <button type="button" className="w-fit text-xs text-red-300 underline sm:col-span-3" onClick={() => setContacts(current => current.filter(item => item.id !== contact.id))}>Remove contact {index + 1}</button>
            </div>)}</div>
            <button type="button" disabled={contacts.length >= 30} className="mt-3 text-sm text-cyan-300 underline disabled:opacity-40" onClick={() => setContacts(current => [...current, { id: crypto.randomUUID(), name: '', role: 'Company man', phoneE164: '' }])}>Add job contact</button>
          </fieldset>
          <fieldset><legend className="text-xs text-gray-300">Workflows for this customer</legend><div className="mt-1 flex flex-wrap gap-3 text-sm">
            {INDEPENDENT_SECTORS.filter(s => sectors.includes(s.id)).map(sector => <label key={sector.id}><input type="checkbox" checked={customerSectors.includes(sector.id)}
              onChange={event => setCustomerSectors(current => event.target.checked ? [...current, sector.id] : current.filter(id => id !== sector.id))} className="mr-1" />{sector.label}</label>)}
          </div></fieldset>
          <fieldset className="rounded border border-gray-700 p-3"><legend className="px-1 text-sm font-medium">Customer work categories</legend>
            <p className="mb-2 text-xs text-gray-400">A customer may have several categories. Record the source chat name for reference; this does not connect or monitor the chat. Rigs and sites are reusable labels, while each job keeps its own locations.</p>
            <div className="space-y-3">{workCategories.map(category => <div key={category.id} className="grid gap-2 rounded border border-gray-600 p-3 sm:grid-cols-2">
              <label className="text-xs text-gray-300">Category name<input required maxLength={100} value={category.name} onChange={event => changeCategory(category.id, { name: event.target.value })} placeholder="Rig Work" className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" /></label>
              <label className="text-xs text-gray-300">Transportation sector<select required value={category.sector} onChange={event => changeCategory(category.id, { sector: event.target.value as IndependentSector })} className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white">
                <option value="">Choose sector…</option>{customerSectors.map(id => <option key={id} value={id}>{INDEPENDENT_SECTORS.find(sector => sector.id === id)?.label || id}</option>)}
              </select></label>
              <label className="text-xs text-gray-300">Source channels · one per line<textarea rows={3} value={join(category.sourceChannels)} onChange={event => changeCategory(category.id, { sourceChannels: event.target.value.split('\n') })} placeholder="ExxonMobil - RIG WORK" className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" /></label>
              <label className="text-xs text-gray-300">Rigs, sites, or assets · one per line<textarea rows={3} value={join(category.assets)} onChange={event => changeCategory(category.id, { assets: event.target.value.split('\n') })} placeholder={'H&P Rig 429\nH&P Rig 640'} className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" /></label>
              <button type="button" className="w-fit text-xs text-red-300 underline sm:col-span-2" onClick={() => setWorkCategories(current => current.filter(item => item.id !== category.id))}>Remove category</button>
            </div>)}</div>
            <button type="button" disabled={workCategories.length >= 20 || !customerSectors.length} className="mt-3 text-sm text-cyan-300 underline disabled:opacity-40" onClick={() => setWorkCategories(current => [...current, { id: crypto.randomUUID(), name: '', sector: customerSectors[0], sourceChannels: [], assets: [] }])}>Add category</button>
          </fieldset>
          <div className="grid gap-3 md:grid-cols-3">{[
            ['Saved job names', jobNames, setJobNames], ['Pickup locations', pickups, setPickups], ['Delivery locations', deliveries, setDeliveries],
          ].map(([label, value, setter]) => <label key={label as string} className="text-xs text-gray-300">{label as string} · one per line
            <textarea rows={4} value={value as string} onChange={e => (setter as (value: string) => void)(e.target.value)}
              className="mt-1 w-full rounded border border-gray-600 bg-gray-900 p-2 text-sm text-white" /></label>)}</div>
          <button disabled={busy || !name.trim() || !customerSectors.length || repeatedIdentifier || conflictingCustomers.length > 0} className="w-fit rounded bg-blue-700 px-3 py-2 text-sm disabled:opacity-40">Save customer</button>
        </form>}
      </div>
    </>}
  </section>;
}
