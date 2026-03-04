'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { loadAllCompanies, updateCompanyFields, type CompanyConfig, type DoeRegion, DOE_REGIONS, STATE_TO_PADD } from '@/lib/companySettings';
import {
  fetchBillingData,
  fetchBillingRecords,
  generateBillingRecord,
  updateBillingStatus,
  saveDieselPrice,
  fetchDieselPriceHistory,
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

type SubTab = 'receivables' | 'fuel';

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
      const [sums, records] = await Promise.all([
        fetchBillingData(selectedPeriod, companies, companyId),
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
      await saveDieselPrice(effectiveCompanyId, price, priceSource, user?.displayName || 'Admin');
      setNewPrice('');
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
      const result = await fetchEiaDieselPrice(currentRegion);
      setNewPrice(result.price.toFixed(3));
      setPriceSource('EIA API');
      setEiaResult(`Fetched $${result.price.toFixed(3)}/gal for ${result.region} (week of ${result.date})`);
    } catch (err: any) {
      setEiaResult(`Error: ${err?.message || 'Failed to fetch from EIA'}`);
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
                              dieselPrice={currentDiesel}
                              isExpanded={expandedOp === summary.operator}
                              onToggle={() => setExpandedOp(expandedOp === summary.operator ? null : summary.operator)}
                              onGenerate={() => handleGenerateBill(summary)}
                              generating={generating === summary.operator}
                              alreadyBilled={alreadyBilled}
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
                          <td className="px-4 py-2 text-right text-green-400 font-mono font-semibold">{formatCurrency(summaries.reduce((s, o) => s + o.grandTotal, 0))}</td>
                          <td colSpan={2} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>

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
              <div className="flex items-center gap-3 mb-4">
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
                {eiaResult && (
                  <span className={`text-sm ${eiaResult.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
                    {eiaResult}
                  </span>
                )}
              </div>

              {/* Manual update form */}
              <div className="flex items-center gap-3">
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
                      <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Source</th>
                      <th className="px-4 py-2 text-left text-sm font-medium text-gray-300">Updated By</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700">
                    {dieselHistory.map(entry => (
                      <tr key={entry.id} className="hover:bg-gray-750">
                        <td className="px-4 py-2 text-white text-sm">{entry.date}</td>
                        <td className="px-4 py-2 text-right text-green-400 font-mono">${entry.price.toFixed(2)}</td>
                        <td className="px-4 py-2 text-gray-400 text-sm">{entry.source}</td>
                        <td className="px-4 py-2 text-gray-400 text-sm">{entry.updatedBy}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
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
}: {
  summary: OperatorBillingSummary;
  dieselPrice: number | undefined;
  isExpanded: boolean;
  onToggle: () => void;
  onGenerate: () => void;
  generating: boolean;
  alreadyBilled: boolean;
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
          <td colSpan={9} className="px-0 py-0">
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
                      <td className="px-4 py-1.5 text-gray-400">{item.driver}</td>
                      <td className="px-4 py-1.5 text-right text-white font-mono">{item.bbls || '--'}</td>
                      <td className="px-4 py-1.5 text-right text-white font-mono">{item.hours || '--'}</td>
                      <td className="px-4 py-1.5 text-right text-gray-400 font-mono">{item.fuelMinutes || '--'}</td>
                      <td className="px-4 py-1.5 text-right text-white font-mono">{formatCurrency(item.baseAmount)}</td>
                      <td className="px-4 py-1.5 text-right text-yellow-400 font-mono">{item.fuelSurcharge > 0 ? formatCurrency(item.fuelSurcharge) : '--'}</td>
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
