'use client';

import { Suspense, useEffect, useState, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { QueryDocumentSnapshot, DocumentData } from 'firebase/firestore';
import { useAuth } from '@/contexts/AuthContext';
import { isWbPlatformAdmin } from '@/lib/auth';
import { resolveTenantScope, logTenantScope } from '@/lib/tenantScope';
import { AppHeader } from '@/components/AppHeader';
import { Ticket, fetchTickets } from '@/lib/tickets';
import { TicketDetailModal } from '@/components/TicketDetailModal';

const PAGE_SIZE_OPTIONS = [100, 200, 500, 1000];

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
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  // Pagination (server-side, cursor-based). pageSize is a per-page/group size,
  // NOT a total cap — large operators can have 200+ tickets in a few days.
  const [pageSize, setPageSize] = useState(200);
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  // cursorsRef[i] = the startAfter cursor that begins page i (cursorsRef[0] = null).
  const cursorsRef = useRef<Record<number, QueryDocumentSnapshot<DocumentData> | null>>({ 0: null });
  // Company-less non-admin (unassigned viewer): pending activation, no data.
  const unassigned = !!user && !isWbPlatformAdmin(user) && !user.companyId;
  // Customer admin → locked to own company; platform admin → global view.
  const scope = useMemo(() => resolveTenantScope(user, null), [user]);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  // (Re)load from page 0 whenever the user, scope, or page size changes.
  useEffect(() => {
    if (!user || unassigned) return;
    cursorsRef.current = { 0: null };
    loadPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, unassigned, pageSize, scope.companyId, scope.isGlobal]);

  const loadPage = async (index: number) => {
    try {
      setDataLoading(true);
      setError(null);
      const cursor = cursorsRef.current[index] ?? null;
      const page = await fetchTickets({
        companyId: scope.companyId,
        isGlobal: scope.isGlobal,
        limitCount: pageSize,
        cursor,
      });
      logTenantScope('tickets', scope, { page: index, pageSize, resultCount: page.tickets.length });
      setTickets(page.tickets);
      setHasMore(page.hasMore);
      if (page.hasMore && page.lastDoc) cursorsRef.current[index + 1] = page.lastDoc;
      setPageIndex(index);
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

  // Auto-open ticket detail when URL search matches exactly one result
  useEffect(() => {
    if (!dataLoading && searchParams.get('search') && filtered.length === 1 && !selectedTicket) {
      setSelectedTicket(filtered[0]);
    }
  }, [dataLoading, filtered.length]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    );
  }

  if (!user) return null;

  if (unassigned) {
    return (
      <div className="min-h-screen bg-gray-900">
        <AppHeader />
        <main className="max-w-7xl mx-auto px-4 py-16">
          <div className="text-gray-400 text-center">Account pending activation. Contact your WellBuilt administrator.</div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900">
      <AppHeader />

      <main className="px-4 py-8">
        {/* Title and Controls */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <h2 className="text-xl font-semibold text-white">
            Tickets
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
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              title="Tickets per page"
              className="px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>{n} / page</option>
              ))}
            </select>
            <button
              onClick={() => loadPage(pageIndex)}
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
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300 whitespace-nowrap min-w-[80px]">Ticket #</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Invoice #</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Date</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Operator</th>
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
                      <td className="px-4 py-3 text-white">{ticket.operator || ticket.company}</td>
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

        {!dataLoading && !error && (tickets.length > 0 || pageIndex > 0) && (
          <div className="flex items-center justify-between mt-4">
            <div className="text-gray-400 text-sm">
              Page {pageIndex + 1} · showing {tickets.length}
              {scope.isGlobal ? ' (all companies)' : ''}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => pageIndex > 0 && loadPage(pageIndex - 1)}
                disabled={pageIndex === 0 || dataLoading}
                className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ← Previous
              </button>
              <button
                onClick={() => hasMore && loadPage(pageIndex + 1)}
                disabled={!hasMore || dataLoading}
                className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next →
              </button>
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
