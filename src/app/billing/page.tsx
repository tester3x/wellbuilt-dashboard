'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { DashboardInvoice, InvoiceStatus, fetchInvoices, getStatusColor } from '@/lib/invoices';

const STATUS_OPTIONS: { value: '' | InvoiceStatus; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'approved', label: 'Approved' },
  { value: 'paid', label: 'Paid' },
];

export default function BillingPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [invoices, setInvoices] = useState<DashboardInvoice[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | InvoiceStatus>('');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (!user) return;
    loadInvoices();
  }, [user]);

  const loadInvoices = async () => {
    try {
      setDataLoading(true);
      setError(null);
      const data = await fetchInvoices();
      setInvoices(data);
    } catch (err: any) {
      console.error('Failed to fetch invoices:', err);
      setError(err?.message || 'Failed to load invoices');
    } finally {
      setDataLoading(false);
    }
  };

  // Client-side filters
  const filtered = invoices.filter((inv) => {
    if (statusFilter && inv.status !== statusFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        inv.invoiceNumber?.toLowerCase().includes(q) ||
        inv.operator?.toLowerCase().includes(q) ||
        inv.wellName?.toLowerCase().includes(q) ||
        inv.driver?.toLowerCase().includes(q) ||
        inv.date?.toLowerCase().includes(q)
      );
    }
    return true;
  });

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
            Invoices
            <span className="text-gray-400 text-base font-normal ml-2">
              ({filtered.length}{search || statusFilter ? ` of ${invoices.length}` : ''})
            </span>
          </h2>

          <div className="flex items-center gap-4">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as '' | InvoiceStatus)}
              className="px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Search invoices..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-500 text-sm focus:outline-none focus:border-blue-500 w-64"
            />
            <button
              onClick={loadInvoices}
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
          <div className="text-gray-400">Loading invoices...</div>
        ) : filtered.length === 0 ? (
          <div className="text-gray-400">{search || statusFilter ? 'No invoices match your filters' : 'No invoices found'}</div>
        ) : (
          <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-700">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300 whitespace-nowrap min-w-[120px]">Invoice #</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Date</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Operator</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Well</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Status</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">BBLs</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Hours</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Type</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Driver</th>
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Tickets</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {filtered.map((inv) => (
                    <InvoiceRow
                      key={inv.id}
                      invoice={inv}
                      isExpanded={expandedRow === inv.id}
                      onToggle={() => setExpandedRow(expandedRow === inv.id ? null : inv.id)}
                    />
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

function InvoiceRow({
  invoice,
  isExpanded,
  onToggle,
}: {
  invoice: DashboardInvoice;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="hover:bg-gray-750 cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-3 text-blue-400 font-mono whitespace-nowrap">{invoice.invoiceNumber || '--'}</td>
        <td className="px-4 py-3 text-white text-sm">{invoice.date}</td>
        <td className="px-4 py-3 text-white">{invoice.operator}</td>
        <td className="px-4 py-3 text-white">{invoice.wellName}</td>
        <td className="px-4 py-3">
          <span className={`px-2 py-1 rounded text-xs font-medium capitalize ${getStatusColor(invoice.status)}`}>
            {invoice.status}
          </span>
        </td>
        <td className="px-4 py-3 text-white font-mono">{invoice.totalBBL || '--'}</td>
        <td className="px-4 py-3 text-white font-mono">{invoice.totalHours || '--'}</td>
        <td className="px-4 py-3 text-gray-400 text-sm">{invoice.commodityType}</td>
        <td className="px-4 py-3 text-gray-400">{invoice.driver}</td>
        <td className="px-4 py-3 text-gray-400 font-mono">{invoice.tickets?.length || 0}</td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={10} className="px-4 py-3 bg-gray-750">
            <div className="text-sm">
              <span className="text-gray-400">Truck:</span>{' '}
              <span className="text-white">{invoice.truckNumber || '--'}</span>
              {invoice.notes && (
                <>
                  <span className="text-gray-400 ml-4">Notes:</span>{' '}
                  <span className="text-white">{invoice.notes}</span>
                </>
              )}
              {invoice.tickets?.length > 0 && (
                <div className="mt-2">
                  <span className="text-gray-400">Ticket IDs:</span>{' '}
                  <span className="text-white font-mono text-xs">{invoice.tickets.join(', ')}</span>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
