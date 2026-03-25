'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { loadAllCompanies, updateCompanyFields, type CompanyConfig, type DoeRegion, DOE_REGIONS, STATE_TO_PADD } from '@/lib/companySettings';
import { ref, get } from 'firebase/database';
import { getFirebaseDatabase } from '@/lib/firebase';
import { Timestamp } from 'firebase/firestore';
import {
  type InvoiceGrouping,
  type ExportFormat,
  EXPORT_FORMATS,
  groupInvoiceData,
  getNextInvoiceNumbers,
  generateInvoicePDF,
  generateInvoiceCSV,
  generateQuickBooksCSV,
  generateInvoiceJSON,
  downloadBlob,
  saveBillingExport,
  fetchRecentExports,
  getExportFilename,
  loadRealWellNames,
  filterTestWells,
  type BillingExportRecord,
} from '@/lib/billingExport';
import {
  fetchBillingData,
  fetchBillingRecords,
  generateBillingRecord,
  updateBillingStatus,
  saveDieselPrice,
  fetchDieselPriceHistory,
  deleteDieselPrice,
  fetchEiaDieselPrice,
  calculateFuelSurcharge,
  getFuelSurchargeLabel,
  getFuelSurchargeRate,
  getBillingStatusColor,
  getPayPeriods,
  formatCurrency,
  formatPeriodRange,
  type OperatorBillingSummary,
  type BillingRecord,
  type BillingStatus,
  type DieselPriceEntry,
  type PayPeriod,
} from '@/lib/billing';

type SubTab = 'receivables' | 'fuel' | 'export';

