'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { subscribeToWellStatusesUnified, WellResponse } from '@/lib/wells';
import { canViewGlobalWellPool } from '@/lib/tenantScope';
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

    // Tenant containment (7/9): the global well pool is Liquid Gold's data —
    // other scoped companies get zero counts, no subscription. See
    // lib/tenantScope.ts.
    let unsubWells: (() => void) | undefined;
    if (canViewGlobalWellPool(user)) {
      unsubWells = subscribeToWellStatusesUnified((wells) => {
        setWellCount(wells.length);
        setDownCount(wells.filter(w => w.isDown || w.currentLevel === 'DOWN').length);
        setStatsLoading(false);
      });
    } else {
      setWellCount(0);
      setDownCount(0);
      setStatsLoading(false);
    }

    // Fetch ticket and invoice counts — scoped users count only their own
    // company's docs (docs carry companyId; filtered in the fetch helpers).
    fetchTickets(1000, user.companyId).then(tickets => {
      setTicketCount(tickets.length);
    }).catch(() => {});

    fetchInvoices(1000, user.companyId).then(invoices => {
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
        {/* Pending-signup banner (re-home of the DashboardV1 banner lost when
            main deleted that component — fbf3096's third piece). Reads only
            the restored WellBuiltUser fields; no new data model. Shown until
            a WB admin activates the request from Admin → Companies. */}
        {(user.onboardingStatus === 'pending_company_assignment' || user.status === 'pending') && (
          <div className="mb-6 bg-amber-900/30 border border-amber-700/60 rounded-lg p-4">
            <div className="text-[11px] uppercase tracking-wide text-amber-300 mb-1">
              Company request pending
            </div>
            <p className="text-sm text-gray-200">
              {user.requestedCompanyName
                ? <>Your request for <span className="font-semibold text-white">{user.requestedCompanyName}</span> is awaiting WellBuilt approval.</>
                : 'Your account is awaiting WellBuilt approval.'}
            </p>
          </div>
        )}
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
              <div className="flex items-center gap-3 mb-2">
                <img src="/billing-icon.png" alt="WB Billing" className="w-24 h-24" />
                <h3 className="text-lg font-semibold text-white">WB Billing</h3>
              </div>
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
              <div className="flex items-center gap-3 mb-2">
                <img src="/payroll-icon.png" alt="WB Payroll" className="w-24 h-24" />
                <h3 className="text-lg font-semibold text-white">WB Payroll</h3>
              </div>
              <p className="text-gray-400 text-sm mb-4">Employee timesheets &amp; payroll</p>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">Status</span>
                  <span className="text-green-400 font-mono">Active</span>
                </div>
              </div>
            </div>
          </Link>
        </div>
      </main>
    </div>
  );
}
