'use client';

import { useEffect, useState } from 'react';
import { FreshWaterPurchases } from './FreshWaterPurchases';
import { isFreshWaterJob } from '@/lib/freshWater';
import { fetchTickets, searchTicketsArchive, type Ticket } from '@/lib/tickets';

export function FreshWaterBilling({ companyId, canEdit }: { companyId: string; canEdit: boolean }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<Ticket>();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = search ? searchTicketsArchive(search, companyId, undefined, () => cancelled) : fetchTickets(200, companyId);
    load.then(rows => {
      if (!cancelled) setTickets(rows.filter(ticket => isFreshWaterJob(ticket.type)));
    }).catch(() => {
      if (!cancelled) setError('Could not load Fresh Water tickets.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [companyId, search]);

  return (
    <section className="space-y-3">
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
        event.preventDefault();
        const term = query.trim();
        if (term === search) return;
        setSelected(undefined);
        setLoading(true);
        setError('');
        setSearch(term);
      }}>
        <label className="text-sm text-gray-300">
          Find a Fresh Water ticket
          <input type="search" className="mt-1 block rounded border border-gray-600 bg-gray-800 p-2 text-white"
            value={query} onChange={event => setQuery(event.target.value)} placeholder="Ticket or invoice number" />
        </label>
        <button type="submit" className="rounded bg-blue-700 px-3 py-2 text-sm text-white">Search</button>
      </form>
      {loading ? <p className="text-gray-400">Loading Fresh Water tickets…</p> : error ? (
        <p className="text-red-300" role="alert">{error}</p>
      ) : (
        <label className="block max-w-lg text-sm text-gray-300">
          {search ? 'Matching tickets' : 'Fresh Water tickets from the 200 most recent tickets'}
          <select className="mt-1 block w-full rounded border border-gray-600 bg-gray-800 p-2 text-white"
            value={selected?.id ?? ''} onChange={event => setSelected(tickets.find(ticket => ticket.id === event.target.value))}>
            <option value="">{tickets.length ? 'Choose a ticket' : 'No Fresh Water tickets found'}</option>
            {tickets.map(ticket => (
              <option key={ticket.id} value={ticket.id}>
                {[ticket.ticketNumber || ticket.invoiceNumber, ticket.operator || ticket.company, ticket.location, ticket.date].filter(Boolean).join(' · ')}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && <FreshWaterPurchases key={selected.id} ticketId={selected.id} canEdit={canEdit && selected.status !== 'void'} />}
    </section>
  );
}