export default function BillingPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Sub-tab
  const [activeTab, setActiveTab] = useState<SubTab>('receivables');

  // Shared state
  const [companies, setCompanies] = useState<Map<string, CompanyConfig>>(new Map());
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [periods] = useState(() => getPayPeriods());
  const [selectedPeriod, setSelectedPeriod] = useState<PayPeriod>(() => getPayPeriods()[0]);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Receivables state
  const [summaries, setSummaries] = useState<OperatorBillingSummary[]>([]);
  const [billingRecords, setBillingRecords] = useState<BillingRecord[]>([]);
  const [expandedOp, setExpandedOp] = useState<string | null>(null);
  const [expandedBill, setExpandedBill] = useState<string | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);

  // Payment modal
  const [paymentModal, setPaymentModal] = useState<BillingRecord | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');

  // Fuel prices state
  const [dieselHistory, setDieselHistory] = useState<DieselPriceEntry[]>([]);
  const [newPrice, setNewPrice] = useState('');
  const [priceSource, setPriceSource] = useState('DOE/EIA');
  const [savingPrice, setSavingPrice] = useState(false);
  const [fetchingEia, setFetchingEia] = useState(false);
  const [eiaResult, setEiaResult] = useState<string | null>(null);
  const [eiaDate, setEiaDate] = useState<string>(() => new Date().toISOString().split('T')[0]);

  // Export state
  const [exportOperator, setExportOperator] = useState<string | null>(null);
  const [exportGrouping, setExportGrouping] = useState<InvoiceGrouping>('well_day');
  const [exportLoading, setExportLoading] = useState(false);
  const [recentExports, setRecentExports] = useState<BillingExportRecord[]>([]);
  const [exportPeriodType, setExportPeriodType] = useState<string>('this-week');
  const [exportDateFrom, setExportDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1)); return d.toISOString().slice(0, 10);
  });
  const [exportDateTo, setExportDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [exportSummaries, setExportSummaries] = useState<OperatorBillingSummary[]>([]);
  const [exportDataLoading, setExportDataLoading] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf');
  const [excludeTestWells, setExcludeTestWells] = useState(true);
  const [realWellNames, setRealWellNames] = useState<Set<string> | null>(null);

  // Driver name resolution
  const [legalNameMap, setLegalNameMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!loading && !user) router.push('/login');
  }, [user, loading, router]);

  // Load companies once
  useEffect(() => {
    if (!user) return;
    loadAllCompanies().then(list => {
      const map = new Map<string, CompanyConfig>();
      list.forEach(c => map.set(c.id, c));
      setCompanies(map);
      // WB admin: auto-select first company if none chosen
      if (!user.companyId && !selectedCompanyId && list.length > 0) {
        setSelectedCompanyId(list[0].id);
      }
    });
  }, [user]);

  // Load driver name map for display name → legal name resolution
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const db = getFirebaseDatabase();
        const snapshot = await get(ref(db, 'drivers/approved'));
        if (!snapshot.exists()) return;
        const legalMap: Record<string, string> = {};
        snapshot.forEach(child => {
          const data = child.val();
          if (data?.displayName) {
            const legal = data.legalName || data.profile?.legalName;
            if (legal) legalMap[data.displayName] = legal;
          }
        });
        setLegalNameMap(legalMap);
      } catch (err) {
        console.error('Failed to load driver names:', err);
      }
    })();
  }, [user]);

  // Load data when period changes or companies load
  useEffect(() => {
    if (!user || companies.size === 0) return;
    loadData();
  }, [user, companies, selectedPeriod, selectedCompanyId]);

  const loadData = async () => {
    try {
      setDataLoading(true);
      setError(null);
      const companyId = effectiveCompanyId || undefined;
      // Build well→county map for frost rate lookup (same as payroll)
      const allOperators = new Set<string>();
      companies.forEach(c => c.assignedOperators?.forEach(op => allOperators.add(op)));
      const { buildWellCountyMap } = await import('@/lib/payroll');
      const countyMap = await buildWellCountyMap([...allOperators]);
      const [sums, records] = await Promise.all([
        fetchBillingData(selectedPeriod, companies, companyId, countyMap),
        fetchBillingRecords(selectedPeriod, companyId),
      ]);
      setSummaries(sums);
      setBillingRecords(records);
    } catch (err: any) {
      console.error('Failed to load billing data:', err);
      setError(err?.message || 'Failed to load billing data');
    } finally {
      setDataLoading(false);
    }
  };

  const loadFuelPrices = async () => {
    try {
      const history = await fetchDieselPriceHistory(effectiveCompanyId || undefined);
      setDieselHistory(history);
    } catch (err: any) {
      console.error('Failed to load diesel prices:', err);
    }
  };

  useEffect(() => {
    if (activeTab === 'fuel' && user) loadFuelPrices();
  }, [activeTab, user, selectedCompanyId]);

  const handleGenerateBill = async (summary: OperatorBillingSummary) => {
    if (!user) return;
    const companyId = summary.companyId || user.companyId || '';
    if (!companyId) return;
    try {
      setGenerating(summary.operator);
      await generateBillingRecord(summary, selectedPeriod, companyId);
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Failed to generate bill');
    } finally {
      setGenerating(null);
    }
  };

  const handleMarkSent = async (record: BillingRecord) => {
    try {
      await updateBillingStatus(record.id, 'sent');
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Failed to update status');
    }
  };

  const handleRecordPayment = async () => {
    if (!paymentModal) return;
    const amount = parseFloat(paymentAmount);
    if (isNaN(amount) || amount <= 0) return;
    try {
      const totalPaid = paymentModal.amountPaid + amount;
      const status: BillingStatus = totalPaid >= paymentModal.grandTotal ? 'paid' : 'partial';
      await updateBillingStatus(paymentModal.id, status, totalPaid);
      setPaymentModal(null);
      setPaymentAmount('');
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Failed to record payment');
    }
  };

  const handleSavePrice = async () => {
    const price = parseFloat(newPrice);
    if (isNaN(price) || price <= 0) return;
    if (!effectiveCompanyId) {
      setError('No company selected');
      return;
    }
    try {
      setSavingPrice(true);
      // Pass the effective date so the price aligns with the correct billing period
      await saveDieselPrice(effectiveCompanyId, price, priceSource, user?.displayName || 'Admin', eiaDate);
      setNewPrice('');
      setEiaDate(new Date().toISOString().split('T')[0]); // Reset to today
      await loadFuelPrices();
      // Refresh companies to get updated currentDieselPrice
      const list = await loadAllCompanies();
      const map = new Map<string, CompanyConfig>();
      list.forEach(c => map.set(c.id, c));
      setCompanies(map);
    } catch (err: any) {
      setError(err?.message || 'Failed to save price');
    } finally {
      setSavingPrice(false);
    }
  };

  // Effective company ID: hauler admin uses their own, WB admin uses picker
  const effectiveCompanyId = user?.companyId || selectedCompanyId || null;

  // Get current diesel price + DOE region for display
  const companyConfig = effectiveCompanyId ? companies.get(effectiveCompanyId) : undefined;
  const currentDiesel = companyConfig?.currentDieselPrice;
  const currentRegion = companyConfig?.doeRegion
    || (companyConfig?.state ? STATE_TO_PADD[companyConfig.state.toUpperCase()] : undefined)
    || 'us';
  const regionLabel = DOE_REGIONS.find(r => r.value === currentRegion)?.label || 'U.S. Average';

  // First DOE-based operator config — used for FSC rate column in price history
  const historyFscConfig = (() => {
    const bc = companyConfig?.billingConfig;
    if (!bc) return undefined;
    return Object.values(bc).find(c =>
      c.fuelSurchargeMethod === 'flat_doe' || c.fuelSurchargeMethod === 'hourly' || c.fuelSurchargeMethod === 'per_mile'
    );
  })();

  // Load recent exports + real well names when Export tab opened
  useEffect(() => {
    if (activeTab === 'export' && effectiveCompanyId) {
      fetchRecentExports(effectiveCompanyId).then(setRecentExports).catch(() => {});
      if (!realWellNames) loadRealWellNames().then(setRealWellNames).catch(() => {});
    }
  }, [activeTab, effectiveCompanyId]);

  // Load export data independently when export dates change
  useEffect(() => {
    if (activeTab !== 'export' || !effectiveCompanyId || companies.size === 0) return;
    const from = new Date(exportDateFrom); from.setHours(0, 0, 0, 0);
    const to = new Date(exportDateTo); to.setHours(23, 59, 59, 999);
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) return;
    const exportPeriod: PayPeriod = { type: 'custom' as any, start: from, end: to, label: '' };
    setExportDataLoading(true);
    // Build county map for frost rates
    const allOps = new Set<string>();
    companies.forEach(c => c.assignedOperators?.forEach(op => allOps.add(op)));
    import('@/lib/payroll').then(({ buildWellCountyMap }) =>
      buildWellCountyMap([...allOps]).then(cm =>
        fetchBillingData(exportPeriod, companies, effectiveCompanyId, cm)
      )
    ).then(setExportSummaries)
      .catch(() => setExportSummaries([]))
      .finally(() => setExportDataLoading(false));
  }, [activeTab, exportDateFrom, exportDateTo, effectiveCompanyId, companies]);

  const handleRegionChange = async (region: DoeRegion) => {
    if (!effectiveCompanyId) return;
    try {
      await updateCompanyFields(effectiveCompanyId, { doeRegion: region });
      const list = await loadAllCompanies();
      const map = new Map<string, CompanyConfig>();
      list.forEach(c => map.set(c.id, c));
      setCompanies(map);
    } catch (err) {
      console.error('Failed to save DOE region:', err);
    }
  };

  const handleFetchEia = async () => {
    try {
      setFetchingEia(true);
      setEiaResult(null);
      const results = await fetchEiaDieselPrice(currentRegion);
      const result = results[0];
      setNewPrice(result.price.toFixed(3));
      setPriceSource('EIA API');
      setEiaDate(result.date); // Auto-fill effective date to EIA period date
      setEiaResult(`Fetched $${result.price.toFixed(3)}/gal for ${result.region} (week of ${result.date})`);
    } catch (err: any) {
      setEiaResult(`Error: ${err?.message || 'Failed to fetch from EIA'}`);
    } finally {
      setFetchingEia(false);
    }
  };

  const handleBackfillHistory = async () => {
    if (!effectiveCompanyId) return;
    try {
      setFetchingEia(true);
      setEiaResult(null);
      const results = await fetchEiaDieselPrice(currentRegion, 12);
      let saved = 0;
      // Save each week's price with its correct EIA date (oldest first)
      for (const r of results.reverse()) {
        await saveDieselPrice(effectiveCompanyId, r.price, 'EIA Backfill', user?.displayName || 'Admin', r.date);
        saved++;
      }
      setEiaResult(`Backfilled ${saved} weeks of diesel prices from EIA`);
      await loadFuelPrices();
      // Refresh billing data too
      if (companies.size > 0) {
        const allOps2 = new Set<string>();
        companies.forEach(c => c.assignedOperators?.forEach(op => allOps2.add(op)));
        const { buildWellCountyMap: buildMap } = await import('@/lib/payroll');
        const cm2 = await buildMap([...allOps2]);
        const data = await fetchBillingData(selectedPeriod, companies, effectiveCompanyId, cm2);
        setSummaries(data);
      }
    } catch (err: any) {
      setEiaResult(`Error: ${err?.message || 'Backfill failed'}`);
    } finally {
      setFetchingEia(false);
    }
  };

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
        {/* Title + Sub-tabs */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <div className="flex items-center gap-4">
            <img src="/billing-icon.png" alt="WB Billing" className="w-28 h-28" />
            <h2 className="text-xl font-semibold text-white">Billing</h2>
            <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
              <button
                onClick={() => setActiveTab('receivables')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  activeTab === 'receivables'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                Receivables
              </button>
              <button
                onClick={() => setActiveTab('fuel')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  activeTab === 'fuel'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                Fuel Prices
              </button>
              <button
                onClick={() => setActiveTab('export')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  activeTab === 'export'
                    ? 'bg-green-600 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                Export
              </button>
            </div>
            {/* WB admin company picker */}
            {!user.companyId && companies.size > 0 && (
              <select
                value={selectedCompanyId || ''}
                onChange={(e) => setSelectedCompanyId(e.target.value)}
                className="px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
              >
                {Array.from(companies.values()).map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
          </div>

          {activeTab === 'receivables' && (
            <div className="flex items-center gap-4">
              <select
                value={selectedPeriod.type}
                onChange={(e) => {
                  const p = periods.find(p => p.type === e.target.value);
                  if (p) setSelectedPeriod(p);
                }}
                className="px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
              >
                {periods.map(p => (
                  <option key={p.type} value={p.type}>{p.label}</option>
                ))}
              </select>
              <button
                onClick={loadData}
                disabled={dataLoading}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors text-sm disabled:opacity-50"
              >
                Refresh
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/50 text-red-200 rounded-lg">{error}</div>
        )}

        {/* ─── Receivables Tab ─── */}
        {activeTab === 'receivables' && (
          <>
            {/* Warn if no diesel price set but DOE-based FSC configured */}
            {!currentDiesel && summaries.some(s =>
              s.billingConfig?.fuelSurchargeMethod === 'hourly' ||
              s.billingConfig?.fuelSurchargeMethod === 'per_mile' ||
              s.billingConfig?.fuelSurchargeMethod === 'flat_doe'
            ) && (
              <div className="mb-4 p-3 bg-yellow-900/40 border border-yellow-500/30 text-yellow-200 rounded-lg flex items-center gap-3">
                <span className="text-yellow-400 text-lg">&#9888;</span>
                <div>
                  <span className="font-medium">No diesel price set.</span>{' '}
                  Fuel surcharges show $0.00 because there&apos;s no DOE diesel price saved.
                  Go to <button onClick={() => setActiveTab('fuel')} className="text-blue-400 underline">Fuel Prices</button> → Fetch from EIA → Save Price.
                </div>
              </div>
            )}
            {dataLoading ? (
              <div className="text-gray-400">Loading billing data...</div>
            ) : summaries.length === 0 ? (
              <div className="text-gray-400">No closed invoices found for this period</div>
            ) : (
              <>
                {/* Operator Summary Table */}
                {(() => { const hasDetention = summaries.some(s => s.totalDetentionPay > 0); return (
                <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden mb-8">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-gray-700">
                        <tr>
                          <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Operator</th>
                          <th className="px-4 py-2 text-right text-sm font-medium text-gray-300">Loads</th>
                          <th className="px-4 py-2 text-right text-sm font-medium text-gray-300">BBLs</th>
                          <th className="px-4 py-2 text-right text-sm font-medium text-gray-300">Hours</th>
                          <th className="px-4 py-2 text-right text-sm font-medium text-gray-300">Base Amount</th>
                          <th className="px-4 py-2 text-right text-sm font-medium text-gray-300">Fuel Surcharge</th>
                          {hasDetention && <th className="px-4 py-2 text-right text-sm font-medium text-gray-300">Detention</th>}
                          <th className="px-4 py-2 text-right text-sm font-medium text-gray-300">Total</th>
                          <th className="px-4 py-2 text-right text-sm font-medium text-gray-300">FSC Method</th>
                          <th className="px-4 py-2 text-center text-sm font-medium text-gray-300">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-700">
                        {summaries.map(summary => {
                          const alreadyBilled = billingRecords.some(r => r.operator === summary.operator);
                          return (
                            <OperatorRow
                              key={summary.operator}
                              summary={summary}
                              dieselPrice={summary.dieselPriceUsed ?? currentDiesel}
                              isExpanded={expandedOp === summary.operator}
                              onToggle={() => setExpandedOp(expandedOp === summary.operator ? null : summary.operator)}
                              onGenerate={() => handleGenerateBill(summary)}
                              generating={generating === summary.operator}
                              alreadyBilled={alreadyBilled}
                              showDetention={hasDetention}
                              legalNameMap={legalNameMap}
                            />
                          );
                        })}
                      </tbody>
                      <tfoot className="bg-gray-750 border-t border-gray-600">
                        <tr>
                          <td className="px-4 py-2 text-white font-semibold">Totals</td>
                          <td className="px-4 py-2 text-right text-white font-mono">{summaries.reduce((s, o) => s + o.loads, 0)}</td>
                          <td className="px-4 py-2 text-right text-white font-mono">{summaries.reduce((s, o) => s + o.totalBBLs, 0).toLocaleString()}</td>
                          <td className="px-4 py-2 text-right text-white font-mono">{summaries.reduce((s, o) => s + o.totalHours, 0).toFixed(1)}</td>
                          <td className="px-4 py-2 text-right text-white font-mono">{formatCurrency(summaries.reduce((s, o) => s + o.subtotal, 0))}</td>
                          <td className="px-4 py-2 text-right text-yellow-400 font-mono">{formatCurrency(summaries.reduce((s, o) => s + o.totalFuelSurcharge, 0))}</td>
                          {hasDetention && <td className="px-4 py-2 text-right text-orange-400 font-mono">{formatCurrency(summaries.reduce((s, o) => s + o.totalDetentionPay, 0))}</td>}
                          <td className="px-4 py-2 text-right text-green-400 font-mono font-semibold">{formatCurrency(summaries.reduce((s, o) => s + o.grandTotal, 0))}</td>
                          <td colSpan={2} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
                ); })()}

                {/* Generated Bills */}
                {billingRecords.length > 0 && (
                  <>
                    <h3 className="text-lg font-semibold text-white mb-3">Generated Bills</h3>
                    <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full">
                          <thead className="bg-gray-700">
                            <tr>
                              <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Bill #</th>
                              <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Operator</th>
                              <th className="px-4 py-2 text-right text-sm font-medium text-gray-300">Total</th>
                              <th className="px-4 py-2 text-right text-sm font-medium text-gray-300">Paid</th>
                              <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Terms</th>
                              <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Status</th>
                              <th className="px-4 py-2 text-center text-sm font-medium text-gray-300">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-700">
                            {billingRecords.map(record => (
                              <BillRow
                                key={record.id}
                                record={record}
                                isExpanded={expandedBill === record.id}
                                onToggle={() => setExpandedBill(expandedBill === record.id ? null : record.id)}
                                onMarkSent={() => handleMarkSent(record)}
                                onRecordPayment={() => {
                                  setPaymentModal(record);
                                  setPaymentAmount(String(record.grandTotal - record.amountPaid));
                                }}
                              />
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {/* ─── Fuel Prices Tab ─── */}
        {activeTab === 'fuel' && (
          <div className="space-y-6">
            {/* DOE Region */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
              <h3 className="text-lg font-semibold text-white mb-3">DOE Region</h3>
              <p className="text-gray-500 text-sm mb-3">
                Your region determines which DOE/EIA diesel price column to use.{' '}
                {companyConfig?.state && (
                  <span className="text-gray-400">
                    Auto-detected from company state ({companyConfig.state}): <span className="text-blue-400">{regionLabel}</span>
                  </span>
                )}
              </p>
              <select
                value={currentRegion}
                onChange={e => handleRegionChange(e.target.value as DoeRegion)}
                className="w-full max-w-md px-3 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
              >
                {DOE_REGIONS.map(r => (
                  <option key={r.value} value={r.value}>
                    {r.label} — {r.description}
                  </option>
                ))}
              </select>
            </div>

            {/* Current Price */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Current Diesel Price — {regionLabel}</h3>
              <div className="flex items-baseline gap-2 mb-4">
                <span className="text-4xl font-bold text-green-400">
                  {currentDiesel ? `$${currentDiesel.toFixed(3)}` : '--'}
                </span>
                <span className="text-gray-400">/gallon</span>
              </div>
              <p className="text-gray-500 text-sm mb-4">
                Used for DOE-based fuel surcharge calculations (hourly + per-mile). Update weekly from{' '}
                <a href="https://www.eia.gov/petroleum/gasdiesel/" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                  DOE/EIA weekly diesel prices
                </a>
                {' '}→ look at the <span className="text-blue-400">{regionLabel}</span> row.
              </p>

              {/* Auto-fetch from EIA */}
              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <button
                  onClick={handleFetchEia}
                  disabled={fetchingEia}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors text-sm disabled:opacity-50 flex items-center gap-2"
                >
                  {fetchingEia ? (
                    <>
                      <span className="animate-spin">&#9696;</span>
                      Fetching...
                    </>
                  ) : (
                    <>Fetch from EIA</>
                  )}
                </button>
                <button
                  onClick={handleBackfillHistory}
                  disabled={fetchingEia || !effectiveCompanyId}
                  className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white rounded-lg transition-colors text-sm disabled:opacity-50"
                >
                  Backfill 12 Weeks
                </button>
                {eiaResult && (
                  <span className={`text-sm ${eiaResult.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
                    {eiaResult}
                  </span>
                )}
              </div>

              {/* Manual update form */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input
                    type="number"
                    step="0.001"
                    min="0"
                    value={newPrice}
                    onChange={(e) => setNewPrice(e.target.value)}
                    placeholder="0.000"
                    className="pl-7 pr-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm w-32 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-gray-500 text-xs">Effective</span>
                  <input
                    type="date"
                    value={eiaDate}
                    onChange={(e) => setEiaDate(e.target.value)}
                    className="px-2 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>
                <select
                  value={priceSource}
                  onChange={(e) => setPriceSource(e.target.value)}
                  className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="DOE/EIA">DOE/EIA</option>
                  <option value="EIA API">EIA API</option>
                  <option value="Manual">Manual</option>
                </select>
                <button
                  onClick={handleSavePrice}
                  disabled={savingPrice || !newPrice}
                  className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors text-sm disabled:opacity-50"
                >
                  {savingPrice ? 'Saving...' : 'Save Price'}
                </button>
              </div>
            </div>

            {/* Price History */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-700">
                <h3 className="text-lg font-semibold text-white">Price History</h3>
              </div>
              {dieselHistory.length === 0 ? (
                <div className="p-4 text-gray-400">No price history yet</div>
              ) : (
                <table className="w-full">
                  <thead className="bg-gray-700">
                    <tr>
                      <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Date</th>
                      <th className="px-4 py-2 text-right text-sm font-medium text-gray-300">Price/Gal</th>
                      {historyFscConfig && <th className="px-4 py-2 text-right text-sm font-medium text-gray-300">FSC Rate</th>}
                      <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Source</th>
                      <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Updated By</th>
                      <th className="px-4 py-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700">
                    {dieselHistory.map(entry => {
                      const rateInfo = historyFscConfig ? getFuelSurchargeRate(historyFscConfig, entry.price) : null;
                      return (
                      <tr key={entry.id} className="hover:bg-gray-750">
                        <td className="px-4 py-2 text-white text-sm">{entry.date}</td>
                        <td className="px-4 py-2 text-right text-green-400 font-mono">${entry.price.toFixed(2)}</td>
                        {historyFscConfig && (
                          <td className="px-4 py-2 text-right text-cyan-400 font-mono text-sm">
                            {rateInfo && rateInfo.rate > 0 ? `$${rateInfo.rate.toFixed(2)}${rateInfo.unit}` : '--'}
                          </td>
                        )}
                        <td className="px-4 py-2 text-gray-400 text-sm">{entry.source}</td>
                        <td className="px-4 py-2 text-gray-400 text-sm">{entry.updatedBy}</td>
                        <td className="px-4 py-1">
                          <button
                            onClick={async () => {
                              if (!confirm(`Delete price entry for ${entry.date}?`)) return;
                              await deleteDieselPrice(entry.id);
                              const history = await fetchDieselPriceHistory(effectiveCompanyId || undefined);
                              setDieselHistory(history);
                            }}
                            className="text-red-500 hover:text-red-400 text-xs opacity-40 hover:opacity-100 transition-opacity"
                            title="Delete"
                          >
                            &times;
                          </button>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* ─── Export Tab ─── */}
        {activeTab === 'export' && (
          <div className="space-y-6">
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Generate Invoices</h3>

              {/* Date Range */}
              <div className="mb-4">
                <label className="block text-sm text-gray-400 mb-2">Period</label>
                <div className="flex items-center gap-3 flex-wrap">
                  <select
                    value={exportPeriodType}
                    onChange={(e) => {
                      const v = e.target.value;
                      setExportPeriodType(v);
                      if (v !== 'custom') {
                        const p = periods.find(p => p.type === v);
                        if (p) {
                          setExportDateFrom(p.start.toISOString().slice(0, 10));
                          setExportDateTo(p.end.toISOString().slice(0, 10));
                        }
                      }
                    }}
                    className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-green-500"
                  >
                    {periods.map(p => (
                      <option key={p.type} value={p.type}>{p.label}</option>
                    ))}
                    <option value="custom">Custom Range</option>
                  </select>
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={exportDateFrom}
                      onChange={(e) => { setExportDateFrom(e.target.value); setExportPeriodType('custom'); }}
                      className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-green-500"
                    />
                    <span className="text-gray-500 text-sm">to</span>
                    <input
                      type="date"
                      value={exportDateTo}
                      onChange={(e) => { setExportDateTo(e.target.value); setExportPeriodType('custom'); }}
                      className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-green-500"
                    />
                  </div>
                  {exportDataLoading && <span className="text-gray-400 text-xs">Loading...</span>}
                </div>
              </div>

              {/* Operator filter */}
              <div className="mb-4">
                <label className="block text-sm text-gray-400 mb-1">Operator</label>
                <select
                  value={exportOperator || ''}
                  onChange={(e) => setExportOperator(e.target.value || null)}
                  className="w-full max-w-sm px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="">All Operators</option>
                  {exportSummaries.map(s => (
                    <option key={s.operator} value={s.operator}>{s.operator}</option>
                  ))}
                </select>
              </div>

              {/* Grouping */}
              <div className="mb-4">
                <label className="block text-sm text-gray-400 mb-2">Grouping</label>
                <div className="space-y-2">
                  {([
                    ['well_day', 'Per Well, Per Day', 'Industry standard — 1 invoice per well per day'],
                    ['well_period', 'Per Well, Per Period', '1 invoice per well for the entire period'],
                    ['operator_summary', 'Summary', '1 invoice per operator for the period'],
                  ] as [InvoiceGrouping, string, string][]).map(([value, label, desc]) => (
                    <label key={value} className="flex items-start gap-3 cursor-pointer group">
                      <input
                        type="radio"
                        name="grouping"
                        value={value}
                        checked={exportGrouping === value}
                        onChange={() => setExportGrouping(value)}
                        className="mt-1 accent-green-500"
                      />
                      <div>
                        <span className="text-white text-sm group-hover:text-green-400 transition-colors">{label}</span>
                        <p className="text-gray-500 text-xs">{desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Test well filter */}
              <div className="mb-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={excludeTestWells}
                    onChange={(e) => setExcludeTestWells(e.target.checked)}
                    className="accent-green-500"
                  />
                  <span className="text-white text-sm">Exclude test wells</span>
                  <span className="text-gray-500 text-xs">(only include wells found in NDIC/MBOGC database)</span>
                </label>
              </div>

              {/* Preview */}
              {(() => {
                const src = excludeTestWells && realWellNames ? filterTestWells(exportSummaries, realWellNames) : exportSummaries;
                const groups = groupInvoiceData(src, exportGrouping, exportOperator || undefined);
                const grandTotal = groups.reduce((s, g) => s + g.grandTotal, 0);
                const excluded = exportSummaries.reduce((s, o) => s + o.loads, 0) - src.reduce((s, o) => s + o.loads, 0);
                return (
                  <div className="mb-6 p-3 bg-gray-750 rounded-lg border border-gray-600">
                    <p className="text-white text-sm">
                      <span className="text-green-400 font-mono font-bold">{groups.length}</span> invoice{groups.length !== 1 ? 's' : ''} will be generated
                      {grandTotal > 0 && (
                        <span className="text-gray-400 ml-2">— Total: <span className="text-green-400 font-mono">{formatCurrency(grandTotal)}</span></span>
                      )}
                    </p>
                    {excluded > 0 && (
                      <p className="text-yellow-400 text-xs mt-1">{excluded} test well load{excluded !== 1 ? 's' : ''} excluded</p>
                    )}
                    {groups.length === 0 && !exportDataLoading && (
                      <p className="text-yellow-400 text-xs mt-1">No invoices found for the selected period and operator.</p>
                    )}
                  </div>
                );
              })()}

              {/* Format + Generate */}
              <div className="flex items-center gap-3">
                <select
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
                  className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-green-500"
                >
                  {EXPORT_FORMATS.map(f => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
                <button
                  onClick={async () => {
                    const src = excludeTestWells && realWellNames ? filterTestWells(exportSummaries, realWellNames) : exportSummaries;
                    const groups = groupInvoiceData(src, exportGrouping, exportOperator || undefined);
                    if (groups.length === 0) return;
                    setExportLoading(true);
                    try {
                      const companyId = effectiveCompanyId!;
                      const company = companies.get(companyId)!;
                      const prefix = company.invoicePrefix || 'INV';
                      const from = new Date(exportDateFrom); from.setHours(0, 0, 0, 0);
                      const to = new Date(exportDateTo); to.setHours(23, 59, 59, 999);
                      const exportPeriod: PayPeriod = { type: 'custom' as any, start: from, end: to, label: '' };
                      const numbers = await getNextInvoiceNumbers(companyId, groups.length, prefix);

                      let blob: Blob;
                      switch (exportFormat) {
                        case 'pdf': {
                          const pdf = await generateInvoicePDF(
                            groups, numbers, company, company.billingConfig,
                            company.currentDieselPrice, exportPeriod, legalNameMap,
                          );
                          blob = pdf.output('blob');
                          break;
                        }
                        case 'csv': {
                          const csv = generateInvoiceCSV(groups, numbers, legalNameMap);
                          blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                          break;
                        }
                        case 'quickbooks': {
                          const qbCsv = generateQuickBooksCSV(groups, numbers, company, company.billingConfig, exportPeriod, legalNameMap);
                          blob = new Blob([qbCsv], { type: 'text/csv;charset=utf-8;' });
                          break;
                        }
                        case 'json': {
                          const json = generateInvoiceJSON(groups, numbers, company, company.billingConfig, exportPeriod, legalNameMap);
                          blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
                          break;
                        }
                      }

                      downloadBlob(blob, getExportFilename(prefix, exportPeriod, exportOperator, exportFormat));
                      await saveBillingExport({
                        companyId,
                        operator: exportOperator,
                        grouping: exportGrouping,
                        periodStart: Timestamp.fromDate(from),
                        periodEnd: Timestamp.fromDate(to),
                        invoiceNumberStart: numbers[0],
                        invoiceNumberEnd: numbers[numbers.length - 1],
                        invoiceCount: groups.length,
                        grandTotal: groups.reduce((s, g) => s + g.grandTotal, 0),
                        format: exportFormat,
                        generatedAt: Timestamp.now(),
                      });
                      fetchRecentExports(companyId).then(setRecentExports).catch(() => {});
                    } catch (err: any) {
                      console.error('Export failed:', err);
                      setError(err?.message || 'Export failed');
                    } finally {
                      setExportLoading(false);
                    }
                  }}
                  disabled={exportLoading || exportSummaries.length === 0}
                  className="px-5 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {exportLoading ? 'Generating...' : 'Generate'}
                </button>
                <span className="text-gray-500 text-xs">
                  {EXPORT_FORMATS.find(f => f.value === exportFormat)?.description}
                </span>
              </div>
            </div>

            {/* Recent Exports */}
            {recentExports.length > 0 && (
              <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
                <h3 className="text-lg font-semibold text-white mb-3">Recent Exports</h3>
                <table className="w-full">
                  <thead>
                    <tr className="text-xs text-gray-500">
                      <th className="px-4 py-2 text-left">Invoice Range</th>
                      <th className="px-4 py-2 text-left">Operator</th>
                      <th className="px-4 py-2 text-left">Grouping</th>
                      <th className="px-4 py-2 text-right">Count</th>
                      <th className="px-4 py-2 text-right">Total</th>
                      <th className="px-4 py-2 text-left">Format</th>
                      <th className="px-4 py-2 text-left">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700">
                    {recentExports.map(exp => (
                      <tr key={exp.id} className="text-sm hover:bg-gray-750">
                        <td className="px-4 py-2 text-blue-400 font-mono text-xs">
                          {exp.invoiceNumberStart === exp.invoiceNumberEnd
                            ? exp.invoiceNumberStart
                            : `${exp.invoiceNumberStart} .. ${exp.invoiceNumberEnd}`}
                        </td>
                        <td className="px-4 py-2 text-gray-300">{exp.operator || 'All'}</td>
                        <td className="px-4 py-2 text-gray-400">
                          {exp.grouping === 'well_day' ? 'Well/Day' : exp.grouping === 'well_period' ? 'Well/Period' : 'Summary'}
                        </td>
                        <td className="px-4 py-2 text-right text-white font-mono">{exp.invoiceCount}</td>
                        <td className="px-4 py-2 text-right text-green-400 font-mono">{formatCurrency(exp.grandTotal)}</td>
                        <td className="px-4 py-2">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            exp.format === 'pdf' ? 'bg-red-600/20 text-red-400'
                              : exp.format === 'quickbooks' ? 'bg-emerald-600/20 text-emerald-400'
                              : exp.format === 'json' ? 'bg-purple-600/20 text-purple-400'
                              : 'bg-blue-600/20 text-blue-400'
                          }`}>
                            {exp.format === 'quickbooks' ? 'QB CSV' : exp.format.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-gray-400 text-xs">
                          {exp.generatedAt?.toDate ? exp.generatedAt.toDate().toLocaleDateString() : '--'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Payment Modal */}
        {paymentModal && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-6 w-full max-w-md">
              <h3 className="text-lg font-semibold text-white mb-4">Record Payment</h3>
              <p className="text-gray-400 text-sm mb-2">
                {paymentModal.billingNumber} — {paymentModal.operator}
              </p>
              <p className="text-gray-400 text-sm mb-4">
                Outstanding: {formatCurrency(paymentModal.grandTotal - paymentModal.amountPaid)}
              </p>
              <div className="relative mb-4">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                  className="w-full pl-7 pr-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => { setPaymentModal(null); setPaymentAmount(''); }}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRecordPayment}
                  className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg text-sm"
                >
                  Record Payment
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function OperatorRow({
  summary,
  dieselPrice,
  isExpanded,
  onToggle,
  onGenerate,
  generating,
  alreadyBilled,
  showDetention,
  legalNameMap = {},
}: {
  summary: OperatorBillingSummary;
  dieselPrice: number | undefined;
  isExpanded: boolean;
  onToggle: () => void;
  onGenerate: () => void;
  generating: boolean;
  alreadyBilled: boolean;
  showDetention: boolean;
  legalNameMap?: Record<string, string>;
}) {
  const rateInfo = getFuelSurchargeRate(summary.billingConfig, dieselPrice);
  return (
    <>
      <tr className="hover:bg-gray-750 cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-3 text-white font-medium">{summary.operator}</td>
        <td className="px-4 py-3 text-right text-white font-mono">{summary.loads}</td>
        <td className="px-4 py-3 text-right text-white font-mono">{summary.totalBBLs.toLocaleString()}</td>
        <td className="px-4 py-3 text-right text-white font-mono">{summary.totalHours.toFixed(1)}</td>
        <td className="px-4 py-3 text-right text-white font-mono">{formatCurrency(summary.subtotal)}</td>
        <td className="px-4 py-3 text-right text-yellow-400 font-mono">{formatCurrency(summary.totalFuelSurcharge)}</td>
        {showDetention && <td className="px-4 py-3 text-right text-orange-400 font-mono">{summary.totalDetentionPay > 0 ? formatCurrency(summary.totalDetentionPay) : '--'}</td>}
        <td className="px-4 py-3 text-right text-green-400 font-mono font-semibold">{formatCurrency(summary.grandTotal)}</td>
        <td className="px-4 py-3 text-right text-sm">
          <span className="text-gray-400">{getFuelSurchargeLabel(summary.billingConfig)}</span>
          {rateInfo && rateInfo.rate > 0 && (
            <span className="block text-cyan-400 font-mono text-xs mt-0.5">
              ${rateInfo.rate.toFixed(2)}{rateInfo.unit}
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
          {alreadyBilled ? (
            <span className="px-3 py-1 bg-green-600/20 text-green-400 rounded text-xs font-medium">Billed</span>
          ) : (
            <button
              onClick={onGenerate}
              disabled={generating}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-medium disabled:opacity-50"
            >
              {generating ? 'Generating...' : 'Generate Bill'}
            </button>
          )}
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={showDetention ? 11 : 10} className="px-0 py-0">
            <div className="bg-gray-850 border-t border-gray-700">
              <table className="w-full">
                <thead>
                  <tr className="text-xs text-gray-500">
                    <th className="px-4 py-1 text-left">Invoice #</th>
                    <th className="px-4 py-1 text-left">Date</th>
                    <th className="px-4 py-1 text-left">Well</th>
                    <th className="px-4 py-1 text-left">Drop-off</th>
                    <th className="px-4 py-1 text-left">Driver</th>
                    <th className="px-4 py-1 text-right">BBLs</th>
                    <th className="px-4 py-1 text-right">Hours</th>
                    <th className="px-4 py-1 text-right">Fuel Min</th>
                    <th className="px-4 py-1 text-right">Base</th>
                    <th className="px-4 py-1 text-right">FSC</th>
                    {showDetention && <th className="px-4 py-1 text-right">Detention</th>}
                    <th className="px-4 py-1 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {summary.lineItems.map(item => (
                    <tr key={item.invoiceId} className="text-sm hover:bg-gray-800">
                      <td className="px-4 py-1.5 text-blue-400 font-mono">{item.invoiceNumber}</td>
                      <td className="px-4 py-1.5 text-gray-300">{item.date}</td>
                      <td className="px-4 py-1.5 text-gray-300">{item.wellName}</td>
                      <td className="px-4 py-1.5 text-gray-400">{item.hauledTo || '--'}</td>
                      <td className="px-4 py-1.5 text-gray-400">{legalNameMap[item.driver] || item.driver}</td>
                      <td className="px-4 py-1.5 text-right text-white font-mono">{item.bbls || '--'}</td>
                      <td className="px-4 py-1.5 text-right text-white font-mono">{item.hours || '--'}</td>
                      <td className="px-4 py-1.5 text-right text-gray-400 font-mono">{item.fuelMinutes || '--'}</td>
                      <td className="px-4 py-1.5 text-right text-white font-mono">{formatCurrency(item.baseAmount)}</td>
                      <td className="px-4 py-1.5 text-right text-yellow-400 font-mono">{item.fuelSurcharge > 0 ? formatCurrency(item.fuelSurcharge) : '--'}</td>
                      {showDetention && <td className="px-4 py-1.5 text-right text-orange-400 font-mono">{item.detentionPay > 0 ? formatCurrency(item.detentionPay) : '--'}</td>}
                      <td className="px-4 py-1.5 text-right text-green-400 font-mono">{formatCurrency(item.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function BillRow({
  record,
  isExpanded,
  onToggle,
  onMarkSent,
  onRecordPayment,
}: {
  record: BillingRecord;
  isExpanded: boolean;
  onToggle: () => void;
  onMarkSent: () => void;
  onRecordPayment: () => void;
}) {
  const termsLabel = record.paymentTerms?.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Net 30';

  return (
    <>
      <tr className="hover:bg-gray-750 cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-3 text-blue-400 font-mono">{record.billingNumber}</td>
        <td className="px-4 py-3 text-white">{record.operator}</td>
        <td className="px-4 py-3 text-right text-green-400 font-mono">{formatCurrency(record.grandTotal)}</td>
        <td className="px-4 py-3 text-right text-white font-mono">{formatCurrency(record.amountPaid)}</td>
        <td className="px-4 py-3 text-gray-400 text-sm">{termsLabel}</td>
        <td className="px-4 py-3">
          <span className={`px-2 py-1 rounded text-xs font-medium capitalize ${getBillingStatusColor(record.status)}`}>
            {record.status}
          </span>
        </td>
        <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-center gap-2">
            {record.status === 'draft' && (
              <button onClick={onMarkSent} className="px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs">
                Mark Sent
              </button>
            )}
            {(record.status === 'sent' || record.status === 'partial' || record.status === 'overdue') && (
              <button onClick={onRecordPayment} className="px-2 py-1 bg-green-600 hover:bg-green-500 text-white rounded text-xs">
                Record Payment
              </button>
            )}
          </div>
        </td>
      </tr>
      {isExpanded && record.lineItems && (
        <tr>
          <td colSpan={7} className="px-4 py-3 bg-gray-850">
            <div className="text-sm space-y-1">
              <div className="flex gap-6 text-gray-400 mb-2">
                <span>Invoices: <span className="text-white">{record.lineItems.length}</span></span>
                <span>Subtotal: <span className="text-white">{formatCurrency(record.subtotal)}</span></span>
                <span>Fuel Surcharge: <span className="text-yellow-400">{formatCurrency(record.totalFuelSurcharge)}</span></span>
              </div>
              <div className="text-gray-500 text-xs">
                Invoice #s: {record.lineItems.map(li => li.invoiceNumber).join(', ')}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
