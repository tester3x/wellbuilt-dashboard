'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { subscribeToWellStatusesUnified, WellResponse } from '@/lib/wells';
import { fetchTickets } from '@/lib/tickets';
import { fetchInvoices, DashboardInvoice, getStatusColor } from '@/lib/invoices';
import Link from 'next/link';

export default function HomePage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Summary stats
  const [wellCount, setWellCount] = useState(0);
  const [downCount, setDownCount] = useState(0);
  const [ticketCount, setTicketCount] = useState(0);
  const [invoiceCount, setInvoiceCount] = useState(0);
  const [openInvoices, setOpenInvoices] = useState(0);
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  // Load summary data
  useEffect(() => {
    if (!user) return;

    // Subscribe to well data for counts
    const unsubWells = subscribeToWellStatusesUnified((wells) => {
      setWellCount(wells.length);
      setDownCount(wells.filter(w => w.isDown || w.currentLevel === 'DOWN').length);
      setStatsLoading(false);
    });

    // Fetch ticket and invoice counts
    fetchTickets(1000).then(tickets => {
      setTicketCount(tickets.length);
    }).catch(() => {});

    fetchInvoices(1000).then(invoices => {
      setInvoiceCount(invoices.length);
      setOpenInvoices(invoices.filter(i => i.status === 'open').length);
    }).catch(() => {});

    return unsubWells;
  }, [user]);

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
        <h2 className="text-xl font-semibold text-white mb-6">Dashboard Overview</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 items-stretch">
          {/* WB Mobile Card */}
          <Link href="/mobile" className="block h-full">
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-6 hover:border-blue-500 transition-colors cursor-pointer h-full">
              <h3 className="text-lg font-semibold text-white mb-2">WB Mobile</h3>
              <p className="text-gray-400 text-sm mb-4">Well monitoring &amp; status</p>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">Wells</span>
                  <span className="text-white font-mono">{statsLoading ? '...' : wellCount}</span>
                </div>
                {downCount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-red-400">Down</span>
                    <span className="text-red-400 font-mono">{downCount}</span>
                  </div>
                )}
              </div>
            </div>
          </Link>

          {/* WB Tickets Card */}
          <Link href="/tickets" className="block h-full">
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-6 hover:border-blue-500 transition-colors cursor-pointer h-full">
              <h3 className="text-lg font-semibold text-white mb-2">WB Tickets</h3>
              <p className="text-gray-400 text-sm mb-4">Water ticket review</p>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">Tickets</span>
                  <span className="text-white font-mono">{ticketCount || '...'}</span>
                </div>
              </div>
            </div>
          </Link>

          {/* WB Billing Card */}
          <Link href="/billing" className="block h-full">
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-6 hover:border-blue-500 transition-colors cursor-pointer h-full">
              <h3 className="text-lg font-semibold text-white mb-2">WB Billing</h3>
              <p className="text-gray-400 text-sm mb-4">Invoices &amp; billing</p>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">Invoices</span>
                  <span className="text-white font-mono">{invoiceCount || '...'}</span>
                </div>
                {openInvoices > 0 && (
                  <div className="flex justify-between">
                    <span className="text-yellow-400">Open</span>
                    <span className="text-yellow-400 font-mono">{openInvoices}</span>
                  </div>
                )}
              </div>
            </div>
          </Link>

          {/* WB Payroll Card */}
          <Link href="/payroll" className="block h-full">
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-6 hover:border-blue-500 transition-colors cursor-pointer h-full">
              <h3 className="text-lg font-semibold text-white mb-2">WB Payroll</h3>
              <p className="text-gray-400 text-sm mb-4">Employee timesheets &amp; payroll</p>
              <div className="flex items-center justify-center py-4">
                <span className="text-gray-500 text-sm">Coming Soon</span>
              </div>
            </div>
          </Link>
        </div>
      </main>
    </div>
  );
}
