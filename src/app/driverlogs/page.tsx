'use client';

import { useEffect, useState, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { getFirebaseDatabase } from '@/lib/firebase';
import { ref, get } from 'firebase/database';
import { loadAllCompanies, type CompanyConfig } from '@/lib/companySettings';
import {
  fetchDriverShifts,
  fetchInvoicesForDate,
  buildDriverDayLogs,
  formatTime12h,
  formatDuration,
  getEventLabel,
  getEventColor,
  getEventDotColor,
  type DriverDayLog,
  type UnifiedEvent,
  type LogInvoice,
} from '@/lib/driverLogs';

// ── Types ────────────────────────────────────────────────────────────────────

interface ApprovedDriver {
  key: string;
  displayName: string;
  companyId?: string;
  companyName?: string;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DriverLogsPage() {
  const { user, loading: authLoading } = useAuth();

  // Data state
  const [drivers, setDrivers] = useState<ApprovedDriver[]>([]);
  const [driverLogs, setDriverLogs] = useState<DriverDayLog[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date();
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  });
  const [driverFilter, setDriverFilter] = useState<string>('all');
  const [expandedDrivers, setExpandedDrivers] = useState<Set<string>>(new Set());

  // Company picker (WB admin)
  const [allCompanies, setAllCompanies] = useState<CompanyConfig[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const isWbAdmin = user ? !user.companyId : false;
  const effectiveCompanyId = user?.companyId || selectedCompanyId;

  // ── Load companies (WB admin) ──────────────────────────────────────────────
  useEffect(() => {
    if (!user || authLoading || !isWbAdmin) return;
    loadAllCompanies().then((companies) => {
      setAllCompanies(companies);
      if (companies.length > 0 && !selectedCompanyId) {
        setSelectedCompanyId(companies[0].id);
      }
    }).catch(console.error);
  }, [user, authLoading, isWbAdmin]);

  // ── Load approved drivers ──────────────────────────────────────────────────
  useEffect(() => {
    if (!user || authLoading) return;

    const loadDrivers = async () => {
      try {
        const db = getFirebaseDatabase();
        const approvedSnap = await get(ref(db, 'drivers/approved'));
        const approved: ApprovedDriver[] = [];

        if (approvedSnap.exists()) {
          const data = approvedSnap.val();
          Object.entries(data).forEach(([hash, val]: [string, any]) => {
            if (val.displayName) {
              // Flat format
              if (val.active !== false) {
                approved.push({
                  key: hash,
                  displayName: val.displayName,
                  companyId: val.companyId,
                  companyName: val.companyName,
                });
              }
            } else {
              // Legacy nested format
              const deviceKeys = Object.keys(val);
              if (deviceKeys.length > 0) {
                const first = val[deviceKeys[0]];
                if (first.active !== false && first.displayName) {
                  approved.push({
                    key: hash,
                    displayName: first.displayName,
                    companyId: first.companyId,
                    companyName: first.companyName,
                  });
                }
              }
            }
          });
        }

        approved.sort((a, b) => a.displayName.localeCompare(b.displayName));
        setDrivers(approved);
      } catch (err) {
        console.error('Failed to load drivers:', err);
      }
    };

    loadDrivers();
  }, [user, authLoading]);

  // ── Filtered drivers by company ────────────────────────────────────────────
  const filteredDrivers = useMemo(() => {
    if (!effectiveCompanyId) return drivers; // WB admin with no selection = all
    return drivers.filter((d) => d.companyId === effectiveCompanyId);
  }, [drivers, effectiveCompanyId]);

  // ── Load logs when date/company/drivers change ─────────────────────────────
  useEffect(() => {
    // Wait for company selection for WB admin
    if (!user || authLoading || filteredDrivers.length === 0) return;
    if (isWbAdmin && !effectiveCompanyId) return;

    const loadLogs = async () => {
      setDataLoading(true);
      setError(null);
      try {
        // Fetch shifts and invoices independently — shift data should always load
        // even if the invoice index is still building
        const driverKeys = filteredDrivers.map((d) => d.key);
        const shiftsPromise = fetchDriverShifts(driverKeys, selectedDate);
        const invoicesPromise = fetchInvoicesForDate(selectedDate, effectiveCompanyId)
          .catch((err: any) => {
            const msg = err?.message || '';
            if (msg.includes('currently building')) {
              setError('Invoice index is building — showing shift data only. Refresh in a minute.');
            } else if (msg.includes('requires an index')) {
              setError('Invoice index is building — showing shift data only. Refresh in a minute.');
            } else {
              console.error('Failed to load invoices:', err);
              setError('Failed to load invoice data.');
            }
            return [] as Awaited<ReturnType<typeof fetchInvoicesForDate>>;
          });

        const [shifts, invoices] = await Promise.all([shiftsPromise, invoicesPromise]);
        const logs = buildDriverDayLogs(filteredDrivers, shifts, invoices);
        setDriverLogs(logs);
      } catch (err: any) {
        console.error('Failed to load driver logs:', err);
        setError(err?.message || 'Failed to load logs');
      } finally {
        setDataLoading(false);
      }
    };

    loadLogs();
  }, [user, authLoading, filteredDrivers, selectedDate, effectiveCompanyId]);

  // ── Filtered logs by driver ────────────────────────────────────────────────
  const visibleLogs = useMemo(() => {
    if (driverFilter === 'all') return driverLogs;
    return driverLogs.filter((l) => l.driverHash === driverFilter);
  }, [driverLogs, driverFilter]);

  // ── Toggle expand ──────────────────────────────────────────────────────────
  const toggleExpand = (hash: string) => {
    setExpandedDrivers((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  };

  // ── Date navigation ────────────────────────────────────────────────────────
  const shiftDate = (days: number) => {
    const d = new Date(selectedDate + 'T12:00:00');
    d.setDate(d.getDate() + days);
    setSelectedDate(d.toISOString().slice(0, 10));
  };

  const isToday = selectedDate === new Date().toISOString().slice(0, 10);

  // ── Summary stats ──────────────────────────────────────────────────────────
  const totalDriversActive = driverLogs.length;
  const totalLoads = driverLogs.reduce((s, l) => s + l.totalLoads, 0);
  const totalBBL = driverLogs.reduce((s, l) => s + l.totalBBL, 0);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <AppHeader />

      <main className="max-w-6xl mx-auto px-4 py-6">
        {/* ── Header Row ──────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <h1 className="text-2xl font-bold">Driver Logs</h1>

          <div className="flex items-center gap-3 flex-wrap">
            {/* Company picker (WB admin) */}
            {isWbAdmin && allCompanies.length > 0 && (
              <select
                value={selectedCompanyId || ''}
                onChange={(e) => setSelectedCompanyId(e.target.value || null)}
                className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
              >
                {allCompanies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}

            {/* Driver filter */}
            <select
              value={driverFilter}
              onChange={(e) => setDriverFilter(e.target.value)}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="all">All Drivers</option>
              {filteredDrivers.map((d) => (
                <option key={d.key} value={d.key}>{d.displayName}</option>
              ))}
            </select>

            {/* Date navigation */}
            <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg">
              <button
                onClick={() => shiftDate(-1)}
                className="px-2 py-2 text-gray-400 hover:text-white transition-colors"
                title="Previous day"
              >
                &larr;
              </button>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="bg-transparent text-white text-sm px-1 py-2 focus:outline-none"
              />
              <button
                onClick={() => shiftDate(1)}
                disabled={isToday}
                className={`px-2 py-2 transition-colors ${
                  isToday ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400 hover:text-white'
                }`}
                title="Next day"
              >
                &rarr;
              </button>
            </div>

            {/* Today button */}
            {!isToday && (
              <button
                onClick={() => setSelectedDate(new Date().toISOString().slice(0, 10))}
                className="px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 transition-colors"
              >
                Today
              </button>
            )}
          </div>
        </div>

        {/* ── Summary Badges ──────────────────────────────────── */}
        <div className="flex gap-4 mb-6">
          <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
            <div className="text-xs text-gray-500 uppercase">Drivers</div>
            <div className="text-lg font-bold">{totalDriversActive}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
            <div className="text-xs text-gray-500 uppercase">Loads</div>
            <div className="text-lg font-bold">{totalLoads}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
            <div className="text-xs text-gray-500 uppercase">BBLs</div>
            <div className="text-lg font-bold">{Math.round(totalBBL)}</div>
          </div>
        </div>

        {/* ── Error ───────────────────────────────────────────── */}
        {error && (
          <div className="mb-4 p-3 rounded bg-red-900/50 text-red-200 text-sm">
            {error}
          </div>
        )}

        {/* ── Loading ─────────────────────────────────────────── */}
        {dataLoading && (
          <div className="text-center text-gray-400 py-12">Loading driver logs...</div>
        )}

        {/* ── No Data ─────────────────────────────────────────── */}
        {!dataLoading && visibleLogs.length === 0 && (
          <div className="text-center text-gray-500 py-12">
            No driver activity for {selectedDate}
          </div>
        )}

        {/* ── Driver Cards ────────────────────────────────────── */}
        {!dataLoading && visibleLogs.map((log) => (
          <DriverCard
            key={log.driverHash}
            log={log}
            expanded={expandedDrivers.has(log.driverHash)}
            onToggle={() => toggleExpand(log.driverHash)}
          />
        ))}
      </main>
    </div>
  );
}

// ── Driver Card Component ────────────────────────────────────────────────────

function DriverCard({
  log,
  expanded,
  onToggle,
}: {
  log: DriverDayLog;
  expanded: boolean;
  onToggle: () => void;
}) {
  // Status indicator
  const isActive = log.shiftStart && !log.shiftEnd;
  const hasShift = log.hasShiftData;

  const statusColor = isActive
    ? 'bg-green-500'
    : hasShift
      ? 'bg-gray-500'
      : 'bg-yellow-600';

  const statusLabel = isActive
    ? 'Active'
    : hasShift
      ? 'Shift Ended'
      : 'No Shift Data';

  const shiftDuration = log.shiftStart && log.shiftEnd
    ? formatDuration(log.shiftStart, log.shiftEnd)
    : log.shiftStart
      ? formatDuration(log.shiftStart, new Date().toISOString())
      : '';

  return (
    <div className="mb-3">
      {/* Collapsed header */}
      <button
        onClick={onToggle}
        className={`w-full text-left bg-gray-900 border rounded-lg p-4 transition-colors hover:bg-gray-800 ${
          expanded ? 'border-blue-600 rounded-b-none' : 'border-gray-800'
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Status dot */}
            <div className={`w-2.5 h-2.5 rounded-full ${statusColor}`} title={statusLabel} />
            {/* Name */}
            <div>
              <span className="font-semibold text-white">{log.displayName}</span>
              {log.companyName && (
                <span className="text-gray-500 text-sm ml-2">{log.companyName}</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4 text-sm">
            {/* Shift time */}
            {log.shiftStart && (
              <span className="text-gray-400">
                {formatTime12h(log.shiftStart)}
                {log.shiftEnd ? ` - ${formatTime12h(log.shiftEnd)}` : ' - ...'}
                {shiftDuration && (
                  <span className="text-gray-600 ml-1">({shiftDuration})</span>
                )}
              </span>
            )}

            {/* Stats */}
            {log.totalLoads > 0 && (
              <span className="text-blue-400">{log.totalLoads} load{log.totalLoads !== 1 ? 's' : ''}</span>
            )}
            {log.totalBBL > 0 && (
              <span className="text-cyan-400">{Math.round(log.totalBBL)} BBL</span>
            )}
            {log.totalHours > 0 && (
              <span className="text-gray-400">{log.totalHours.toFixed(1)}h</span>
            )}

            {/* Expand arrow */}
            <span className={`text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`}>
              &#9660;
            </span>
          </div>
        </div>
      </button>

      {/* Expanded timeline */}
      {expanded && (
        <div className="bg-gray-950 border border-t-0 border-blue-600 rounded-b-lg p-4">
          {log.timeline.length === 0 ? (
            <div className="text-gray-500 text-sm text-center py-4">
              No timeline events recorded
            </div>
          ) : (
            <div className="relative">
              {log.timeline.map((evt, i) => (
                <TimelineRow key={i} event={evt} isLast={i === log.timeline.length - 1} />
              ))}
            </div>
          )}

          {/* Invoice summary section */}
          {log.invoices.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-800">
              <div className="text-xs text-gray-500 uppercase mb-2">Jobs</div>
              <div className="grid gap-2">
                {log.invoices.map((inv) => (
                  <InvoiceSummaryRow key={inv.id} invoice={inv} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Timeline Row ─────────────────────────────────────────────────────────────

function TimelineRow({ event, isLast }: { event: UnifiedEvent; isLast: boolean }) {
  return (
    <div className="flex items-start gap-3 relative">
      {/* Connector line */}
      <div className="flex flex-col items-center w-4 flex-shrink-0">
        <div className={`w-2.5 h-2.5 rounded-full mt-1.5 ${getEventDotColor(event.type)}`} />
        {!isLast && (
          <div className="w-px flex-1 bg-gray-700 min-h-[24px]" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 pb-3 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={`text-sm font-medium ${getEventColor(event.type)}`}>
            {getEventLabel(event)}
          </span>
          <span className="text-xs text-gray-500">
            {formatTime12h(event.timestamp)}
          </span>
          {event.invoiceNumber && (
            <span className="text-xs text-gray-600">#{event.invoiceNumber}</span>
          )}
        </div>
        {/* GPS coords — subtle */}
        {event.lat && event.lng && (
          <div className="text-xs text-gray-600 mt-0.5">
            {event.lat.toFixed(4)}, {event.lng.toFixed(4)}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Invoice Summary Row ──────────────────────────────────────────────────────

function InvoiceSummaryRow({ invoice }: { invoice: LogInvoice }) {
  const statusColors: Record<string, string> = {
    open: 'bg-yellow-600/20 text-yellow-400',
    closed: 'bg-gray-600/20 text-gray-400',
    submitted: 'bg-blue-600/20 text-blue-400',
    approved: 'bg-green-600/20 text-green-400',
    paid: 'bg-green-600 text-white',
  };

  return (
    <div className="flex items-center justify-between bg-gray-900 rounded px-3 py-2 text-sm">
      <div className="flex items-center gap-3 min-w-0">
        <span className="font-mono text-gray-300">#{invoice.invoiceNumber}</span>
        <span className="text-white truncate">{invoice.wellName}</span>
        {invoice.operator && (
          <span className="text-gray-500 truncate hidden sm:inline">{invoice.operator}</span>
        )}
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        {invoice.hauledTo && (
          <span className="text-gray-500 text-xs truncate max-w-[120px]">&rarr; {invoice.hauledTo}</span>
        )}
        {invoice.totalBBL > 0 && (
          <span className="text-cyan-400">{Math.round(invoice.totalBBL)} BBL</span>
        )}
        {invoice.totalHours > 0 && (
          <span className="text-gray-400">{invoice.totalHours.toFixed(1)}h</span>
        )}
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[invoice.status] || statusColors.closed}`}>
          {invoice.status}
        </span>
      </div>
    </div>
  );
}
