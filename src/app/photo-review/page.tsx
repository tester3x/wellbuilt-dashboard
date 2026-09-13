'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { hasCapability } from '@/lib/auth';
import { loadAllCompanies, type CompanyConfig } from '@/lib/companySettings';
import { adminGetDashboardCatalog } from '@/lib/adminDashboardCatalog';
import { WellBuiltDialog } from '@/components/WellBuiltDialog';
import {
  listDispatchPhotoReviews,
  reviewDispatchPhoto,
  type PhotoReviewListItem,
} from '@/lib/dispatchPhotoReview';
import {
  toIsoDate,
  toMdyDate,
  validateDateRange,
} from '@/lib/chicagoDate';
import {
  buildCanonicalDriverMap,
  resolveCanonicalDriverName,
  findMatchingCanonicalDriverIds,
} from '@/lib/canonicalDriverRoster';

type StatusFilter = 'all' | 'unreviewed' | 'approved' | 'rejected' | 'addressed';

const PAGE_SIZE = 25;

export default function PhotoReviewPage() {
  const { user, loading: authLoading, userCompany } = useAuth();
  const router = useRouter();

  const canView = hasCapability(user, 'viewDispatch', userCompany);
  // Mutating a photo review (approve/reject/address) is a dispatch write action,
  // so gate on the createDispatch capability rather than a single-role denylist.
  // The denylist ignored multi-role union (a payroll+dispatch user was wrongly
  // blocked when payroll resolved as the primary role) and let safety/lead —
  // which carry no dispatch write authority — through. reviewDispatchPhoto is the
  // real server authority; this keeps the UI gate consistent with that model.
  const canMutate = canView && hasCapability(user, 'createDispatch', userCompany);

  // Company context resolution:
  // Tenant-scoped users have user.companyId set.
  // Platform admins (user.companyId unset) must explicitly select a company.
  // NEVER default a platform admin silently to any company.
  const [companies, setCompanies] = useState<CompanyConfig[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);

  // Canonical driver roster map: driverId/UID/hash -> canonical legalName
  // Scoped strictly to effectiveCompanyId (tenant containment)
  const [driverMap, setDriverMap] = useState<Map<string, string>>(new Map());

  // Results & query state (initial load fetches zero photos)
  const [items, setItems] = useState<PhotoReviewListItem[]>([]);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [dateError, setDateError] = useState<string | null>(null);
  const [searchNotice, setSearchNotice] = useState<string | null>(null);
  const [lastQueryType, setLastQueryType] = useState<'search' | 'all' | null>(null);
  const [pageLimit, setPageLimit] = useState(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);

  // Per-card busy state to prevent double submits
  const [cardBusy, setCardBusy] = useState<Record<string, boolean>>({});

  const [filters, setFilters] = useState({
    dateFrom: '',
    dateTo: '',
    driver: '',
    ticketOrJob: '',
    pickup: '',
    dropoff: '',
    photoType: '',
    reviewStatus: 'all' as StatusFilter,
  });

  // Modal / inspector state
  const [viewer, setViewer] = useState<PhotoReviewListItem | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PhotoReviewListItem | null>(null);
  const [addressTarget, setAddressTarget] = useState<PhotoReviewListItem | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [supervisorNote, setSupervisorNote] = useState('');
  const [addressedNote, setAddressedNote] = useState('');

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

  // Load canonical driver roster scoped to effectiveCompanyId
  useEffect(() => {
    if (!user || !effectiveCompanyId) {
      setDriverMap(new Map());
      return;
    }
    let cancelled = false;
    adminGetDashboardCatalog()
      .then((catalog) => {
        if (cancelled) return;
        const map = buildCanonicalDriverMap(catalog, effectiveCompanyId);
        setDriverMap(map);
      })
      .catch((err) => {
        console.warn('Failed to load canonical driver catalog:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [user, effectiveCompanyId]);

  // When company context changes, reset results and state — DO NOT auto-fetch
  const handleCompanyChange = (newCid: string | null) => {
    setSelectedCompanyId(newCid);
    setItems([]);
    setLoadState('idle');
    setError('');
    setDateError(null);
    setSearchNotice(null);
    setLastQueryType(null);
    setPageLimit(PAGE_SIZE);
    setHasMore(false);
  };

  // Helper: check if at least one search filter is specified
  const hasFilterCriteria = useCallback((): boolean => {
    return !!(
      filters.dateFrom.trim() ||
      filters.dateTo.trim() ||
      filters.driver.trim() ||
      filters.ticketOrJob.trim() ||
      filters.pickup.trim() ||
      filters.dropoff.trim() ||
      filters.photoType ||
      (filters.reviewStatus && filters.reviewStatus !== 'all')
    );
  }, [filters]);

  // Server-filtered query executor with America/Chicago date boundaries
  const executeQuery = useCallback(
    async (queryType: 'search' | 'all', limit: number) => {
      if (!user || !canView || !effectiveCompanyId) return;

      // Validate date entry using America/Chicago boundaries
      const dateValidation = validateDateRange(filters.dateFrom, filters.dateTo);
      if (!dateValidation.valid) {
        setDateError(dateValidation.error || 'Invalid date range.');
        return;
      }
      setDateError(null);

      setLoadState('loading');
      setError('');
      setSearchNotice(null);

      try {
        const payload: Record<string, unknown> = {
          companyId: effectiveCompanyId,
          limit,
        };

        if (queryType === 'search') {
          if (dateValidation.dateFromMs !== undefined) {
            payload.dateFromMs = dateValidation.dateFromMs;
          }
          if (dateValidation.dateToMs !== undefined) {
            payload.dateToMs = dateValidation.dateToMs;
          }
          if (filters.driver.trim()) {
            const matchingIds = findMatchingCanonicalDriverIds(driverMap, filters.driver);
            if (matchingIds.size === 1) {
              payload.driver = [...matchingIds][0];
            } else {
              payload.driver = filters.driver.trim();
            }
          }
          if (filters.ticketOrJob.trim()) payload.ticketOrJob = filters.ticketOrJob.trim();
          if (filters.pickup.trim()) payload.pickup = filters.pickup.trim();
          if (filters.dropoff.trim()) payload.dropoff = filters.dropoff.trim();
          if (filters.photoType) payload.photoType = filters.photoType;
          payload.reviewStatus = filters.reviewStatus;
        } else {
          // 'all' photos explicit request
          payload.reviewStatus = filters.reviewStatus || 'all';
        }

        const data = await listDispatchPhotoReviews(payload);
        const serverCount = (data.items || []).length;
        let fetched = data.items || [];

        // When searching by driver name, filter client results strictly by canonical legal name
        if (queryType === 'search' && filters.driver.trim()) {
          const q = filters.driver.trim().toLowerCase();
          fetched = fetched.filter((it) => {
            const canonicalName = resolveCanonicalDriverName(driverMap, it.driverId).toLowerCase();
            return canonicalName.includes(q);
          });
        }

        setItems(fetched);
        // hasMore must reflect what the SERVER returned, not the client-filtered
        // count — otherwise an active driver filter that drops rows below `limit`
        // hides "Load More" and silently truncates results.
        setHasMore(serverCount >= limit);
        setPageLimit(limit);
        setLastQueryType(queryType);
        setLoadState('ready');
      } catch (e: unknown) {
        setLoadState('error');
        const rawMsg = e instanceof Error ? e.message : 'Failed to load photo reviews';
        if (rawMsg.includes('companyId_required')) {
          setError('Please select a company to review inspection photos.');
        } else {
          setError(rawMsg);
        }
      }
    },
    [user, canView, effectiveCompanyId, filters, driverMap],
  );

  // Search button click handler
  const handleSearch = () => {
    if (!effectiveCompanyId) {
      setSearchNotice('Please select a company context first.');
      return;
    }
    if (!hasFilterCriteria()) {
      setSearchNotice(
        'Please enter at least one filter criterion to search, or click "All Photos" to view recent records.',
      );
      return;
    }
    setPageLimit(PAGE_SIZE);
    void executeQuery('search', PAGE_SIZE);
  };

  // All Photos button click handler
  const handleAllPhotos = () => {
    if (!effectiveCompanyId) {
      setSearchNotice('Please select a company context first.');
      return;
    }
    setDateError(null);
    setSearchNotice(null);
    setPageLimit(PAGE_SIZE);
    void executeQuery('all', PAGE_SIZE);
  };

  // Clear button click handler
  const handleClear = () => {
    setFilters({
      dateFrom: '',
      dateTo: '',
      driver: '',
      ticketOrJob: '',
      pickup: '',
      dropoff: '',
      photoType: '',
      reviewStatus: 'all',
    });
    setItems([]);
    setLoadState('idle');
    setError('');
    setDateError(null);
    setSearchNotice(null);
    setLastQueryType(null);
    setPageLimit(PAGE_SIZE);
    setHasMore(false);
  };

  // Load More button click handler (bounded pagination)
  const handleLoadMore = () => {
    if (!lastQueryType) return;
    const nextLimit = pageLimit + PAGE_SIZE;
    void executeQuery(lastQueryType, nextLimit);
  };

  // Execute review mutation and update affected card locally without refetching the whole list
  async function runReview(
    target: PhotoReviewListItem,
    action: 'approve' | 'reject' | 'address',
    notes?: { rejectReason?: string; supervisorNote?: string; addressedNote?: string },
  ) {
    if (!effectiveCompanyId) return;

    // Safety guard: never allow review of a missing image
    if (!target.displayUrl || target.deliveryPending) {
      setError('Cannot review a photo that has not synced or lacks verified Storage linkage.');
      return;
    }

    const key = `${target.invoiceId}_${target.photoId}`;
    setCardBusy((prev) => ({ ...prev, [key]: true }));

    try {
      const res = await reviewDispatchPhoto({
        companyId: effectiveCompanyId,
        invoiceId: target.invoiceId,
        photoId: target.photoId,
        action,
        rejectReason: notes?.rejectReason,
        supervisorNote: notes?.supervisorNote,
        addressedNote: notes?.addressedNote,
      });

      const nextStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'addressed';

      // Update ONLY the affected card in items
      setItems((prev) =>
        prev.map((it) => {
          if (it.invoiceId === target.invoiceId && it.photoId === target.photoId) {
            return {
              ...it,
              reviewStatus: nextStatus,
              reviewedAtMs: res.reviewedAtMs,
              reviewedByLabel: user?.email || 'Office',
              rejectReason: notes?.rejectReason || it.rejectReason,
              supervisorNote: notes?.supervisorNote || it.supervisorNote,
              addressedNote: notes?.addressedNote || it.addressedNote,
              addressedAtMs: res.addressedAtMs,
            };
          }
          return it;
        }),
      );

      // If inspector modal is open for this item, update it locally
      if (viewer && viewer.invoiceId === target.invoiceId && viewer.photoId === target.photoId) {
        setViewer((prev) =>
          prev
            ? {
                ...prev,
                reviewStatus: nextStatus,
                reviewedAtMs: res.reviewedAtMs,
                reviewedByLabel: user?.email || 'Office',
                rejectReason: notes?.rejectReason || prev.rejectReason,
                supervisorNote: notes?.supervisorNote || prev.supervisorNote,
                addressedNote: notes?.addressedNote || prev.addressedNote,
                addressedAtMs: res.addressedAtMs,
              }
            : null,
        );
      }

      setRejectTarget(null);
      setAddressTarget(null);
      setRejectReason('');
      setSupervisorNote('');
      setAddressedNote('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Review action failed');
    } finally {
      setCardBusy((prev) => ({ ...prev, [key]: false }));
    }
  }

  // Capability protection fallback
  if (authLoading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-gray-400 text-lg">Loading...</div>
      </div>
    );
  }

  if (!user) return null;

  if (!canView) {
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
            {/* Natural Keyboard Tab Order step 1: Company selector */}
            {!user?.companyId && (
              <div className="flex items-center gap-2">
                <label
                  htmlFor="company-context-selector"
                  className="text-sm font-medium text-gray-300 whitespace-nowrap"
                >
                  Company:
                </label>
                <select
                  id="company-context-selector"
                  value={selectedCompanyId || ''}
                  onChange={(e) => handleCompanyChange(e.target.value || null)}
                  className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 shrink-0 min-w-[14rem]"
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
          </div>
        </div>

        {/* Missing Company Guidance Card (Platform Admin before explicit selection) */}
        {!effectiveCompanyId && (
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-12 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-blue-900/40 border border-blue-700/50 flex items-center justify-center text-blue-400 mb-3">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                />
              </svg>
            </div>
            <h3 className="text-base font-semibold text-white mb-1">Select a Company Context</h3>
            <p className="text-gray-400 text-sm max-w-md mx-auto">
              As a platform administrator, select a company from the toolbar above to review inspection photos.
            </p>
          </div>
        )}

        {/* Governed Filter Card - only rendered when company context is active */}
        {/* Natural DOM Order: Start Date → End Date → Driver → Ticket/Invoice → Pickup → Drop-off → Photo Type → Review Status → Search → All Photos → Clear */}
        {effectiveCompanyId && (
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 shadow-sm">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Filter Records
            </div>

            {/* Filter Inputs Grid in strict natural Tab order */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
              {/* 1. Start Date (Typed MM/DD/YYYY or calendar picker) */}
              <div>
                <label htmlFor="filter-date-from" className="block text-xs font-medium text-gray-300 mb-1">
                  Start Date
                </label>
                <div className="relative flex items-center">
                  <input
                    id="filter-date-from"
                    type="text"
                    placeholder="MM/DD/YYYY"
                    value={filters.dateFrom}
                    onChange={(e) => {
                      setFilters({ ...filters, dateFrom: e.target.value });
                      setDateError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSearch();
                    }}
                    className={`w-full bg-gray-900 text-white text-sm rounded-lg pl-3 pr-9 py-2 border ${
                      dateError && dateError.includes('Start Date')
                        ? 'border-red-500 focus:border-red-500 focus:ring-1 focus:ring-red-500'
                        : 'border-gray-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
                    } focus:outline-none`}
                  />
                  <input
                    type="date"
                    tabIndex={-1}
                    aria-hidden="true"
                    value={toIsoDate(filters.dateFrom)}
                    onChange={(e) => {
                      if (e.target.value) {
                        setFilters({ ...filters, dateFrom: toMdyDate(e.target.value) });
                        setDateError(null);
                      }
                    }}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 opacity-0 cursor-pointer pointer-events-auto"
                    title="Select start date"
                  />
                  <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                  </div>
                </div>
              </div>

              {/* 2. End Date (Typed MM/DD/YYYY or calendar picker) */}
              <div>
                <label htmlFor="filter-date-to" className="block text-xs font-medium text-gray-300 mb-1">
                  End Date
                </label>
                <div className="relative flex items-center">
                  <input
                    id="filter-date-to"
                    type="text"
                    placeholder="MM/DD/YYYY"
                    value={filters.dateTo}
                    onChange={(e) => {
                      setFilters({ ...filters, dateTo: e.target.value });
                      setDateError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSearch();
                    }}
                    className={`w-full bg-gray-900 text-white text-sm rounded-lg pl-3 pr-9 py-2 border ${
                      dateError && dateError.includes('End Date')
                        ? 'border-red-500 focus:border-red-500 focus:ring-1 focus:ring-red-500'
                        : 'border-gray-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
                    } focus:outline-none`}
                  />
                  <input
                    type="date"
                    tabIndex={-1}
                    aria-hidden="true"
                    value={toIsoDate(filters.dateTo)}
                    onChange={(e) => {
                      if (e.target.value) {
                        setFilters({ ...filters, dateTo: toMdyDate(e.target.value) });
                        setDateError(null);
                      }
                    }}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 opacity-0 cursor-pointer pointer-events-auto"
                    title="Select end date"
                  />
                  <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                  </div>
                </div>
              </div>

              {/* 3. Driver Name (Canonical legalName search) */}
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSearch();
                  }}
                  className="w-full bg-gray-900 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>

              {/* 4. Ticket / Invoice */}
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSearch();
                  }}
                  className="w-full bg-gray-900 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>

              {/* 5. Pickup Location */}
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSearch();
                  }}
                  className="w-full bg-gray-900 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>

              {/* 6. Drop-off Location */}
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSearch();
                  }}
                  className="w-full bg-gray-900 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>

              {/* 7. Photo Type */}
              <div>
                <label htmlFor="filter-photo-type" className="block text-xs font-medium text-gray-300 mb-1">
                  Photo Type
                </label>
                <select
                  id="filter-photo-type"
                  value={filters.photoType}
                  onChange={(e) => setFilters({ ...filters, photoType: e.target.value })}
                  className="w-full bg-gray-900 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">All photo types</option>
                  <option value="pickup">Pickup</option>
                  <option value="dropoff">Drop-off</option>
                </select>
              </div>

              {/* 8. Review Status */}
              <div>
                <label htmlFor="filter-status" className="block text-xs font-medium text-gray-300 mb-1">
                  Review Status
                </label>
                <select
                  id="filter-status"
                  value={filters.reviewStatus}
                  onChange={(e) => setFilters({ ...filters, reviewStatus: e.target.value as StatusFilter })}
                  className="w-full bg-gray-900 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  <option value="all">All statuses</option>
                  <option value="unreviewed">Unreviewed</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                  <option value="addressed">Addressed</option>
                </select>
              </div>
            </div>

            {/* Inline Date Validation Error or Notices */}
            {(dateError || searchNotice) && (
              <div className="mt-3 text-xs font-medium text-amber-400 flex items-center gap-1.5">
                <span>⚠️</span>
                <span>{dateError || searchNotice}</span>
              </div>
            )}

            {/* Action Buttons in natural DOM tab order: Search → All Photos → Clear */}
            <div className="flex flex-wrap items-center justify-end gap-2 mt-4 pt-3 border-t border-gray-700/60">
              <button
                type="button"
                id="action-search"
                onClick={handleSearch}
                disabled={loadState === 'loading'}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {loadState === 'loading' && lastQueryType === 'search' ? (
                  <span className="animate-spin">↻</span>
                ) : null}
                Search
              </button>

              <button
                type="button"
                id="action-all-photos"
                onClick={handleAllPhotos}
                disabled={loadState === 'loading'}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {loadState === 'loading' && lastQueryType === 'all' ? (
                  <span className="animate-spin">↻</span>
                ) : null}
                All Photos
              </button>

              <button
                type="button"
                id="action-clear"
                onClick={handleClear}
                className="px-3 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {/* Friendly Error Banner */}
        {error && (
          <div className="p-4 bg-red-900/40 border border-red-800 rounded-xl flex items-start gap-3">
            <span className="text-red-400 text-base leading-none">⚠️</span>
            <div className="flex-1">
              <div className="text-sm font-medium text-red-200">Unable to load photo reviews</div>
              <p className="text-xs text-red-400 mt-0.5">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => void executeQuery(lastQueryType || 'all', pageLimit)}
              className="text-xs font-medium text-red-300 hover:text-white underline shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* Initial Idle Guidance State (Zero photos requested until Search / All Photos clicked) */}
        {loadState === 'idle' && effectiveCompanyId && (
          <div className="bg-gray-800 border border-gray-700 rounded-xl py-16 px-6 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-gray-700/50 border border-gray-600 flex items-center justify-center text-gray-300 mb-3">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
            <h3 className="text-base font-semibold text-white mb-1">Ready to Search Photos</h3>
            <p className="text-gray-400 text-sm max-w-md mx-auto mb-4">
              Enter filter criteria and click <strong>Search</strong>, or click <strong>All Photos</strong> to browse recent records.
            </p>
          </div>
        )}

        {/* Loading Skeleton State */}
        {loadState === 'loading' && items.length === 0 && effectiveCompanyId && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden animate-pulse h-64 flex flex-col"
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
              onClick={handleClear}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Reset Filters
            </button>
          </div>
        )}

        {/* Ready Photo Grid */}
        {items.length > 0 && effectiveCompanyId && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {items.map((item) => {
                const itemKey = `${item.invoiceId}_${item.photoId}`;
                const isItemBusy = !!cardBusy[itemKey];
                const hasValidImage = !!item.displayUrl && !item.deliveryPending;
                const canonicalDriver = resolveCanonicalDriverName(driverMap, item.driverId);

                const statusClass =
                  item.reviewStatus === 'approved'
                    ? 'bg-green-900/60 text-green-300 border-green-700/50'
                    : item.reviewStatus === 'rejected'
                      ? 'bg-red-900/60 text-red-300 border-red-700/50'
                      : item.reviewStatus === 'addressed'
                        ? 'bg-gray-700 text-gray-300 border-gray-600'
                        : 'bg-amber-900/60 text-amber-300 border-amber-700/50';

                return (
                  <div
                    key={itemKey}
                    className="bg-gray-800 border border-gray-700 hover:border-gray-600 rounded-xl overflow-hidden text-left flex flex-col transition-all shadow-sm"
                  >
                    {/* Thumbnail Image Button (Natural Tab order step: thumbnail click opens inspector) */}
                    <button
                      type="button"
                      onClick={() => setViewer(item)}
                      className="relative aspect-video w-full bg-black/60 flex items-center justify-center overflow-hidden group focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                      aria-label={`Inspect photo for ticket ${item.ticketNumber || item.invoiceNumber}`}
                    >
                      {hasValidImage ? (
                        <img
                          src={item.displayUrl!}
                          alt=""
                          loading="lazy"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                        />
                      ) : (
                        <div className="flex flex-col items-center justify-center p-3 text-center text-yellow-400">
                          <svg
                            className="w-6 h-6 mb-1 text-yellow-500"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                            />
                          </svg>
                          <span className="text-[11px] font-semibold text-yellow-300">
                            Waiting for photo upload
                          </span>
                          <span className="text-[9px] text-gray-400 mt-0.5">
                            Not yet synced from field
                          </span>
                        </div>
                      )}
                      <span
                        className={`absolute top-2 right-2 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border backdrop-blur-sm ${statusClass}`}
                      >
                        {item.reviewStatus}
                      </span>
                    </button>

                    {/* Metadata Body — Driver name strictly resolved to canonical profile name */}
                    <div className="p-3 flex flex-col gap-1 w-full text-xs flex-1">
                      <div className="flex items-center justify-between gap-1 text-gray-400 text-[11px]">
                        <span className="font-semibold text-white capitalize">{item.photoType || 'Photo'}</span>
                        <span>{item.takenAt ? item.takenAt.split('T')[0] : '—'}</span>
                      </div>

                      <div className="text-gray-200 font-medium truncate" title={canonicalDriver}>
                        {canonicalDriver}
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

                    {/* Card Actions: Approve and Reject directly on thumbnail card */}
                    {canMutate && (
                      <div className="p-3 pt-0 mt-auto border-t border-gray-700/60 flex flex-wrap gap-2">
                        {item.reviewStatus !== 'approved' && item.reviewStatus !== 'addressed' && (
                          <>
                            <button
                              type="button"
                              disabled={isItemBusy || !hasValidImage}
                              onClick={() => void runReview(item, 'approve')}
                              className="flex-1 min-w-[4.5rem] px-2.5 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white font-semibold text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-green-500"
                              title={!hasValidImage ? 'Waiting for photo upload' : 'Approve photo'}
                            >
                              {isItemBusy ? 'Saving...' : 'Approve'}
                            </button>
                            <button
                              type="button"
                              disabled={isItemBusy || !hasValidImage}
                              onClick={() => {
                                setRejectTarget(item);
                                setRejectReason('');
                                setSupervisorNote('');
                              }}
                              className="flex-1 min-w-[4.5rem] px-2.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-red-500"
                              title={!hasValidImage ? 'Waiting for photo upload' : 'Reject photo'}
                            >
                              Reject
                            </button>
                          </>
                        )}
                        {item.reviewStatus === 'rejected' && (
                          <button
                            type="button"
                            disabled={isItemBusy}
                            onClick={() => {
                              setAddressTarget(item);
                              setAddressedNote('');
                            }}
                            className="w-full px-2.5 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-white font-semibold text-xs transition-colors disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            Mark Coaching Addressed
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Bounded Pagination: Load More Photos button */}
            {hasMore && (
              <div className="flex justify-center pt-2 pb-6">
                <button
                  type="button"
                  id="action-load-more"
                  onClick={handleLoadMore}
                  disabled={loadState === 'loading'}
                  className="px-6 py-2.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl text-sm font-semibold text-white transition-colors flex items-center gap-2 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {loadState === 'loading' ? <span className="animate-spin">↻</span> : null}
                  Load More Photos
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Photo Inspector Modal (Opens full-resolution view on thumbnail click) */}
      {viewer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-4xl max-h-[90vh] rounded-xl border border-gray-700 bg-gray-900 shadow-2xl flex flex-col overflow-hidden">
            {/* Modal Header — Canonical real driver legalName */}
            <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
              <div>
                <h2 className="text-base font-bold text-white capitalize">
                  {viewer.photoType || 'Photo'} Inspection
                </h2>
                <p className="text-xs text-gray-400">
                  Ticket {viewer.ticketNumber || viewer.invoiceNumber} &bull; Driver:{' '}
                  {resolveCanonicalDriverName(driverMap, viewer.driverId)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setViewer(null)}
                className="text-gray-400 hover:text-white text-2xl leading-none px-2 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
                aria-label="Close"
              >
                &times;
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 grid md:grid-cols-2 gap-5 overflow-y-auto">
              <div className="bg-black rounded-xl overflow-hidden flex items-center justify-center min-h-[16rem]">
                {viewer.displayUrl && !viewer.deliveryPending ? (
                  <img
                    src={viewer.displayUrl}
                    alt=""
                    className="w-full max-h-[60vh] object-contain rounded"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center p-6 text-center text-yellow-400">
                    <svg
                      className="w-8 h-8 mb-2 text-yellow-500"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                      />
                    </svg>
                    <span className="text-sm font-semibold text-yellow-300">
                      Waiting for photo upload
                    </span>
                    <span className="text-xs text-gray-400 mt-1 max-w-xs">
                      Original photo has not yet synced from field device. Review actions are disabled until upload completes.
                    </span>
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
                        disabled={
                          !viewer.displayUrl ||
                          viewer.deliveryPending ||
                          !!cardBusy[`${viewer.invoiceId}_${viewer.photoId}`]
                        }
                        onClick={() => void runReview(viewer, 'approve')}
                        className="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white font-semibold text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-green-500"
                      >
                        Approve Photo
                      </button>
                    )}
                    {viewer.reviewStatus !== 'rejected' && viewer.reviewStatus !== 'addressed' && (
                      <button
                        type="button"
                        disabled={
                          !viewer.displayUrl ||
                          viewer.deliveryPending ||
                          !!cardBusy[`${viewer.invoiceId}_${viewer.photoId}`]
                        }
                        onClick={() => {
                          setRejectTarget(viewer);
                          setRejectReason('');
                          setSupervisorNote('');
                        }}
                        className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-red-500"
                      >
                        Reject Photo
                      </button>
                    )}
                    {viewer.reviewStatus === 'rejected' && (
                      <button
                        type="button"
                        disabled={!!cardBusy[`${viewer.invoiceId}_${viewer.photoId}`]}
                        onClick={() => {
                          setAddressTarget(viewer);
                          setAddressedNote('');
                        }}
                        className="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white font-semibold text-xs transition-colors disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
        open={!!rejectTarget}
        title="Reject Inspection Photo"
        primaryLabel="Reject Photo"
        primaryTone="danger"
        primaryDisabled={
          !rejectTarget ||
          !rejectReason.trim() ||
          !!cardBusy[`${rejectTarget.invoiceId}_${rejectTarget.photoId}`]
        }
        onClose={() => setRejectTarget(null)}
        onPrimary={() => {
          if (rejectTarget) {
            void runReview(rejectTarget, 'reject', { rejectReason, supervisorNote });
          }
        }}
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
        open={!!addressTarget}
        title="Mark Coaching Addressed"
        primaryLabel="Complete Coaching"
        primaryDisabled={
          !addressTarget || !!cardBusy[`${addressTarget.invoiceId}_${addressTarget.photoId}`]
        }
        onClose={() => setAddressTarget(null)}
        onPrimary={() => {
          if (addressTarget) {
            void runReview(addressTarget, 'address', { addressedNote });
          }
        }}
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
