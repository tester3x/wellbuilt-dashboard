'use client';

import type { Ticket } from '@/lib/tickets';

export function TicketReadOnlyDetail(input: { ticket: Ticket; onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ['Ticket #', input.ticket.ticketNumber],
    ['Date', input.ticket.date],
    ['Operator', input.ticket.operator || input.ticket.company],
    ['Pickup', input.ticket.location],
    ['Drop-off', input.ticket.hauledTo],
    ['Driver', input.ticket.driver],
    ['Truck', input.ticket.truck],
    ['Trailer', input.ticket.trailer],
    ['Pickup BBL', String(input.ticket.pickupBbls ?? input.ticket.qty)],
    ['Drop-off BBL', String(input.ticket.dropoffBbls ?? input.ticket.qty)],
    ['Top', input.ticket.top],
    ['Bottom', input.ticket.bottom],
  ];
  return (
    <div className="bg-[#FAFAF8] rounded-lg p-6 text-[#111]" data-paper-mode="read_only_detail">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">Read-only ticket detail</h2>
        <button type="button" className="text-sm text-gray-500" onClick={input.onClose}>Close</button>
      </div>
      <dl className="space-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between border-b border-gray-200 py-1 text-sm">
            <dt className="text-gray-500">{label}</dt>
            <dd>{value || '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
