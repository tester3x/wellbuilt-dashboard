'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { Ticket, fetchTickets } from '@/lib/tickets';

export default function TicketsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (!user) return;
    loadTickets();
  }, [user]);

  const loadTickets = async () => {
    try {
      setDataLoading(true);
      setError(null);
      const data = await fetchTickets();
      setTickets(data);
    } catch (err: any) {
      console.error('Failed to fetch tickets:', err);
      setError(err?.message || 'Failed to load tickets');
    } finally {
      setDataLoading(false);
    }
  };

  // Client-side search filter
  const filtered = search.trim()
    ? tickets.filter((t) => {
        const q = search.toLowerCase();
        return (
          t.ticketNumber?.toString().includes(q) ||
          t.invoiceNumber?.toLowerCase().includes(q) ||
          t.company?.toLowerCase().includes(q) ||
          t.location?.toLowerCase().includes(q) ||
          t.hauledTo?.toLowerCase().includes(q) ||
          t.driver?.toLowerCase().includes(q) ||
          t.type?.toLowerCase().includes(q) ||
          t.date?.toLowerCase().includes(q)
        );
      })
    : tickets;

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-gray-900">
      <AppHeader />

      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Title and Controls */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <h2 className="text-xl font-semibold text-white">
            Water Tickets
            <span className="text-gray-400 text-base font-normal ml-2">
              ({filtered.length}{search ? ` of ${tickets.length}` : ''})
            </span>
          </h2>

          <div className="flex items-center gap-4">
            <input
              type="text"
              placeholder="Search tickets..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-500 text-sm focus:outline-none focus:border-blue-500 w-64"
            />
            <button
              onClick={loadTickets}
              disabled={dataLoading}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors text-sm disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/50 text-red-200 rounded-lg">{error}</div>
        )}

        {dataLoading ? (
          <div className="text-gray-400">Loading tickets...</div>
        ) : filtered.length === 0 ? (
          <div className="text-gray-400">{search ? 'No tickets match your search' : 'No tickets found'}</div>
        ) : (
          <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-700">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300 whitespace-nowrap min-w-[120px]">Ticket #</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Invoice #</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Date</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Company</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Location</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Hauled To</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Type</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Qty</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Top</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Bottom</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Driver</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {filtered.map((ticket) => (
                    <tr key={ticket.id} className="hover:bg-gray-750">
                      <td className="px-4 py-3 text-blue-400 font-mono whitespace-nowrap">{ticket.ticketNumber}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {ticket.invoiceNumber ? (
                          <button
                            onClick={() => router.push(`/billing?search=${ticket.invoiceNumber}`)}
                            className="text-blue-400 font-mono text-sm hover:underline"
                          >
                            {ticket.invoiceNumber}
                          </button>
                        ) : (
                          <span className="text-gray-500 text-sm">--</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-white text-sm">{ticket.date}</td>
                      <td className="px-4 py-3 text-white">{ticket.company}</td>
                      <td className="px-4 py-3 text-white">{ticket.location}</td>
                      <td className="px-4 py-3 text-white">{ticket.hauledTo}</td>
                      <td className="px-4 py-3 text-gray-400 text-sm">{ticket.type}</td>
                      <td className="px-4 py-3 text-white font-mono">{ticket.qty}</td>
                      <td className="px-4 py-3 text-white font-mono">{ticket.top || '--'}</td>
                      <td className="px-4 py-3 text-white font-mono">{ticket.bottom || '--'}</td>
                      <td className="px-4 py-3 text-gray-400">{ticket.driver}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
