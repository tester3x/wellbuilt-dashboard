'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { hasCapability } from '@/lib/auth';
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
  const canMutate = !!user && user.role !== 'viewer' && user.role !== 'driver' && user.role !== 'payroll';

  const [items, setItems] = useState<PhotoReviewListItem[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
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

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.push('/login'); return; }
  }, [user, authLoading, router]);

  const load = useCallback(async () => {
    if (!user || !canView) return;
    setLoadState('loading');
    try {
      const data = await listDispatchPhotoReviews({
        companyId: user.companyId,
        dateFromMs: filters.dateFrom ? Date.parse(filters.dateFrom) : undefined,
        dateToMs: filters.dateTo ? Date.parse(filters.dateTo + 'T23:59:59') : undefined,
        driver: filters.driver || undefined,
        ticketOrJob: filters.ticketOrJob || undefined,
        pickup: filters.pickup || undefined,
        dropoff: filters.dropoff || undefined,
        photoType: filters.photoType || undefined,
        reviewStatus: filters.reviewStatus,
      });
      setItems(data.items || []);
      setLoadState('ready');
      setError('');
    } catch (e: unknown) {
      setLoadState('error');
      setError(e instanceof Error ? e.message : 'Failed to load photo reviews');
    }
  }, [user, canView, filters]);

  useEffect(() => { if (!authLoading && user && canView) void load(); }, [authLoading, user, canView, load]);

  async function runReview(action: 'approve' | 'reject' | 'address') {
    if (!viewer) return;
    setBusy(true);
    try {
      await reviewDispatchPhoto({
        companyId: user?.companyId,
        invoiceId: viewer.invoiceId,
        photoId: viewer.photoId,
        action,
        rejectReason: action === 'reject' ? rejectReason : undefined,
        supervisorNote: action === 'reject' ? supervisorNote : undefined,
        addressedNote: action === 'address' ? addressedNote : undefined,
      });
      setRejectOpen(false);
      setAddressOpen(false);
      setRejectReason('');
      setSupervisorNote('');
      setAddressedNote('');
      setViewer(null);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Review failed');
    } finally {
      setBusy(false);
    }
  }

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gray-900">
        <AppHeader />
        <div className="text-gray-400 text-center py-24">Loading...</div>
      </div>
    );
  }

  if (!user || !canView) {
    return (
      <div className="min-h-screen bg-gray-900">
        <AppHeader />
        <div className="text-red-400 text-center py-24">Photo Review is company-scoped to Dispatch roles.</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900">
      <AppHeader />
      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Photo Review</h1>
            <p className="text-sm text-gray-400">
              Office documentation review. Rejection is a quality/coaching record — it does not request a retake or change the job, invoice, or PDF.
            </p>
          </div>
          <button type="button" onClick={() => void load()} className="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm">
            Refresh
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 mb-4">
          <input type="date" value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} className="bg-gray-800 text-white text-xs rounded px-2 py-2 border border-gray-700" />
          <input type="date" value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} className="bg-gray-800 text-white text-xs rounded px-2 py-2 border border-gray-700" />
          <input placeholder="Driver" value={filters.driver} onChange={(e) => setFilters({ ...filters, driver: e.target.value })} className="bg-gray-800 text-white text-xs rounded px-2 py-2 border border-gray-700" />
          <input placeholder="Ticket / job" value={filters.ticketOrJob} onChange={(e) => setFilters({ ...filters, ticketOrJob: e.target.value })} className="bg-gray-800 text-white text-xs rounded px-2 py-2 border border-gray-700" />
          <input placeholder="Pickup" value={filters.pickup} onChange={(e) => setFilters({ ...filters, pickup: e.target.value })} className="bg-gray-800 text-white text-xs rounded px-2 py-2 border border-gray-700" />
          <input placeholder="Drop-off" value={filters.dropoff} onChange={(e) => setFilters({ ...filters, dropoff: e.target.value })} className="bg-gray-800 text-white text-xs rounded px-2 py-2 border border-gray-700" />
          <select value={filters.photoType} onChange={(e) => setFilters({ ...filters, photoType: e.target.value })} className="bg-gray-800 text-white text-xs rounded px-2 py-2 border border-gray-700">
            <option value="">All types</option>
            <option value="pickup">Pickup</option>
            <option value="dropoff">Drop-off</option>
          </select>
          <select value={filters.reviewStatus} onChange={(e) => setFilters({ ...filters, reviewStatus: e.target.value as StatusFilter })} className="bg-gray-800 text-white text-xs rounded px-2 py-2 border border-gray-700">
            <option value="all">All statuses</option>
            <option value="unreviewed">Unreviewed</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="addressed">Addressed</option>
          </select>
        </div>

        {error && <div className="mb-4 text-red-400 text-sm">{error}</div>}
        {loadState === 'loading' && <div className="text-gray-400 py-12 text-center">Loading photos…</div>}
        {loadState === 'ready' && items.length === 0 && (
          <div className="text-gray-500 py-12 text-center">No photos match these filters.</div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {items.map((item) => (
            <button
              key={`${item.invoiceId}_${item.photoId}`}
              type="button"
              onClick={() => setViewer(item)}
              className="text-left bg-gray-800 border border-gray-700 rounded-lg overflow-hidden hover:border-yellow-500"
            >
              {item.displayUrl ? (
                <img src={item.displayUrl} alt="" className="w-full h-28 object-cover bg-black" />
              ) : (
                <div className="w-full h-28 bg-gray-700 text-[10px] text-gray-400 flex items-center justify-center">Pending delivery</div>
              )}
              <div className="p-2">
                <div className="text-[10px] uppercase tracking-wide text-yellow-500">{item.reviewStatus}</div>
                <div className="text-xs text-white truncate">{item.invoiceNumber || item.invoiceId}</div>
                <div className="text-[10px] text-gray-400 truncate">{item.driverName} · {item.photoType || 'photo'}</div>
              </div>
            </button>
          ))}
        </div>
      </main>

      {viewer && (
        <div className="fixed inset-0 z-40 bg-black/80 flex items-center justify-center p-4" onClick={() => setViewer(null)}>
          <div className="max-w-4xl w-full bg-gray-900 border border-gray-700 rounded-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center px-4 py-3 border-b border-gray-700">
              <div>
                <div className="text-white font-bold">Invoice {viewer.invoiceNumber || viewer.invoiceId}</div>
                <div className="text-xs text-gray-400">{viewer.driverName} · {viewer.pickup} → {viewer.dropoff} · {viewer.photoType}</div>
              </div>
              <button type="button" onClick={() => setViewer(null)} className="text-gray-400 hover:text-white text-xl">×</button>
            </div>
            <div className="p-4 grid md:grid-cols-2 gap-4">
              {viewer.displayUrl ? (
                <img src={viewer.displayUrl} alt="" className="w-full max-h-[70vh] object-contain bg-black rounded" />
              ) : (
                <div className="h-64 bg-gray-800 text-gray-400 flex items-center justify-center rounded">Original photo not yet delivered</div>
              )}
              <div className="text-sm text-gray-300 space-y-2">
                <p>Status: <span className="text-yellow-500 uppercase">{viewer.reviewStatus}</span></p>
                {viewer.rejectReason && <p>Reject reason: {viewer.rejectReason}</p>}
                {viewer.supervisorNote && <p>Supervisor note: {viewer.supervisorNote}</p>}
                {viewer.reviewedByLabel && <p>Reviewed by {viewer.reviewedByLabel}</p>}
                {viewer.addressedByLabel && <p>Addressed by {viewer.addressedByLabel}</p>}
                <a href={`/dispatch/?tab=completed&invoice=${encodeURIComponent(viewer.invoiceId)}`} className="inline-block text-yellow-400 hover:text-yellow-300">
                  Open Dispatch invoice →
                </a>
                {canMutate && (
                  <div className="flex flex-wrap gap-2 pt-3">
                    {viewer.reviewStatus !== 'addressed' && (
                      <button type="button" disabled={busy} onClick={() => void runReview('approve')} className="px-3 py-2 rounded bg-yellow-500 text-black text-xs font-semibold">
                        Approve
                      </button>
                    )}
                    {viewer.reviewStatus !== 'addressed' && (
                      <button type="button" disabled={busy} onClick={() => setRejectOpen(true)} className="px-3 py-2 rounded bg-red-600 text-white text-xs font-semibold">
                        Reject
                      </button>
                    )}
                    {viewer.reviewStatus === 'rejected' && (
                      <button type="button" disabled={busy} onClick={() => setAddressOpen(true)} className="px-3 py-2 rounded bg-gray-600 text-white text-xs font-semibold">
                        Mark addressed
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <WellBuiltDialog
        open={rejectOpen}
        title="Reject photo"
        primaryLabel="Reject"
        primaryTone="danger"
        primaryDisabled={busy || !rejectReason.trim()}
        onClose={() => setRejectOpen(false)}
        onPrimary={() => void runReview('reject')}
      >
        <p className="mb-3">This records a documentation/quality failure and that coaching is required. It does not request a retake and does not change the completed job, invoice, or PDF.</p>
        <label className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Reason (required)</label>
        <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-white mb-3" rows={3} />
        <label className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Supervisor note (optional)</label>
        <textarea value={supervisorNote} onChange={(e) => setSupervisorNote(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-white" rows={2} />
      </WellBuiltDialog>

      <WellBuiltDialog
        open={addressOpen}
        title="Mark coaching addressed"
        primaryLabel="Addressed"
        primaryDisabled={busy}
        onClose={() => setAddressOpen(false)}
        onPrimary={() => void runReview('address')}
      >
        <p className="mb-3">Use after the driver conversation. The original photo stays on the invoice.</p>
        <label className="block text-xs uppercase tracking-wide text-gray-400 mb-1">Note (optional)</label>
        <textarea value={addressedNote} onChange={(e) => setAddressedNote(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-white" rows={3} />
      </WellBuiltDialog>
    </div>
  );
}
