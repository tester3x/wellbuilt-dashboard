'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { hasCapability } from '@/lib/auth';
import { loadAllCompanies, type CompanyConfig } from '@/lib/companySettings';
import { WellBuiltDialog } from '@/components/WellBuiltDialog';
import {
  listDispatchPhotoReviews,
  reviewDispatchPhoto,
  type PhotoReviewListItem,
} from '@/lib/dispatchPhotoReview';

type StatusFilter = 'all' | 'unreviewed' | 'approved' | 'rejected' | 'addressed';

export default function PhotoReviewPage() {
  const { user, loading: authLoading, userCompany } = useAuth();
  const router = useRouter();

  const canView = hasCapability(user, 'viewDispatch', userCompany);
  const canMutate =
    canView &&
    !!user &&
    user.role !== 'viewer' &&
    user.role !== 'driver' &&
    user.role !== 'payroll';

  // Company context resolution:
  // Tenant-scoped users have user.companyId set.
  // Platform admins (user.companyId unset) must explicitly select a company.
  // NEVER default a platform admin silently to any company.
  const [companies, setCompanies] = useState<CompanyConfig[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);

  const [items, setItems] = useState<PhotoReviewListItem[]>([]);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    dateFrom: '',
    dateTo: '',
    driver: '',
    ticketOrJob: '',
    pickup: '',
    dropoff: '',
    photoType: '',
    reviewStatus: 'unreviewed' as StatusFilter,
  });

  const [viewer, setViewer] = useState<PhotoReviewListItem | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [supervisorNote, setSupervisorNote] = useState('');
  const [addressedNote, setAddressedNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Authentication & authorization redirect
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push('/login');
      return;
    }
    if (!canView) {
      router.push('/');
    }
  }, [user, authLoading, canView, router]);

  // Load company catalog for platform administrator context selector
  useEffect(() => {
    if (!user) return;
    if (!user.companyId) {
      loadAllCompanies()
        .then((list) => {
          setCompanies(list);
          // Explicit requirement: Never silently default platform admin to any company.
          // selectedCompanyId remains null until the user explicitly chooses a company.
        })
        .catch(() => {});
    }
  }, [user]);

  const effectiveCompanyId = user?.companyId || selectedCompanyId || null;

  const load = useCallback(async () => {
    if (!user || !canView || !effectiveCompanyId) return;
    setLoadState('loading');
    try {
      const data = await listDispatchPhotoReviews({
        companyId: effectiveCompanyId,
        dateFromMs: filters.dateFrom ? Date.parse(filters.dateFrom) : undefined,
        dateToMs: filters.dateTo ? Date.parse(filters.dateTo + 'T23:59:59') : undefined,
        driver: filters.driver.trim() || undefined,
        ticketOrJob: filters.ticketOrJob.trim() || undefined,
        pickup: filters.pickup.trim() || undefined,
        dropoff: filters.dropoff.trim() || undefined,
        photoType: filters.photoType || undefined,
        reviewStatus: filters.reviewStatus,
      });
      setItems(data.items || []);
      setLoadState('ready');
      setError('');
    } catch (e: unknown) {
      setLoadState('error');
      const rawMsg = e instanceof Error ? e.message : 'Failed to load photo reviews';
      if (rawMsg.includes('companyId_required')) {
        setError('Please select a company to review inspection photos.');
      } else {
        setError(rawMsg);
      }
    }
  }, [user, canView, effectiveCompanyId, filters]);

  useEffect(() => {
    if (!authLoading && user && canView && effectiveCompanyId) {
      void load();
    }
  }, [authLoading, user, canView, effectiveCompanyId, load]);

  const resetFilters = () => {
    setFilters({
      dateFrom: '',
      dateTo: '',
      driver: '',
      ticketOrJob: '',
      pickup: '',
      dropoff: '',
      photoType: '',
      reviewStatus: 'unreviewed',
    });
  };

  async function runReview(action: 'approve' | 'reject' | 'address') {
    if (!viewer || !effectiveCompanyId) return;
    setBusy(true);
    try {
      await reviewDispatchPhoto({
        companyId: effectiveCompanyId,
        invoiceId: viewer.invoiceId,
        photoId: viewer.photoId,
        action,
        rejectReason: action === 'reject' ? rejectReason.trim() : undefined,
        supervisorNote: action === 'reject' ? supervisorNote.trim() : undefined,
        addressedNote: action === 'address' ? addressedNote.trim() : undefined,
      });
      setRejectOpen(false);
      setAddressOpen(false);
      setRejectReason('');
      setSupervisorNote('');
      setAddressedNote('');
      setViewer(null);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Review action failed');
    } finally {
      setBusy(false);
    }
  }

  // Capability protection fallback
  if (!authLoading && user && !canView) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col">
        <AppHeader />
        <main className="max-w-4xl mx-auto w-full px-4 py-16 text-center">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-8">
            <h2 className="text-lg font-semibold text-white mb-2">Access Denied</h2>
            <p className="text-gray-400 text-sm">
              You do not have dispatch viewing authorization required to access Photo Review.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">
      <AppHeader />

      <main className="max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 flex-1 flex flex-col gap-6">
        {/* Page Header Toolbar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-800 pb-5">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Photo Review</h1>
            <p className="text-sm text-gray-400 mt-1">
              Review, approve, or reject field inspection photos submitted on completed invoices.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Authenticated Platform Admin Company Picker (Explicit Selection Required) */}
            {!user?.companyId && (
              <div className="flex items-center gap-2">
                <label
                  htmlFor="company-context-selector"
                  className="text-xs font-medium text-gray-300 whitespace-nowrap"
                >
                  Company:
                </label>
                <select
                  id="company-context-selector"
                  value={selectedCompanyId || ''}
                  onChange={(e) => setSelectedCompanyId(e.target.value || null)}
                  className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-xs focus:outline-none focus:border-blue-500 shrink-0 min-w-[14rem]"
                >
                  <option value="">Select a company to review photos...</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <button
              type="button"
              onClick={() => void load()}
              disabled={loadState === 'loading' || !effectiveCompanyId}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-xs font-medium text-gray-200 hover:text-white transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              <span className={loadState === 'loading' ? 'animate-spin' : ''}>↻</span>
              Refresh
            </button>
          </div>
        </div>

        {/* Missing Company Guidance Card (Platform Admin before explicit selection) */}
        {!effectiveCompanyId && (
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-10 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-blue-900/40 border border-blue-700/50 flex items-center justify-center text-blue-400 mb-3">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <h3 className="text-base font-semibold text-white mb-1">Select a Company Context</h3>
            <p className="text-gray-400 text-xs max-w-md mx-auto">
              As a platform administrator, select a company from the toolbar above to review inspection photos.
            </p>
          </div>
        )}

        {/* Governed Filter Card - only rendered when company context is active */}
        {effectiveCompanyId && (
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Filter Records
              </span>
              <button
                type="button"
                onClick={resetFilters}
                className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
              >
                Reset filters
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <label htmlFor="filter-date-from" className="block text-xs font-medium text-gray-300 mb-1">
                  Start Date
                </label>
                <input
                  id="filter-date-from"
                  type="date"
                  value={filters.dateFrom}
                  onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
                  className="w-full bg-gray-900 text-white text-xs rounded-lg px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label htmlFor="filter-date-to" className="block text-xs font-medium text-gray-300 mb-1">
                  End Date
                </label>
                <input
                  id="filter-date-to"
                  type="date"
                  value={filters.dateTo}
                  onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
                  className="w-full bg-gray-900 text-white text-xs rounded-lg px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label htmlFor="filter-driver" className="block text-xs font-medium text-gray-300 mb-1">
                  Driver Name
                </label>
                <input
                  id="filter-driver"
                  type="text"
                  placeholder="Driver search..."
                  value={filters.driver}
                  onChange={(e) => setFilters({ ...filters, driver: e.target.value })}
                  className="w-full bg-gray-900 text-white text-xs rounded-lg px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label htmlFor="filter-ticket" className="block text-xs font-medium text-gray-300 mb-1">
                  Ticket / Invoice
                </label>
                <input
                  id="filter-ticket"
                  type="text"
                  placeholder="Ticket or invoice #..."
                  value={filters.ticketOrJob}
                  onChange={(e) => setFilters({ ...filters, ticketOrJob: e.target.value })}
                  className="w-full bg-gray-900 text-white text-xs rounded-lg px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label htmlFor="filter-pickup" className="block text-xs font-medium text-gray-300 mb-1">
                  Pickup Location
                </label>
                <input
                  id="filter-pickup"
                  type="text"
                  placeholder="Well or pickup..."
                  value={filters.pickup}
                  onChange={(e) => setFilters({ ...filters, pickup: e.target.value })}
                  className="w-full bg-gray-900 text-white text-xs rounded-lg px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label htmlFor="filter-dropoff" className="block text-xs font-medium text-gray-300 mb-1">
                  Drop-off Location
                </label>
                <input
                  id="filter-dropoff"
                  type="text"
                  placeholder="Disposal or drop-off..."
                  value={filters.dropoff}
                  onChange={(e) => setFilters({ ...filters, dropoff: e.target.value })}
                  className="w-full bg-gray-900 text-white text-xs rounded-lg px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label htmlFor="filter-photo-type" className="block text-xs font-medium text-gray-300 mb-1">
                  Photo Type
                </label>
                <select
                  id="filter-photo-type"
                  value={filters.photoType}
                  onChange={(e) => setFilters({ ...filters, photoType: e.target.value })}
                  className="w-full bg-gray-900 text-white text-xs rounded-lg px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500"
                >
                  <option value="">All photo types</option>
                  <option value="pickup">Pickup</option>
                  <option value="dropoff">Drop-off</option>
                </select>
              </div>

              <div>
                <label htmlFor="filter-status" className="block text-xs font-medium text-gray-300 mb-1">
                  Review Status
                </label>
                <select
                  id="filter-status"
                  value={filters.reviewStatus}
                  onChange={(e) => setFilters({ ...filters, reviewStatus: e.target.value as StatusFilter })}
                  className="w-full bg-gray-900 text-white text-xs rounded-lg px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500"
                >
                  <option value="all">All statuses</option>
                  <option value="unreviewed">Unreviewed</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                  <option value="addressed">Addressed</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* Friendly Error Banner */}
        {error && (
          <div className="p-4 bg-red-900/20 border border-red-800 rounded-xl flex items-start gap-3">
            <span className="text-red-400 text-base leading-none">⚠️</span>
            <div className="flex-1">
              <div className="text-sm font-medium text-red-200">Unable to load photo reviews</div>
              <p className="text-xs text-red-400 mt-0.5">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="text-xs font-medium text-red-300 hover:text-white underline shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading Skeleton State */}
        {loadState === 'loading' && effectiveCompanyId && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden animate-pulse h-60 flex flex-col"
              >
                <div className="w-full h-36 bg-gray-700/50" />
                <div className="p-3 space-y-2 flex-1">
                  <div className="h-3 bg-gray-700 rounded w-1/3" />
                  <div className="h-3 bg-gray-700 rounded w-3/4" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty State */}
        {loadState === 'ready' && items.length === 0 && effectiveCompanyId && (
          <div className="bg-gray-800 border border-gray-700 rounded-xl py-16 px-6 text-center">
            <div className="text-white text-lg font-semibold mb-1">No Photos Found</div>
            <p className="text-gray-400 text-sm max-w-md mx-auto mb-4">
              There are currently no driver inspection photos matching the selected filter criteria.
            </p>
            <button
              type="button"
              onClick={resetFilters}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-xs font-medium transition-colors"
            >
              Reset Filters
            </button>
          </div>
        )}

        {/* Ready Photo Grid */}
        {loadState === 'ready' && items.length > 0 && effectiveCompanyId && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {items.map((item) => {
              const statusClass =
                item.reviewStatus === 'approved'
                  ? 'bg-green-900/60 text-green-300 border-green-700/50'
                  : item.reviewStatus === 'rejected'
                    ? 'bg-red-900/60 text-red-300 border-red-700/50'
                    : item.reviewStatus === 'addressed'
                      ? 'bg-gray-700 text-gray-300 border-gray-600'
                      : 'bg-amber-900/60 text-amber-300 border-amber-700/50';

              return (
                <button
                  key={`${item.invoiceId}_${item.photoId}`}
                  type="button"
                  onClick={() => setViewer(item)}
                  className="bg-gray-800 border border-gray-700 hover:border-blue-500/60 rounded-xl overflow-hidden text-left flex flex-col transition-all group focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                >
                  <div className="relative aspect-video w-full bg-black/60 flex items-center justify-center overflow-hidden">
                    {item.displayUrl ? (
                      <img
                        src={item.displayUrl}
                        alt=""
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                        loading="lazy"
                      />
                    ) : (
                      <div className="text-gray-500 text-[11px] p-2 text-center">
                        Syncing from field...
                      </div>
                    )}
                    <span
                      className={`absolute top-2 right-2 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border backdrop-blur-sm ${statusClass}`}
                    >
                      {item.reviewStatus}
                    </span>
                  </div>

                  <div className="p-3 flex flex-col gap-1 w-full text-xs">
                    <div className="flex items-center justify-between gap-1 text-gray-400 text-[11px]">
                      <span className="font-semibold text-white capitalize">{item.photoType}</span>
                      <span>{item.takenAt ? item.takenAt.split('T')[0] : '—'}</span>
                    </div>

                    <div className="text-gray-200 font-medium truncate" title={item.driverName}>
                      {item.driverName || 'Unknown Driver'}
                    </div>

                    <div className="text-gray-400 text-[11px] truncate">
                      Tkt: {item.ticketNumber || item.invoiceNumber || '—'}
                    </div>

                    <div className="text-gray-500 text-[10px] truncate">
                      {item.pickup ? `From: ${item.pickup}` : ''}
                      {item.pickup && item.dropoff ? ' • ' : ''}
                      {item.dropoff ? `To: ${item.dropoff}` : ''}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </main>

      {/* Photo Inspector Modal */}
      {viewer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-4xl max-h-[90vh] rounded-xl border border-gray-700 bg-gray-900 shadow-2xl flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
              <div>
                <h2 className="text-base font-bold text-white capitalize">
                  {viewer.photoType} Photo Inspection
                </h2>
                <p className="text-xs text-gray-400">
                  Ticket {viewer.ticketNumber || viewer.invoiceNumber} &bull; Driver: {viewer.driverName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setViewer(null)}
                className="text-gray-400 hover:text-white text-2xl leading-none px-2"
                aria-label="Close"
              >
                &times;
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 grid md:grid-cols-2 gap-5 overflow-y-auto">
              <div className="bg-black rounded-xl overflow-hidden flex items-center justify-center min-h-[16rem]">
                {viewer.displayUrl ? (
                  <img
                    src={viewer.displayUrl}
                    alt=""
                    className="w-full max-h-[60vh] object-contain rounded"
                  />
                ) : (
                  <div className="text-gray-500 text-xs text-center p-6">
                    Original photo has not yet synced from field device.
                  </div>
                )}
              </div>

              <div className="flex flex-col justify-between gap-4 text-xs">
                <div className="space-y-3">
                  <div>
                    <span className="text-gray-400 block text-[11px] uppercase tracking-wider mb-1">
                      Status
                    </span>
                    <span
                      className={`inline-block px-2.5 py-1 rounded text-xs font-semibold uppercase tracking-wide border ${
                        viewer.reviewStatus === 'approved'
                          ? 'bg-green-900/60 text-green-300 border-green-700'
                          : viewer.reviewStatus === 'rejected'
                            ? 'bg-red-900/60 text-red-300 border-red-700'
                            : viewer.reviewStatus === 'addressed'
                              ? 'bg-gray-700 text-gray-300 border-gray-600'
                              : 'bg-amber-900/60 text-amber-300 border-amber-700'
                      }`}
                    >
                      {viewer.reviewStatus}
                    </span>
                  </div>

                  {viewer.rejectReason && (
                    <div className="bg-red-950/40 border border-red-900/50 rounded-lg p-3">
                      <span className="text-red-400 font-medium block mb-0.5">Rejection Reason:</span>
                      <p className="text-red-200">{viewer.rejectReason}</p>
                    </div>
                  )}

                  {viewer.supervisorNote && (
                    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                      <span className="text-gray-400 font-medium block mb-0.5">Supervisor Note:</span>
                      <p className="text-gray-200">{viewer.supervisorNote}</p>
                    </div>
                  )}

                  {viewer.addressedNote && (
                    <div className="bg-blue-950/40 border border-blue-900/50 rounded-lg p-3">
                      <span className="text-blue-400 font-medium block mb-0.5">Coaching Resolution:</span>
                      <p className="text-blue-200">{viewer.addressedNote}</p>
                    </div>
                  )}

                  <div className="pt-2 text-[11px] text-gray-400 space-y-1 border-t border-gray-800">
                    {viewer.reviewedByLabel && <div>Reviewed by: {viewer.reviewedByLabel}</div>}
                    {viewer.addressedByLabel && <div>Addressed by: {viewer.addressedByLabel}</div>}
                    <a
                      href={`/dispatch/?tab=completed&invoice=${encodeURIComponent(viewer.invoiceId)}`}
                      className="inline-block text-blue-400 hover:text-blue-300 underline font-medium pt-1"
                    >
                      Open in Dispatch &rarr;
                    </a>
                  </div>
                </div>

                {canMutate && (
                  <div className="flex flex-wrap gap-2 pt-4 border-t border-gray-800">
                    {viewer.reviewStatus !== 'approved' && viewer.reviewStatus !== 'addressed' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void runReview('approve')}
                        className="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white font-semibold text-xs transition-colors disabled:opacity-50"
                      >
                        Approve Photo
                      </button>
                    )}
                    {viewer.reviewStatus !== 'rejected' && viewer.reviewStatus !== 'addressed' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setRejectOpen(true)}
                        className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold text-xs transition-colors disabled:opacity-50"
                      >
                        Reject Photo
                      </button>
                    )}
                    {viewer.reviewStatus === 'rejected' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setAddressOpen(true)}
                        className="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white font-semibold text-xs transition-colors disabled:opacity-50"
                      >
                        Mark Coaching Addressed
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reject Reason Dialog */}
      <WellBuiltDialog
        open={rejectOpen}
        title="Reject Inspection Photo"
        primaryLabel="Reject Photo"
        primaryTone="danger"
        primaryDisabled={busy || !rejectReason.trim()}
        onClose={() => setRejectOpen(false)}
        onPrimary={() => void runReview('reject')}
      >
        <p className="mb-3 text-gray-300">
          This records a quality/documentation failure requiring driver coaching. The completed job, invoice, and PDF remain intact.
        </p>
        <label htmlFor="reject-reason-input" className="block text-xs uppercase tracking-wide text-gray-400 mb-1">
          Reason for rejection (required)
        </label>
        <textarea
          id="reject-reason-input"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder="e.g. Gauge reading illegible, missing drop-off manifest..."
          className="w-full bg-gray-800 border border-gray-700 rounded-lg p-2.5 text-white mb-3 text-xs focus:outline-none focus:border-red-500"
          rows={3}
        />
        <label htmlFor="supervisor-note-input" className="block text-xs uppercase tracking-wide text-gray-400 mb-1">
          Internal supervisor note (optional)
        </label>
        <textarea
          id="supervisor-note-input"
          value={supervisorNote}
          onChange={(e) => setSupervisorNote(e.target.value)}
          placeholder="Notes for driver supervisor or coaching discussion..."
          className="w-full bg-gray-800 border border-gray-700 rounded-lg p-2.5 text-white text-xs focus:outline-none focus:border-red-500"
          rows={2}
        />
      </WellBuiltDialog>

      {/* Mark Coaching Addressed Dialog */}
      <WellBuiltDialog
        open={addressOpen}
        title="Mark Coaching Addressed"
        primaryLabel="Complete Coaching"
        primaryDisabled={busy}
        onClose={() => setAddressOpen(false)}
        onPrimary={() => void runReview('address')}
      >
        <p className="mb-3 text-gray-300">
          Record that the supervisor discussion has taken place with the driver.
        </p>
        <label htmlFor="addressed-note-input" className="block text-xs uppercase tracking-wide text-gray-400 mb-1">
          Coaching note (optional)
        </label>
        <textarea
          id="addressed-note-input"
          value={addressedNote}
          onChange={(e) => setAddressedNote(e.target.value)}
          placeholder="Summary of coaching conversation..."
          className="w-full bg-gray-800 border border-gray-700 rounded-lg p-2.5 text-white text-xs focus:outline-none focus:border-blue-500"
          rows={3}
        />
      </WellBuiltDialog>
    </div>
  );
}
