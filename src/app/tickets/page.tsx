'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { isPlatformAdmin } from '@/lib/auth';
import { Ticket, fetchTickets, searchTicketsArchive } from '@/lib/tickets';
import { TicketDetailModal } from '@/components/TicketDetailModal';

export default function TicketsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-900 flex items-center justify-center"><div className="text-white">Loading...</div></div>}>
      <TicketsPageInner />
    </Suspense>
  );
}

function TicketsPageInner() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [submittedSearch, setSubmittedSearch] = useState((searchParams.get('search') || '').trim());
  const [refreshToken, setRefreshToken] = useState(0);
  const [scannedTickets, setScannedTickets] = useState(0);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (loading || !user) return;
    let cancelled = false;
    const loadTickets = async () => {
      const companyId = user.companyId?.trim();
      if (!companyId && !isPlatformAdmin(user)) {
        setTickets([]);
        setDataLoading(false);
        setError('Company access is unavailable. Tickets were not loaded.');
        return;
      }
      setDataLoading(true);
      setTickets([]);
      setScannedTickets(0);
      setError(null);
      try {
        const data = submittedSearch
          ? await searchTicketsArchive(submittedSearch, companyId || undefined, (count) => {
              if (!cancelled) setScannedTickets(count);
            }, () => cancelled)
          : await fetchTickets(200, companyId || undefined);
        if (!cancelled) {
          setTickets(data);
          if (submittedSearch && submittedSearch === searchParams.get('search')?.trim() && data.length === 1) {
            setSelectedTicket(data[0]);
          }
        }
      } catch (err: unknown) {
        if (!cancelled) {
          console.error('Failed to fetch tickets:', err);
          setError(err instanceof Error ? err.message : 'Failed to load tickets');
        }
      } finally {
        if (!cancelled) setDataLoading(false);
      }
    };
    void loadTickets();
    return () => { cancelled = true; };
  }, [user, loading, submittedSearch, refreshToken, searchParams]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmittedSearch(search.trim());
    setRefreshToken((previous) => previous + 1);
  };

  const filtered = tickets;

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

      <main className="px-4 py-8">
        {/* Title and Controls */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <h2 className="text-xl font-semibold text-white">
            Tickets
            <span className="text-gray-400 text-base font-normal ml-2">
              ({filtered.length}{submittedSearch ? ' matching tickets' : ' recent tickets'})
            </span>
          </h2>

          <form onSubmit={submitSearch} className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              placeholder="Search tickets..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-500 text-sm focus:outline-none focus:border-blue-500 w-64"
            />
            <button
              type="submit"
              disabled={!search.trim()}
              className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50"
            >
              Search all tickets
            </button>
            {submittedSearch && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setSubmittedSearch('');
                  setRefreshToken((previous) => previous + 1);
                }}
                className="px-3 py-2 text-gray-300 hover:text-white text-sm"
              >
                Clear search
              </button>
            )}
            <button
              type="button"
              onClick={() => setRefreshToken((previous) => previous + 1)}
              disabled={dataLoading}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors text-sm disabled:opacity-50"
            >
              Refresh
            </button>
          </form>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/50 text-red-200 rounded-lg">{error}</div>
        )}

        {dataLoading ? (
          <div className="text-gray-400">
            {submittedSearch ? `Searching the full ticket archive... ${scannedTickets} tickets checked.` : 'Loading recent tickets...'}
          </div>
        ) : error ? null : filtered.length === 0 ? (
          <div className="text-gray-400">{submittedSearch ? `No tickets match “${submittedSearch}” in the full archive.` : 'No tickets found'}</div>
        ) : (
          <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-700">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300 whitespace-nowrap min-w-[80px]">Ticket #</th>
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
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {filtered.map((ticket) => (
                    <tr
                      key={ticket.id}
                      className="hover:bg-gray-700/50 cursor-pointer transition-colors"
                      onClick={() => setSelectedTicket(ticket)}
                    >
                      <td className="px-4 py-3 text-blue-400 font-mono whitespace-nowrap">{ticket.ticketNumber}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {ticket.invoiceNumber ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); router.push(`/billing?search=${ticket.invoiceNumber}`); }}
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
                      <td className="px-4 py-3 whitespace-nowrap">
                        {ticket.status === 'void' ? (
                          <span className="px-2 py-0.5 bg-red-900/40 text-red-400 text-xs font-medium rounded">VOID</span>
                        ) : (
                          <span className="px-2 py-0.5 bg-gray-600/30 text-gray-400 text-xs rounded">Active</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>

      {/* Paper-style detail modal */}
      {selectedTicket && (
        <TicketDetailModal
          ticket={selectedTicket}
          onClose={() => setSelectedTicket(null)}
          onNavigateTicket={(t) => setSelectedTicket(t)}
        />
      )}
    </div>
  );
}
