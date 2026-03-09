'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import {
  PayPeriod,
  DriverTimesheetSummary,
  DriverTimesheetRow,
  TimesheetStatus,
  Deduction,
  Addition,
  DeductionType,
  AmountType,
  DeductionFrequency,
  DEDUCTION_PRESETS,
  BONUS_PRESETS,
  getPayPeriods,
  fetchPayrollInvoices,
  fetchDeductions,
  fetchAdditions,
  saveDeduction,
  saveAddition,
  deactivateDeduction,
  deactivateAddition,
  calculatePeriodDeduction,
  calculatePeriodAddition,
  formatCurrency,
  formatPeriodRange,
} from '@/lib/payroll';
import { type CompanyConfig, loadAllCompanies } from '@/lib/companySettings';
import { Timestamp } from 'firebase/firestore';
import { ref, get } from 'firebase/database';
import { getFirebaseDatabase } from '@/lib/firebase';

// ─── Status Helpers ──────────────────────────────────────────────────────────

function getStatusBadge(status: TimesheetStatus) {
  switch (status) {
    case 'building':
      return { label: 'Building', color: 'bg-gray-600/20 text-gray-400' };
    case 'pending':
      return { label: 'Pending', color: 'bg-yellow-600/20 text-yellow-400' };
    case 'sent':
      return { label: 'Sent', color: 'bg-blue-600/20 text-blue-400' };
    case 'approved':
      return { label: 'Approved', color: 'bg-green-600/20 text-green-400' };
    case 'disputed':
      return { label: 'Disputed', color: 'bg-red-600/20 text-red-400' };
    default:
      return { label: status, color: 'bg-gray-600/20 text-gray-400' };
  }
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function PayrollPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  // State
  const [payPeriods] = useState<PayPeriod[]>(() => getPayPeriods());
  const [selectedPeriodIdx, setSelectedPeriodIdx] = useState(0);
  const [timesheets, setTimesheets] = useState<DriverTimesheetSummary[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedDriver, setExpandedDriver] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Deductions state
  const [deductions, setDeductions] = useState<Deduction[]>([]);
  const [showDeductionModal, setShowDeductionModal] = useState(false);
  const [showDeductionList, setShowDeductionList] = useState(false);
  const [driverNames, setDriverNames] = useState<string[]>([]);
  const [legalNameMap, setLegalNameMap] = useState<Record<string, string>>({});
  const [dedDriver, setDedDriver] = useState('');
  const [dedReason, setDedReason] = useState('');
  const [dedCustomReason, setDedCustomReason] = useState('');
  const [dedType, setDedType] = useState<DeductionType>('one_time');
  const [dedFrequency, setDedFrequency] = useState<DeductionFrequency>('weekly');
  const [dedAmountType, setDedAmountType] = useState<AmountType>('flat');
  const [dedAmount, setDedAmount] = useState('');
  const [dedTotal, setDedTotal] = useState('');
  const [dedNotes, setDedNotes] = useState('');
  const [dedStartDate, setDedStartDate] = useState('');  // YYYY-MM-DD for effectiveDate
  const [dedSaving, setDedSaving] = useState(false);

  // Additions (bonuses/reimbursements) state
  const [additions, setAdditions] = useState<Addition[]>([]);
  const [showAdditionModal, setShowAdditionModal] = useState(false);
  const [showAdditionList, setShowAdditionList] = useState(false);
  const [addDriver, setAddDriver] = useState('');
  const [addReason, setAddReason] = useState('');
  const [addCustomReason, setAddCustomReason] = useState('');
  const [addType, setAddType] = useState<DeductionType>('one_time');
  const [addFrequency, setAddFrequency] = useState<DeductionFrequency>('weekly');
  const [addAmountType, setAddAmountType] = useState<AmountType>('flat');
  const [addAmount, setAddAmount] = useState('');
  const [addTotal, setAddTotal] = useState('');
  const [addNotes, setAddNotes] = useState('');
  const [addStartDate, setAddStartDate] = useState('');  // YYYY-MM-DD for effectiveDate
  const [addSaving, setAddSaving] = useState(false);

  const selectedPeriod = payPeriods[selectedPeriodIdx];

  // Auth guard
  useEffect(() => {
    if (!loading && !user) router.push('/login');
  }, [user, loading, router]);

  // Fetch data when period changes
  useEffect(() => {
    if (!user || !selectedPeriod) return;
    loadPayrollData();
  }, [user, selectedPeriodIdx]);

  // Load deductions + additions + driver names on mount
  useEffect(() => {
    if (!user) return;
    loadDeductions();
    loadAdditions();
    loadDriverNames();
  }, [user]);

  const loadDeductions = async () => {
    try {
      const data = await fetchDeductions();
      setDeductions(data);
    } catch (err) {
      console.error('Failed to load deductions:', err);
    }
  };

  const loadAdditions = async () => {
    try {
      const data = await fetchAdditions();
      setAdditions(data);
    } catch (err) {
      console.error('Failed to load additions:', err);
    }
  };

  const loadDriverNames = async () => {
    try {
      const db = getFirebaseDatabase();
      const snapshot = await get(ref(db, 'drivers/approved'));
      if (!snapshot.exists()) return;
      const names: string[] = [];
      const legalMap: Record<string, string> = {};
      snapshot.forEach(child => {
        const data = child.val();
        if (data?.displayName) {
          names.push(data.displayName);
          const legal = data.legalName || data.profile?.legalName;
          if (legal) legalMap[data.displayName] = legal;
        }
      });
      setDriverNames([...new Set(names)].sort());
      setLegalNameMap(legalMap);
    } catch (err) {
      console.error('Failed to load driver names:', err);
    }
  };

  const loadPayrollData = async () => {
    try {
      setDataLoading(true);
      setError(null);

      // Load company configs for rate sheet + pay config lookup
      const companies = await loadAllCompanies();
      const companyMap = new Map<string, CompanyConfig>();
      companies.forEach(c => companyMap.set(c.id, c));

      // Build well→county map for frost rate lookup
      const allOperators = new Set<string>();
      companies.forEach(c => c.assignedOperators?.forEach(op => allOperators.add(op)));
      const { buildWellCountyMap } = await import('@/lib/payroll');
      const countyMap = await buildWellCountyMap([...allOperators]);

      // Build legalNameMap from RTDB (can't rely on state — may not be loaded yet)
      let currentLegalMap = legalNameMap;
      if (Object.keys(currentLegalMap).length === 0) {
        try {
          const driversSnap = await get(ref(getFirebaseDatabase(), 'drivers/approved'));
          if (driversSnap.exists()) {
            const map: Record<string, string> = {};
            driversSnap.forEach(child => {
              const d = child.val();
              const legal = d?.legalName || d?.profile?.legalName;
              if (d?.displayName && legal) map[d.displayName] = legal;
            });
            currentLegalMap = map;
            setLegalNameMap(map);
          }
        } catch {}
      }

      const data = await fetchPayrollInvoices(selectedPeriod, companyMap, undefined, countyMap, currentLegalMap);
      setTimesheets(data);
    } catch (err: any) {
      console.error('Failed to fetch payroll data:', err);
      setError(err?.message || 'Failed to load payroll data');
    } finally {
      setDataLoading(false);
    }
  };

  // Deduction handlers
  const resetDeductionForm = () => {
    setDedDriver('');
    setDedReason('');
    setDedCustomReason('');
    setDedType('one_time');
    setDedFrequency('weekly');
    setDedAmountType('flat');
    setDedAmount('');
    setDedTotal('');
    setDedNotes('');
    setDedStartDate('');
  };

  const openAddDeduction = (preselectedDriver?: string) => {
    resetDeductionForm();
    if (preselectedDriver) setDedDriver(preselectedDriver);
    setShowDeductionModal(true);
  };

  const handleSaveDeduction = async () => {
    const reason = dedReason === 'Other' ? dedCustomReason.trim() : dedReason;
    if (!dedDriver || !reason || !dedAmount) return;

    setDedSaving(true);
    try {
      const amount = parseFloat(dedAmount);
      const totalOwed = dedType === 'recurring' ? parseFloat(dedTotal) || amount : amount;

      await saveDeduction({
        driverName: dedDriver,
        reason,
        deductionType: dedType,
        frequency: dedType === 'recurring' ? dedFrequency : undefined,
        amountType: dedAmountType,
        amountPerPeriod: amount,
        totalOwed,
        totalCollected: 0,
        active: true,
        createdAt: Timestamp.now(),
        effectiveDate: dedStartDate ? Timestamp.fromDate(new Date(dedStartDate + 'T00:00:00')) : undefined,
        notes: dedNotes.trim() || undefined,
      });

      setShowDeductionModal(false);
      resetDeductionForm();
      await loadDeductions();
    } catch (err) {
      console.error('Failed to save deduction:', err);
    } finally {
      setDedSaving(false);
    }
  };

  const handleRemoveDeduction = async (id: string) => {
    if (!confirm('Remove this deduction?')) return;
    try {
      await deactivateDeduction(id);
      await loadDeductions();
    } catch (err) {
      console.error('Failed to remove deduction:', err);
    }
  };

  // Addition handlers
  const resetAdditionForm = () => {
    setAddDriver('');
    setAddReason('');
    setAddCustomReason('');
    setAddType('one_time');
    setAddFrequency('weekly');
    setAddAmountType('flat');
    setAddAmount('');
    setAddTotal('');
    setAddNotes('');
    setAddStartDate('');
  };

  const openAddAddition = (preselectedDriver?: string) => {
    resetAdditionForm();
    if (preselectedDriver) setAddDriver(preselectedDriver);
    setShowAdditionModal(true);
  };

  const handleSaveAddition = async () => {
    const reason = addReason === 'Other' ? addCustomReason.trim() : addReason;
    if (!addDriver || !reason || !addAmount) return;

    setAddSaving(true);
    try {
      const amount = parseFloat(addAmount);
      const totalOwed = addType === 'recurring' ? parseFloat(addTotal) || amount : amount;

      await saveAddition({
        driverName: addDriver,
        reason,
        additionType: addType,
        frequency: addType === 'recurring' ? addFrequency : undefined,
        amountType: addAmountType,
        amountPerPeriod: amount,
        totalOwed,
        totalPaid: 0,
        active: true,
        createdAt: Timestamp.now(),
        effectiveDate: addStartDate ? Timestamp.fromDate(new Date(addStartDate + 'T00:00:00')) : undefined,
        notes: addNotes.trim() || undefined,
      });

      setShowAdditionModal(false);
      resetAdditionForm();
      await loadAdditions();
    } catch (err) {
      console.error('Failed to save addition:', err);
    } finally {
      setAddSaving(false);
    }
  };

  const handleRemoveAddition = async (id: string) => {
    if (!confirm('Remove this bonus/reimbursement?')) return;
    try {
      await deactivateAddition(id);
      await loadAdditions();
    } catch (err) {
      console.error('Failed to remove addition:', err);
    }
  };

  // Active deductions per driver
  const driverDeductions = useMemo(() => {
    const map = new Map<string, Deduction[]>();
    deductions.forEach(d => {
      if (!map.has(d.driverName)) map.set(d.driverName, []);
      map.get(d.driverName)!.push(d);
    });
    return map;
  }, [deductions]);

  // Active additions per driver
  const driverAdditions = useMemo(() => {
    const map = new Map<string, Addition[]>();
    additions.forEach(a => {
      if (!map.has(a.driverName)) map.set(a.driverName, []);
      map.get(a.driverName)!.push(a);
    });
    return map;
  }, [additions]);

  // Apply deductions + additions to each driver summary (period-aware)
  const processedTimesheets = useMemo(() => {
    return timesheets.map(ts => {
      const driverDeds = driverDeductions.get(ts.driverName) || [];
      const driverAdds = driverAdditions.get(ts.driverName) || [];

      const totalDeductions = driverDeds.reduce(
        (sum, d) => sum + calculatePeriodDeduction(d, ts.employeePay, selectedPeriod), 0
      );
      const totalAdditions = driverAdds.reduce(
        (sum, a) => sum + calculatePeriodAddition(a, ts.employeePay, selectedPeriod), 0
      );

      const netPay = Math.round((ts.employeePay + totalAdditions - totalDeductions) * 100) / 100;

      return {
        ...ts,
        deductions: Math.round(totalDeductions * 100) / 100,
        additions: Math.round(totalAdditions * 100) / 100,
        netPay: Math.max(0, netPay),
      };
    });
  }, [timesheets, driverDeductions, driverAdditions, selectedPeriod]);

  // Filter by search
  const filtered = useMemo(() => {
    if (!search.trim()) return processedTimesheets;
    const q = search.toLowerCase();
    return processedTimesheets.filter(ts =>
      ts.driverName.toLowerCase().includes(q) ||
      ts.companyName?.toLowerCase().includes(q)
    );
  }, [processedTimesheets, search]);

  // Totals
  const totals = useMemo(() => {
    return filtered.reduce(
      (acc, ts) => ({
        loads: acc.loads + ts.totalLoads,
        hours: acc.hours + ts.totalHours,
        bbls: acc.bbls + ts.totalBBLs,
        billed: acc.billed + ts.grossBilled,
        pay: acc.pay + ts.employeePay,
        additions: acc.additions + ts.additions,
        deductions: acc.deductions + ts.deductions,
        net: acc.net + ts.netPay,
      }),
      { loads: 0, hours: 0, bbls: 0, billed: 0, pay: 0, additions: 0, deductions: 0, net: 0 }
    );
  }, [filtered]);

  // Status counts for badges
  const statusCounts = useMemo(() => {
    const counts: Record<TimesheetStatus, number> = {
      building: 0,
      pending: 0,
      sent: 0,
      approved: 0,
      disputed: 0,
    };
    timesheets.forEach(ts => counts[ts.status]++);
    return counts;
  }, [timesheets]);

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

      <main className="max-w-7xl mx-auto px-4 py-6">
        {/* ── Header Row ── */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">WB Payroll</h1>
            <p className="text-gray-400 text-sm mt-1">Employee Timesheets &amp; Pay</p>
          </div>

          <div className="flex items-center gap-3">
            {/* Pay Period Selector */}
            <select
              value={selectedPeriodIdx}
              onChange={e => {
                setSelectedPeriodIdx(Number(e.target.value));
                setExpandedDriver(null);
              }}
              className="bg-gray-800 border border-gray-600 text-white px-3 py-2 rounded-lg text-sm"
            >
              {payPeriods.map((p, i) => (
                <option key={p.type} value={i}>{p.label}</option>
              ))}
            </select>

            {/* Bulk Actions */}
            <button
              onClick={() => {/* TODO: Send all timesheets to drivers */}}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Send All
            </button>
            <button
              onClick={() => {/* TODO: Lock pay period */}}
              className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Lock Period
            </button>
            <button
              onClick={() => {/* TODO: Export all timesheets */}}
              className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Export All
            </button>
            <button
              onClick={() => { setShowAdditionList(!showAdditionList); setShowDeductionList(false); }}
              className="bg-green-700 hover:bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors relative"
            >
              Bonuses
              {additions.length > 0 && (
                <span className="absolute -top-1 -right-1 bg-green-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center">
                  {additions.length}
                </span>
              )}
            </button>
            <button
              onClick={() => { setShowDeductionList(!showDeductionList); setShowAdditionList(false); }}
              className="bg-red-700 hover:bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors relative"
            >
              Deductions
              {deductions.length > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center">
                  {deductions.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* ── Status Badges ── */}
        <div className="flex gap-2 mb-4">
          {statusCounts.building > 0 && (
            <span className="px-3 py-1 rounded-full text-xs font-medium bg-gray-600/20 text-gray-400">
              {statusCounts.building} Building
            </span>
          )}
          {statusCounts.pending > 0 && (
            <span className="px-3 py-1 rounded-full text-xs font-medium bg-yellow-600/20 text-yellow-400">
              {statusCounts.pending} Pending
            </span>
          )}
          {statusCounts.sent > 0 && (
            <span className="px-3 py-1 rounded-full text-xs font-medium bg-blue-600/20 text-blue-400">
              {statusCounts.sent} Sent
            </span>
          )}
          {statusCounts.approved > 0 && (
            <span className="px-3 py-1 rounded-full text-xs font-medium bg-green-600/20 text-green-400">
              {statusCounts.approved} Approved
            </span>
          )}
          {statusCounts.disputed > 0 && (
            <span className="px-3 py-1 rounded-full text-xs font-medium bg-red-600/20 text-red-400">
              {statusCounts.disputed} Disputed
            </span>
          )}
        </div>

        {/* ── Search ── */}
        <div className="mb-4">
          <input
            type="text"
            placeholder="Search drivers..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-gray-800 border border-gray-600 text-white px-3 py-2 rounded-lg text-sm w-64"
          />
        </div>

        {/* ── Error ── */}
        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded-lg mb-4">
            {error}
          </div>
        )}

        {/* ── Loading ── */}
        {dataLoading ? (
          <div className="bg-gray-800 rounded-lg border border-gray-700 p-12 text-center">
            <div className="text-gray-400">Loading payroll data...</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-gray-800 rounded-lg border border-gray-700 p-12 text-center">
            <div className="text-gray-400">
              {timesheets.length === 0
                ? 'No closed invoices found for this pay period.'
                : 'No drivers match your search.'}
            </div>
          </div>
        ) : (
          /* ── Multi-Driver Summary Table ── */
          <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-700 bg-gray-800/50">
                    <th className="text-left text-gray-400 font-medium px-4 py-3">Driver</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-3">Loads</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-3">Hours</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-3">BBLs</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-3">Gross Billed</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-3">Employee Pay</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-3">Bonuses</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-3">Deductions</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-3">Net Pay</th>
                    <th className="text-center text-gray-400 font-medium px-4 py-3">Status</th>
                    <th className="text-center text-gray-400 font-medium px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(ts => {
                    const badge = getStatusBadge(ts.status);
                    const isExpanded = expandedDriver === ts.driverName;

                    return (
                      <DriverRow
                        key={ts.driverName}
                        summary={ts}
                        badge={badge}
                        isExpanded={isExpanded}
                        onToggle={() => setExpandedDriver(isExpanded ? null : ts.driverName)}
                        legalNameMap={legalNameMap}
                      />
                    );
                  })}

                  {/* ── Totals Row ── */}
                  <tr className="border-t-2 border-gray-600 bg-gray-700/30 font-bold">
                    <td className="px-4 py-3 text-white">
                      TOTAL ({filtered.length} driver{filtered.length !== 1 ? 's' : ''})
                    </td>
                    <td className="text-right px-4 py-3 text-white">{totals.loads}</td>
                    <td className="text-right px-4 py-3 text-white">{totals.hours.toFixed(2)}</td>
                    <td className="text-right px-4 py-3 text-white">{totals.bbls.toLocaleString()}</td>
                    <td className="text-right px-4 py-3 text-white">{formatCurrency(totals.billed)}</td>
                    <td className="text-right px-4 py-3 text-white">{formatCurrency(totals.pay)}</td>
                    <td className="text-right px-4 py-3 text-green-400">
                      {totals.additions > 0 ? `+${formatCurrency(totals.additions)}` : '—'}
                    </td>
                    <td className="text-right px-4 py-3 text-red-400">
                      {totals.deductions > 0 ? `-${formatCurrency(totals.deductions)}` : '—'}
                    </td>
                    <td className="text-right px-4 py-3 text-green-400">{formatCurrency(totals.net)}</td>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3" />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Deductions List Panel ── */}
        {showDeductionList && (
          <div className="mt-6 bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
              <h3 className="text-white font-medium">Active Deductions</h3>
              <button
                onClick={() => openAddDeduction()}
                className="bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded text-xs font-medium"
              >
                + Add Deduction
              </button>
            </div>

            {deductions.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500">
                No active deductions. Click &quot;+ Add Deduction&quot; to create one.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-700 bg-gray-800/50">
                    <th className="text-left text-gray-400 font-medium px-4 py-2">Driver</th>
                    <th className="text-left text-gray-400 font-medium px-4 py-2">Reason</th>
                    <th className="text-center text-gray-400 font-medium px-4 py-2">Type</th>
                    <th className="text-center text-gray-400 font-medium px-4 py-2">Starts</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-2">Per Period</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-2">Total Owed</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-2">Collected</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-2">Remaining</th>
                    <th className="text-center text-gray-400 font-medium px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {deductions.map(ded => {
                    const remaining = ded.totalOwed - ded.totalCollected;
                    const effectiveStr = ded.effectiveDate
                      ? (ded.effectiveDate?.toDate?.() || new Date(ded.effectiveDate)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      : null;
                    return (
                      <tr key={ded.id} className="border-b border-gray-700/30 hover:bg-gray-700/20">
                        <td className="px-4 py-2 text-white">{ded.driverName}</td>
                        <td className="px-4 py-2 text-gray-300">
                          {ded.reason}
                          {ded.notes && (
                            <span className="text-gray-500 text-xs ml-2" title={ded.notes}>
                              ({ded.notes})
                            </span>
                          )}
                        </td>
                        <td className="text-center px-4 py-2">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            ded.deductionType === 'one_time'
                              ? 'bg-yellow-600/20 text-yellow-400'
                              : 'bg-orange-600/20 text-orange-400'
                          }`}>
                            {ded.deductionType === 'one_time' ? 'One-Time' : `Recurring (${ded.frequency})`}
                          </span>
                        </td>
                        <td className="text-center px-4 py-2 text-gray-400 text-xs">
                          {effectiveStr || '—'}
                        </td>
                        <td className="text-right px-4 py-2 text-gray-300">
                          {ded.amountType === 'percentage'
                            ? `${ded.amountPerPeriod}%`
                            : formatCurrency(ded.amountPerPeriod)}
                        </td>
                        <td className="text-right px-4 py-2 text-gray-300">
                          {formatCurrency(ded.totalOwed)}
                        </td>
                        <td className="text-right px-4 py-2 text-green-400">
                          {formatCurrency(ded.totalCollected)}
                        </td>
                        <td className="text-right px-4 py-2 text-red-400 font-medium">
                          {formatCurrency(remaining)}
                        </td>
                        <td className="text-center px-4 py-2">
                          <button
                            onClick={() => handleRemoveDeduction(ded.id)}
                            className="text-red-400 hover:text-red-300 text-xs"
                            title="Remove deduction"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── Additions (Bonuses) List Panel ── */}
        {showAdditionList && (
          <div className="mt-6 bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
              <h3 className="text-white font-medium">Active Bonuses &amp; Reimbursements</h3>
              <button
                onClick={() => openAddAddition()}
                className="bg-green-600 hover:bg-green-500 text-white px-3 py-1.5 rounded text-xs font-medium"
              >
                + Add Bonus
              </button>
            </div>

            {additions.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500">
                No active bonuses or reimbursements. Click &quot;+ Add Bonus&quot; to create one.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-700 bg-gray-800/50">
                    <th className="text-left text-gray-400 font-medium px-4 py-2">Driver</th>
                    <th className="text-left text-gray-400 font-medium px-4 py-2">Reason</th>
                    <th className="text-center text-gray-400 font-medium px-4 py-2">Type</th>
                    <th className="text-center text-gray-400 font-medium px-4 py-2">Starts</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-2">Per Period</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-2">Total Owed</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-2">Paid</th>
                    <th className="text-right text-gray-400 font-medium px-4 py-2">Remaining</th>
                    <th className="text-center text-gray-400 font-medium px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {additions.map(add => {
                    const remaining = add.totalOwed - add.totalPaid;
                    const effectiveStr = add.effectiveDate
                      ? (add.effectiveDate?.toDate?.() || new Date(add.effectiveDate)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      : null;
                    return (
                      <tr key={add.id} className="border-b border-gray-700/30 hover:bg-gray-700/20">
                        <td className="px-4 py-2 text-white">{add.driverName}</td>
                        <td className="px-4 py-2 text-gray-300">
                          {add.reason}
                          {add.notes && (
                            <span className="text-gray-500 text-xs ml-2" title={add.notes}>
                              ({add.notes})
                            </span>
                          )}
                        </td>
                        <td className="text-center px-4 py-2">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            add.additionType === 'one_time'
                              ? 'bg-green-600/20 text-green-400'
                              : 'bg-emerald-600/20 text-emerald-400'
                          }`}>
                            {add.additionType === 'one_time' ? 'One-Time' : `Recurring (${add.frequency})`}
                          </span>
                        </td>
                        <td className="text-center px-4 py-2 text-gray-400 text-xs">
                          {effectiveStr || '—'}
                        </td>
                        <td className="text-right px-4 py-2 text-gray-300">
                          {add.amountType === 'percentage'
                            ? `${add.amountPerPeriod}%`
                            : formatCurrency(add.amountPerPeriod)}
                        </td>
                        <td className="text-right px-4 py-2 text-gray-300">
                          {formatCurrency(add.totalOwed)}
                        </td>
                        <td className="text-right px-4 py-2 text-green-400">
                          {formatCurrency(add.totalPaid)}
                        </td>
                        <td className="text-right px-4 py-2 text-green-400 font-medium">
                          {formatCurrency(remaining)}
                        </td>
                        <td className="text-center px-4 py-2">
                          <button
                            onClick={() => handleRemoveAddition(add.id)}
                            className="text-red-400 hover:text-red-300 text-xs"
                            title="Remove bonus"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </main>

      {/* ── Add Deduction Modal ── */}
      {showDeductionModal && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-4">Add Deduction</h3>

            <div className="space-y-4">
              {/* Driver */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">Driver</label>
                <select
                  value={dedDriver}
                  onChange={e => setDedDriver(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                >
                  <option value="">Select driver...</option>
                  {driverNames.map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>

              {/* Reason */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">Reason</label>
                <select
                  value={dedReason}
                  onChange={e => setDedReason(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                >
                  <option value="">Select reason...</option>
                  {DEDUCTION_PRESETS.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                {dedReason === 'Other' && (
                  <input
                    type="text"
                    value={dedCustomReason}
                    onChange={e => setDedCustomReason(e.target.value)}
                    placeholder="Describe the deduction..."
                    className="w-full mt-2 px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                  />
                )}
              </div>

              {/* Type */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">Deduction Type</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setDedType('one_time')}
                    className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
                      dedType === 'one_time'
                        ? 'bg-yellow-600 text-white'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    One-Time
                  </button>
                  <button
                    onClick={() => setDedType('recurring')}
                    className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
                      dedType === 'recurring'
                        ? 'bg-orange-600 text-white'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    Recurring
                  </button>
                </div>
              </div>

              {/* Frequency (recurring only) */}
              {dedType === 'recurring' && (
                <div>
                  <label className="block text-gray-400 text-xs mb-1">Frequency</label>
                  <select
                    value={dedFrequency}
                    onChange={e => setDedFrequency(e.target.value as DeductionFrequency)}
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                  >
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Bi-Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
              )}

              {/* Starting Date */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">
                  Starting On {dedType === 'one_time' ? '(optional)' : ''}
                </label>
                <input
                  type="date"
                  value={dedStartDate}
                  onChange={e => setDedStartDate(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                />
                <p className="text-gray-500 text-xs mt-1">
                  {dedType === 'recurring'
                    ? `Won't apply to pay periods ending before this date.${dedFrequency === 'biweekly' ? ' Bi-weekly cadence starts from this date.' : ''}`
                    : 'Leave blank to apply immediately, or set a future date.'}
                </p>
              </div>

              {/* Amount */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">
                  {dedType === 'one_time' ? 'Amount' : 'Amount Per Period'}
                </label>
                <div className="flex gap-2">
                  <select
                    value={dedAmountType}
                    onChange={e => setDedAmountType(e.target.value as AmountType)}
                    className="w-24 px-2 py-2 bg-gray-700 text-white rounded text-sm"
                  >
                    <option value="flat">$ Flat</option>
                    <option value="percentage">%</option>
                  </select>
                  <div className="relative flex-1">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                      {dedAmountType === 'flat' ? '$' : '%'}
                    </span>
                    <input
                      type="number"
                      step={dedAmountType === 'flat' ? '0.01' : '1'}
                      min="0"
                      value={dedAmount}
                      onChange={e => setDedAmount(e.target.value)}
                      className="w-full pl-7 pr-2 py-2 bg-gray-700 text-white rounded text-sm"
                      placeholder="0.00"
                    />
                  </div>
                </div>
              </div>

              {/* Total Owed (recurring only) */}
              {dedType === 'recurring' && (
                <div>
                  <label className="block text-gray-400 text-xs mb-1">Total Amount Owed</label>
                  <div className="relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={dedTotal}
                      onChange={e => setDedTotal(e.target.value)}
                      className="w-full pl-7 pr-2 py-2 bg-gray-700 text-white rounded text-sm"
                      placeholder="Total to collect over time"
                    />
                  </div>
                  <p className="text-gray-500 text-xs mt-1">
                    Deduction stops automatically when this amount is fully collected.
                  </p>
                </div>
              )}

              {/* Notes */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">Notes (optional)</label>
                <input
                  type="text"
                  value={dedNotes}
                  onChange={e => setDedNotes(e.target.value)}
                  placeholder="e.g., Got stuck on Hwy 2 without chains"
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                />
              </div>
            </div>

            <div className="flex gap-2 mt-6">
              <button
                onClick={handleSaveDeduction}
                disabled={dedSaving || !dedDriver || !dedReason || !dedAmount}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {dedSaving ? 'Saving...' : 'Add Deduction'}
              </button>
              <button
                onClick={() => { setShowDeductionModal(false); resetDeductionForm(); }}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Bonus/Reimbursement Modal ── */}
      {showAdditionModal && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-4">Add Bonus / Reimbursement</h3>

            <div className="space-y-4">
              {/* Driver */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">Driver</label>
                <select
                  value={addDriver}
                  onChange={e => setAddDriver(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                >
                  <option value="">Select driver...</option>
                  {driverNames.map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>

              {/* Reason */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">Reason</label>
                <select
                  value={addReason}
                  onChange={e => setAddReason(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                >
                  <option value="">Select reason...</option>
                  {BONUS_PRESETS.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                {addReason === 'Other' && (
                  <input
                    type="text"
                    value={addCustomReason}
                    onChange={e => setAddCustomReason(e.target.value)}
                    placeholder="Describe the bonus/reimbursement..."
                    className="w-full mt-2 px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                  />
                )}
              </div>

              {/* Type */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">Type</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setAddType('one_time')}
                    className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
                      addType === 'one_time'
                        ? 'bg-green-600 text-white'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    One-Time
                  </button>
                  <button
                    onClick={() => setAddType('recurring')}
                    className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
                      addType === 'recurring'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    Recurring
                  </button>
                </div>
              </div>

              {/* Frequency (recurring only) */}
              {addType === 'recurring' && (
                <div>
                  <label className="block text-gray-400 text-xs mb-1">Frequency</label>
                  <select
                    value={addFrequency}
                    onChange={e => setAddFrequency(e.target.value as DeductionFrequency)}
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                  >
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Bi-Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
              )}

              {/* Starting Date */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">
                  Starting On {addType === 'one_time' ? '(optional)' : ''}
                </label>
                <input
                  type="date"
                  value={addStartDate}
                  onChange={e => setAddStartDate(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                />
                <p className="text-gray-500 text-xs mt-1">
                  {addType === 'recurring'
                    ? `Won't apply to pay periods ending before this date.${addFrequency === 'biweekly' ? ' Bi-weekly cadence starts from this date.' : ''}`
                    : 'Leave blank to apply immediately, or set a future date.'}
                </p>
              </div>

              {/* Amount */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">
                  {addType === 'one_time' ? 'Amount' : 'Amount Per Period'}
                </label>
                <div className="flex gap-2">
                  <select
                    value={addAmountType}
                    onChange={e => setAddAmountType(e.target.value as AmountType)}
                    className="w-24 px-2 py-2 bg-gray-700 text-white rounded text-sm"
                  >
                    <option value="flat">$ Flat</option>
                    <option value="percentage">%</option>
                  </select>
                  <div className="relative flex-1">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                      {addAmountType === 'flat' ? '$' : '%'}
                    </span>
                    <input
                      type="number"
                      step={addAmountType === 'flat' ? '0.01' : '1'}
                      min="0"
                      value={addAmount}
                      onChange={e => setAddAmount(e.target.value)}
                      className="w-full pl-7 pr-2 py-2 bg-gray-700 text-white rounded text-sm"
                      placeholder="0.00"
                    />
                  </div>
                </div>
              </div>

              {/* Total Amount (recurring only) */}
              {addType === 'recurring' && (
                <div>
                  <label className="block text-gray-400 text-xs mb-1">Total Amount</label>
                  <div className="relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={addTotal}
                      onChange={e => setAddTotal(e.target.value)}
                      className="w-full pl-7 pr-2 py-2 bg-gray-700 text-white rounded text-sm"
                      placeholder="Total to pay out over time"
                    />
                  </div>
                  <p className="text-gray-500 text-xs mt-1">
                    Bonus stops automatically when this amount is fully paid.
                  </p>
                </div>
              )}

              {/* Notes */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">Notes (optional)</label>
                <input
                  type="text"
                  value={addNotes}
                  onChange={e => setAddNotes(e.target.value)}
                  placeholder="e.g., 90-day sign-on bonus"
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                />
              </div>
            </div>

            <div className="flex gap-2 mt-6">
              <button
                onClick={handleSaveAddition}
                disabled={addSaving || !addDriver || !addReason || !addAmount}
                className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {addSaving ? 'Saving...' : 'Add Bonus'}
              </button>
              <button
                onClick={() => { setShowAdditionModal(false); resetAdditionForm(); }}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Driver Row + Expandable Detail ──────────────────────────────────────────

function DriverRow({
  summary,
  badge,
  isExpanded,
  onToggle,
  legalNameMap = {},
}: {
  summary: DriverTimesheetSummary;
  badge: { label: string; color: string };
  isExpanded: boolean;
  onToggle: () => void;
  legalNameMap?: Record<string, string>;
}) {
  return (
    <>
      {/* Summary Row */}
      <tr
        className="border-b border-gray-700/50 hover:bg-gray-700/30 cursor-pointer transition-colors"
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <div className="text-white font-medium">{legalNameMap[summary.driverName] || summary.driverName}</div>
          {legalNameMap[summary.driverName] && legalNameMap[summary.driverName] !== summary.driverName && (
            <div className="text-gray-500 text-xs">{summary.driverName}</div>
          )}
          {summary.truckNumber && (
            <div className="text-gray-500 text-xs">Truck {summary.truckNumber}</div>
          )}
        </td>
        <td className="text-right px-4 py-3 text-gray-300">{summary.totalLoads}</td>
        <td className="text-right px-4 py-3 text-gray-300">{summary.totalHours.toFixed(2)}</td>
        <td className="text-right px-4 py-3 text-gray-300">{summary.totalBBLs.toLocaleString()}</td>
        <td className="text-right px-4 py-3 text-gray-300">
          {summary.grossBilled > 0 ? formatCurrency(summary.grossBilled) : '—'}
        </td>
        <td className="text-right px-4 py-3 text-gray-300">
          {summary.employeePay > 0 ? formatCurrency(summary.employeePay) : '—'}
        </td>
        <td className="text-right px-4 py-3 text-green-400">
          {summary.additions > 0 ? `+${formatCurrency(summary.additions)}` : '—'}
        </td>
        <td className="text-right px-4 py-3 text-red-400">
          {summary.deductions > 0 ? `-${formatCurrency(summary.deductions)}` : '—'}
        </td>
        <td className="text-right px-4 py-3 text-green-400 font-medium">
          {summary.netPay > 0 ? formatCurrency(summary.netPay) : '—'}
        </td>
        <td className="text-center px-4 py-3">
          <span className={`px-2 py-1 rounded-full text-xs font-medium ${badge.color}`}>
            {badge.label}
          </span>
        </td>
        <td className="text-center px-4 py-3 text-gray-500">
          {isExpanded ? '▲' : '▼'}
        </td>
      </tr>

      {/* Expanded Detail — Individual Timesheet */}
      {isExpanded && (
        <tr>
          <td colSpan={11} className="p-0">
            <DriverTimesheetDetail summary={summary} legalNameMap={legalNameMap} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Individual Driver Timesheet Detail ──────────────────────────────────────

function DriverTimesheetDetail({ summary, legalNameMap = {} }: { summary: DriverTimesheetSummary; legalNameMap?: Record<string, string> }) {
  return (
    <div className="bg-gray-900/50 border-t border-gray-700 px-6 py-4">
      {/* Driver Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-bold text-white">{legalNameMap[summary.driverName] || summary.driverName}</h3>
          {legalNameMap[summary.driverName] && legalNameMap[summary.driverName] !== summary.driverName && (
            <p className="text-gray-500 text-xs">Login: {summary.driverName}</p>
          )}
          <p className="text-gray-400 text-sm">
            {summary.totalLoads} loads &middot; {summary.totalBBLs.toLocaleString()} BBL
            {summary.totalHours > 0 && ` · ${summary.totalHours.toFixed(2)} hrs`}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-xs font-medium transition-colors">
            Send to Driver
          </button>
          <button className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded text-xs font-medium transition-colors">
            Export PDF
          </button>
          <button className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded text-xs font-medium transition-colors">
            Export CSV
          </button>
        </div>
      </div>

      {/* Timesheet Table */}
      {(() => { const hasDetention = summary.rows.some(r => r.detentionPay > 0); return (
      <div className="overflow-x-auto rounded-lg border border-gray-700">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800 border-b border-gray-700">
              <th className="text-left text-gray-400 font-medium px-3 py-2">Date</th>
              <th className="text-left text-gray-400 font-medium px-3 py-2">Invoice #</th>
              <th className="text-left text-gray-400 font-medium px-3 py-2">Company</th>
              <th className="text-left text-gray-400 font-medium px-3 py-2">Product</th>
              <th className="text-right text-gray-400 font-medium px-3 py-2">Qty (BBL)</th>
              <th className="text-right text-gray-400 font-medium px-3 py-2">Time (hrs)</th>
              <th className="text-right text-gray-400 font-medium px-3 py-2">Rate</th>
              <th className="text-right text-gray-400 font-medium px-3 py-2">Amount Billed</th>
              {hasDetention && <th className="text-right text-gray-400 font-medium px-3 py-2">Detention</th>}
              <th className="text-right text-gray-400 font-medium px-3 py-2">Employee Take</th>
              <th className="text-center text-gray-400 font-medium px-3 py-2">Flag</th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.map(row => (
              <TimesheetRow key={row.id} row={row} showDetention={hasDetention} />
            ))}

            {/* Subtotal */}
            <tr className="border-t border-gray-600 bg-gray-800/50 font-bold">
              <td colSpan={4} className="px-3 py-2 text-white">TOTAL</td>
              <td className="text-right px-3 py-2 text-white">
                {summary.totalBBLs.toLocaleString()}
              </td>
              <td className="text-right px-3 py-2 text-white">
                {summary.totalHours > 0 ? summary.totalHours.toFixed(2) : ''}
              </td>
              <td className="px-3 py-2" />
              <td className="text-right px-3 py-2 text-white">
                {summary.grossBilled > 0 ? formatCurrency(summary.grossBilled) : '—'}
              </td>
              {hasDetention && (
                <td className="text-right px-3 py-2 text-orange-400">
                  {formatCurrency(summary.rows.reduce((s, r) => s + r.detentionPay, 0))}
                </td>
              )}
              <td className="text-right px-3 py-2 text-green-400">
                {summary.employeePay > 0 ? formatCurrency(summary.employeePay) : '—'}
              </td>
              <td className="px-3 py-2" />
            </tr>

            {/* Bonuses row */}
            {summary.additions > 0 && (
              <tr className="bg-gray-800/30">
                <td colSpan={hasDetention ? 9 : 8} className="px-3 py-2 text-gray-400 text-right">Bonuses / Reimbursements</td>
                <td className="text-right px-3 py-2 text-green-400 font-medium">
                  +{formatCurrency(summary.additions)}
                </td>
                <td className="px-3 py-2" />
              </tr>
            )}

            {/* Deductions row */}
            {summary.deductions > 0 && (
              <tr className="bg-gray-800/30">
                <td colSpan={hasDetention ? 9 : 8} className="px-3 py-2 text-gray-400 text-right">Deductions</td>
                <td className="text-right px-3 py-2 text-red-400 font-medium">
                  -{formatCurrency(summary.deductions)}
                </td>
                <td className="px-3 py-2" />
              </tr>
            )}

            {/* Net Pay row */}
            {(summary.grossBilled > 0 || summary.deductions > 0 || summary.additions > 0) && (
              <tr className="bg-gray-800/30 border-t border-gray-700">
                <td colSpan={hasDetention ? 9 : 8} className="px-3 py-2 text-white text-right font-bold">Net Pay</td>
                <td className="text-right px-3 py-2 text-green-400 font-bold text-base">
                  {formatCurrency(summary.netPay)}
                </td>
                <td className="px-3 py-2" />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      ); })()}
    </div>
  );
}

// ─── Individual Timesheet Row ────────────────────────────────────────────────

function TimesheetRow({ row, showDetention }: { row: DriverTimesheetRow; showDetention: boolean }) {
  return (
    <tr className="border-b border-gray-700/30 hover:bg-gray-800/30 transition-colors">
      <td className="px-3 py-2 text-gray-300">{row.date}</td>
      <td className="px-3 py-2 text-gray-300">{row.invoiceNumber}</td>
      <td className="px-3 py-2 text-gray-300">{row.operator}</td>
      <td className="px-3 py-2 text-gray-300">{row.jobType}</td>
      <td className="text-right px-3 py-2 text-gray-300">{row.bbls || ''}</td>
      <td className="text-right px-3 py-2 text-gray-300">{row.hours || ''}</td>
      <td className="text-right px-3 py-2 text-gray-300">
        {row.rate > 0 ? formatCurrency(row.rate) : '—'}
      </td>
      <td className="text-right px-3 py-2 text-gray-300">
        {row.amountBilled > 0 ? formatCurrency(row.amountBilled) : '—'}
      </td>
      {showDetention && (
        <td className="text-right px-3 py-2 text-orange-400">
          {row.detentionPay > 0 ? formatCurrency(row.detentionPay) : '—'}
        </td>
      )}
      <td className="text-right px-3 py-2 text-gray-300">
        {row.employeeTake > 0 ? formatCurrency(row.employeeTake) : '—'}
      </td>
      <td className="text-center px-3 py-2">
        {row.flagged ? (
          <span className="text-red-400 cursor-pointer" title={row.flagNote || 'Flagged'}>
            ⚑
          </span>
        ) : (
          <span className="text-gray-600 hover:text-yellow-400 cursor-pointer" title="Flag this row">
            ⚐
          </span>
        )}
      </td>
    </tr>
  );
}
