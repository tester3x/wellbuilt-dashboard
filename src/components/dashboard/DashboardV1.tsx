'use client';

// Dashboard V1 — "At a Glance". Answers "How are we doing right now?" for an
// owner/dispatcher (and customer demos). Derived entirely from existing data
// (see dashboardStats.ts). Replaces the old navigation-card home page; a small
// Quick Links row at the bottom preserves direct navigation.

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { loadAllCompanies, type CompanyConfig } from '@/lib/companySettings';
import { fetchDashboardStats, type DashboardStats, type TopEntry, type RecentEntry } from '@/lib/dashboardStats';
import { subscribeToWellStatusesUnified } from '@/lib/wells';
import { StatCard } from './StatCard';

function num(n: number): string {
  return n.toLocaleString();
}

function fmtTime(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function TopList({ title, entries, emptyText }: { title: string; entries: TopEntry[]; emptyText: string }) {
  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-5">
      <h4 className="text-white font-semibold mb-3">{title}</h4>
      {entries.length === 0 ? (
        <p className="text-gray-500 text-sm">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e, i) => (
            <li key={e.name} className="flex items-center justify-between text-sm">
              <span className="text-gray-300 truncate mr-2">
                <span className="text-gray-500 mr-2">{i + 1}.</span>{e.name}
              </span>
              <span className="text-white font-mono whitespace-nowrap">
                {num(Math.round(e.bbl))} <span className="text-gray-500">bbl</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RecentList({ entries }: { entries: RecentEntry[] }) {
  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-5">
      <h4 className="text-white font-semibold mb-3">Recent Activity</h4>
      {entries.length === 0 ? (
        <p className="text-gray-500 text-sm">No recent tickets.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e, i) => (
            <li key={`${e.ticketNumber}-${i}`} className="text-sm">
              <div className="flex items-center justify-between">
                <span className="text-gray-300 truncate mr-2">
                  {e.well || '—'}
                </span>
                <span className="text-white font-mono whitespace-nowrap">{num(Math.round(e.bbl))} bbl</span>
              </div>
              <div className="text-gray-500 text-xs">
                {e.driver || '—'}{e.ticketNumber ? ` · #${e.ticketNumber}` : ''}{e.createdAt ? ` · ${fmtTime(e.createdAt)}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DashboardV1() {
  const { user, userCompany } = useAuth();
  const isWbAdmin = user ? !user.companyId : false;
  // Existing company branding accent; WB admins fall back to WellBuilt blue.
  const accent = userCompany?.primaryColor || '#3b82f6';

  const [allCompanies, setAllCompanies] = useState<CompanyConfig[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [downCount, setDownCount] = useState(0);

  const effectiveCompanyId = user?.companyId || selectedCompanyId;

  // WB admin: load the company picker list.
  useEffect(() => {
    if (!user) return;
    if (isWbAdmin) {
      loadAllCompanies()
        .then(companies => {
          setAllCompanies(companies);
          if (companies.length > 0) setSelectedCompanyId(prev => prev ?? companies[0].id);
        })
        .catch(() => {});
    }
  }, [user, isWbAdmin]);

  // Fetch stats whenever the effective company changes.
  useEffect(() => {
    if (!user) return;
    // WB admin with companies still loading — wait for a selection.
    if (isWbAdmin && allCompanies.length > 0 && !selectedCompanyId) return;
    let cancelled = false;
    setLoadingStats(true);
    fetchDashboardStats(effectiveCompanyId)
      .then(s => { if (!cancelled) setStats(s); })
      .catch(() => { if (!cancelled) setStats(null); })
      .finally(() => { if (!cancelled) setLoadingStats(false); });
    return () => { cancelled = true; };
  }, [user, isWbAdmin, effectiveCompanyId, allCompanies.length, selectedCompanyId]);

  // Wells needing attention (DOWN) — live.
  useEffect(() => {
    if (!user) return;
    const unsub = subscribeToWellStatusesUnified((wells) => {
      setDownCount(wells.filter(w => w.isDown || w.currentLevel === 'DOWN').length);
    });
    return unsub;
  }, [user]);

  return (
    <main className="max-w-7xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h2 className="text-2xl font-bold text-white border-l-4 pl-3" style={{ borderColor: accent }}>Dashboard</h2>
        {isWbAdmin && allCompanies.length > 0 && (
          <select
            value={selectedCompanyId || ''}
            onChange={e => setSelectedCompanyId(e.target.value)}
            className="px-3 py-2 bg-gray-700 text-white rounded text-sm w-64"
          >
            {allCompanies.map(c => (
              <option key={c.id} value={c.id}>{c.name || c.id}</option>
            ))}
          </select>
        )}
      </div>
      <p className="text-gray-400 text-sm mb-6">How are we doing right now?</p>

      {loadingStats && !stats ? (
        <div className="text-gray-400 py-12 text-center">Loading dashboard…</div>
      ) : !stats ? (
        <div className="text-gray-400 py-12 text-center">No data available.</div>
      ) : (
        <div className="space-y-6">
          {/* TODAY */}
          <section>
            <h3 className="text-gray-300 text-sm font-semibold uppercase tracking-wide mb-3">Today</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
              <StatCard label="Loads Today" value={num(stats.today.loads)} />
              <StatCard label="BBL Today" value={num(stats.today.bbl)} />
              <StatCard label="Open Jobs" value={num(stats.today.openJobs)} />
              <StatCard label="Drivers Working" value={num(stats.today.driversWorking)} />
              <StatCard label="Wells Pulled" value={num(stats.today.wellsPulled)} />
            </div>
          </section>

          {/* MONTH */}
          <section>
            <h3 className="text-gray-300 text-sm font-semibold uppercase tracking-wide mb-3">This Month</h3>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              <StatCard label="Loads This Month" value={num(stats.month.loads)} />
              <StatCard label="BBL This Month" value={num(stats.month.bbl)} />
              <StatCard label="Avg BBL / Load" value={num(stats.month.avgBblPerLoad)} />
              <StatCard label="Active Maintained Wells" value={num(stats.month.activeMaintainedWells)} />
            </div>
          </section>

          {/* TOP LISTS */}
          <section>
            <h3 className="text-gray-300 text-sm font-semibold uppercase tracking-wide mb-3">Top &amp; Recent</h3>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <TopList title="Top 5 Wells (Month)" entries={stats.topWells} emptyText="No loads this month." />
              <TopList title="Top 5 Drivers (Month)" entries={stats.topDrivers} emptyText="No loads this month." />
              <RecentList entries={stats.recent} />
            </div>
          </section>

          {/* SNAPSHOT */}
          <section>
            <h3 className="text-gray-300 text-sm font-semibold uppercase tracking-wide mb-3">Well / Route Snapshot</h3>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              <StatCard label="Maintained Wells" value={num(stats.snapshot.maintainedWells)} />
              <StatCard label="Unrouted Wells" value={num(stats.snapshot.unrouted)} />
              <StatCard label="Routes" value={num(stats.snapshot.routeCount)} />
              <StatCard
                label="Wells Needing Attention"
                value={num(downCount)}
                valueClass={downCount > 0 ? 'text-red-400' : 'text-white'}
              />
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
