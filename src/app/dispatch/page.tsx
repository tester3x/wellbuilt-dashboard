'use client';

import { useEffect, useState, useMemo, useCallback, Suspense, type ReactNode } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useSessionDeepLinkState } from '@/lib/useSessionDeepLinkState';
import { pruneExpandedGroups } from '@/lib/expandedGroupsRestoreCore';
import { operationalDriverName } from '@/lib/operationalDriverName';
import { shiftDotForDriver, type ShiftResolveResult } from '@/lib/shiftDotCore';
import { resolveCompanyDriverShifts } from '@/lib/resolveCompanyDriverShifts';
import { comparePhysicalJobs, recommendedNextJobId, type PhysicalJobRankInput } from '@/lib/physicalJobOrder';
import { buildWellQueueRankIndex, rankJob } from '@/lib/activeJobsRank';
import { jobTypeAcronym, jobTypeCode } from '@/lib/jobTypeAcronym';
import { useScrollRestore } from '@/lib/useScrollRestore';
import { WellResponse, mergeWellPool, matchWellInPool } from '@/lib/wells';
import { getPriority, getWellPrediction, formatTTP, matchesView, wellBucket, classifyWell, compareQueueRows, inchesToLevel, formatAge, verifyReasonText, type QueueView } from '@/lib/dispatchPriority';
import { pwLifecycle, PW_ACTIVE_STATUSES, isStaleCompletedReentry } from '@/lib/dispatchAssignmentGroups';
import { useSharedNow } from '@/lib/useSharedNow';
import { projectWellLevel } from '@/lib/wellLevelProjection';
import { wellDetailHref } from '@/lib/wellDetailLink';
import { resolveDispatchDriver, dispatchDriverDisplayName, dispatchDriverGroupKey } from '@/lib/dispatchDriverIdentity';
import { assignmentIdentityForDriver, driverRealName } from '@/lib/dispatchWriterIdentity';
// Z Fold recovery — layout helpers only (collapsed queue / stacked layout).
// Live status is read via the governed adminGetWellPool callable (see effect
// below); the direct-client RTDB status path is claim-gated and not attempted.
import {
  isStackedDispatchLayout,
  wellQueueSearchActive,
  wellQueueUsesSearchHits,
} from '@/lib/dispatchWellQueueLive';
import { adminGetDashboardCatalog, adminGetWellPool, classifiedReadFailure } from '@/lib/adminDashboardCatalog';
import { canViewGlobalWellPool, docBelongsToTenant } from '@/lib/tenantScope';
import { AppHeader } from '@/components/AppHeader';
import { DetachablePane } from '@/components/DetachablePane';
import { getFirestoreDb } from '@/lib/firebase';
import { AddPullModal } from '@/components/AddPullModal';
import { collection, addDoc, getDocs, getDoc, setDoc, query, where, orderBy, Timestamp, doc, updateDoc, onSnapshot, deleteDoc } from 'firebase/firestore';
import { loadDisposals, searchDisposals, type NdicWell, loadOperators, searchOperators, type NdicOperator, loadWellsForOperator } from '@/lib/firestoreWells';
import { calculateDriverETAs, applyDeadline, type DriverEtaResult } from '@/lib/driverEta';
import { loadCompanyById } from '@/lib/companySettings';
import { trackJobTypeUsage } from '@/lib/jobTypeUsage';
import { dismissDispatch as _dismissDispatch } from '@/lib/dismissDispatch';
import { staffCancelDispatch as _staffCancelDispatch, staffCreateDispatch as _staffCreateDispatch, staffUpdateDispatch as _staffUpdateDispatch } from '@/lib/staffWriteDispatch';
import { hasCapability } from '@/lib/auth';
import {
  filterTicketsForCompany,
  invoiceBelongsToCompany,
  planInvoiceLookup,
  planTicketFetch,
  scopeCompanyId,
} from '@/lib/ticketCompanyLookup';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ApprovedDriver {
  key: string;           // drivers/approved record key (canonical UUID OR legacy passcodeHash)
  driverId?: string;     // immutable canonical driver id (preferred join key)
  legacyAliases?: string[]; // governed legacy hashes/ids bound to this driver
  displayName: string;
  legalName?: string;    // Real name from registration (e.g. "Michael Burger")
  loginAlias?: string;   // Login/username (drivers/approved `name`) — NEVER displayed; used only to guard displayName against login leakage
  active?: boolean;
  companyId?: string;
  companyName?: string;
  assignedRoutes?: string[];
  phone?: string;        // From profile subpath (WB S settings)
  onShift?: boolean;     // Live shift status from driver_shifts
}

interface DispatchJob {
  id?: string;
  // Tenant stamp (7/9): present on WB-T-era dispatch docs; legacy docs may
  // lack it (treated as liquid-gold's by docBelongsToTenant).
  companyId?: string;
  driverHash: string;
  driverName: string;
  driverFirstName?: string;  // First name from legalName (privacy — don't expose logins)
  wellName: string;
  ndicWellName?: string;  // Full NDIC name (e.g. "GABRIEL 1-36-25H")
  operator?: string;
  route?: string;
  jobType: 'pw' | 'service';
  serviceType?: string;
  packageId?: string;  // Job package ID (e.g. 'water-hauling', 'aggregate')
  status: 'pending' | 'pending_approval' | 'accepted' | 'in_progress' | 'paused' | 'completed' | 'cancelled' | 'declined' | 'dismissed';
  notes?: string;
  priority: number;
  assignedAt: any;  // Firestore Timestamp
  assignedBy: string;
  completedAt?: any;
  // Decline fields — written by WB T when driver declines
  declinedAt?: any;
  declineReason?: string;
  declinedBy?: string;
  estimatedPullTime?: string;
  currentLevel?: string;
  flowRate?: string;
  disposal?: string;  // Pre-assigned SWD disposal location
  disposalLat?: number;
  disposalLng?: number;
  disposalApiNo?: string;
  disposalLegalDesc?: string;
  disposalCounty?: string;
  loadCount?: number;  // Number of loads for this well (default 1)
  loadsCompleted?: number;  // How many loads finished so far
  serviceGroupId?: string;  // Links multi-driver service work dispatches
  assignedDrivers?: string[];  // Crew list for multi-driver service work (denormalized)
  // Load transfer fields
  type?: 'dispatch' | 'transfer';
  transferFromDriver?: string;
  transferFromDriverHash?: string;
  sourceInvoiceDocId?: string;
  sourceInvoiceNumber?: string;
  intendedDriverHash?: string;
  intendedDriverName?: string;
  // Why the driver requested transfer — written by sender's TransferModal
  // (one of the standardized reasons or trimmed Other text). Surfaced on
  // pending-approval transfer cards so the dispatcher knows why the load
  // is moving before they reassign.
  transferReason?: string;
  // Driver stage — written by WB T at each state transition
  driverStage?: 'en_route_pickup' | 'on_site_pickup' | 'en_route_dropoff' | 'on_site_dropoff' | 'paused' | 'completed';
  driverDest?: string;  // Where driver is heading (well name or SWD name)
  stageUpdatedAt?: any;
  // Driver GPS — written by WB T updateDriverStage() for Dashboard ETA
  driverLat?: number;
  driverLng?: number;
  driverGpsAt?: string;
  // Service work fields
  disposalName?: string;  // LEGACY — old SW docs used this. New ones write `disposal`
  onsiteBy?: string;  // "Be onsite by" deadline (HH:MM)
  // Live job info — written by WB T as driver progresses
  invoiceNumber?: string;  // Invoice # for this dispatch (i+t mode)
  ticketNumber?: string;  // Ticket # for this dispatch (s_t mode)
  hauledTo?: string;  // Current drop-off destination (driver may change mid-job)
  totalBBL?: number;  // Total BBLs hauled (written on job complete)
  // Driver-initiated job tracking (liveDispatchSync)
  source?: 'driver';  // Present when driver started the job (not dispatched)
  invoiceDocId?: string;  // Firestore invoice doc ID
  // Project link
  projectId?: string;  // Links this dispatch to a project
  // Split ticket fields
  splitGroupId?: string;  // Links split ticket jobs (A→B→C chain)
  splitSequence?: number;  // 1=first job, 2=second, etc.
  splitTotal?: number;     // Total legs in the chain — maintained by dashboard
                           // creation + dashboard:addSplitLeg CF when a field-
                           // added leg increments the chain.
  bbls?: number;           // Per-leg planned BBLs (optional). Used as the
                           // pre-fill for the driver's form on accept.
  // Heavy water flag
  isHeavyWater?: boolean;  // 10+ lb heavy water — separate billing rate
}

// ─── Project Types ────────────────────────────────────────────────────────

interface ProjectUpdate {
  text: string;
  author: string;
  shift: 'day' | 'night';
  timestamp: string;           // ISO
}

interface Project {
  id?: string;
  name: string;
  wellNames: string[];
  operatorName: string;
  companyId?: string;
  createdBy: string;
  createdAt: any;
  startDate: string;           // ISO date
  projectedEndDate?: string;   // ISO date
  actualEndDate?: string;
  status: 'active' | 'paused' | 'completed';
  jobType?: 'service' | 'pw';  // Default: 'service' (99% of projects are SW)
  serviceType?: string;        // e.g. 'Flowback', 'Rig Move', 'Mud Move'
  notes?: string;              // Job description (editable)
  updates?: ProjectUpdate[];   // Shift handoff log
  dayDriverHashes?: string[];  // Day shift drivers
  nightDriverHashes?: string[];// Night shift drivers
  driverSchedule: { [isoDate: string]: string[] }; // date -> driverHashes (legacy)
  driverDisposals?: { [driverHash: string]: { name: string; lat?: number; lng?: number } }; // Per-driver SWD assignment
}

interface ProjectInvoice {
  id: string;
  invoiceNumber?: string;
  driverName?: string;
  wellName?: string;
  totalBarrels?: number;
  createdAt: any;
  status?: string;
  ticketCount?: number;
}


/** Read a navigable-state param from the CURRENT url on first client render, so a
 *  reload restores the exact location instead of the default. SSR-safe (null on server). */
function readInitialParam(key: string): string | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get(key);
  return v && v.length ? v : null;
}

function formatDispatchTime(ts: any): string {
  if (!ts) return '--';
  try {
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    return date.toLocaleString('en-US', {
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '--';
  }
}

function timeAgo(ts: any): string {
  if (!ts) return '';
  try {
    const date = ts.toDate ? ts.toDate() : (ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts));
    if (isNaN(date.getTime())) return '';
    const diffMs = Date.now() - date.getTime();
    if (diffMs < 0) return 'just now';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  } catch {
    return '';
  }
}

/** Per-row assignment presentation for the Well Queue. */
type RowAssignment =
  | { state: 'assigned_not_started' | 'assigned_started'; driver: string; job: DispatchJob; status: string }
  | null;

// ─── Main Component ──────────────────────────────────────────────────────────

function DispatchPageInner() {
  const { user, loading, userCompany } = useAuth();
  const router = useRouter();
  const dispatchPathname = usePathname();
  // Restore scroll position across refresh (session-scoped; restores after data lays out).
  useScrollRestore(
    { uid: user?.uid ?? null, companyId: user?.companyId || userCompany?.id || null, pathname: dispatchPathname },
    { elementSelector: '[data-dashboard-scroll="dispatch"]', ready: !loading && !!user },
  );

  // Capability gate for ALL dispatch mutations. The Dispatch tab is visible to
  // any role with `viewDispatch` (e.g. `viewer`), but only `createDispatch`
  // roles may write. Rather than gate dozens of scattered buttons, every
  // mutation is funneled through these guarded wrappers: a view-only user gets
  // a clear message and the callable is never invoked. The server enforces the
  // same rule; this removes the misleading always-failing buttons in the UI.
  const canCreateDispatch = hasCapability(user, 'createDispatch');
  const DISPATCH_VIEW_ONLY_MSG =
    'You have view-only dispatch access — ask an admin for dispatch permissions to make changes.';
  const ensureCanCreateDispatch = () => {
    if (!canCreateDispatch) throw new Error(DISPATCH_VIEW_ONLY_MSG);
  };
  // Early-return guard (with a visible message) for the direct-Firestore project
  // handlers, which don't go through the dispatch callable wrappers above. Keeps
  // Projects/driver-disposal writes behind the same createDispatch capability.
  const guardCreateDispatch = () => {
    if (!canCreateDispatch) {
      setMessage(DISPATCH_VIEW_ONLY_MSG);
      setTimeout(() => setMessage(''), 5000);
      return false;
    }
    return true;
  };
  const staffCreateDispatch = (record: Record<string, unknown>) => {
    ensureCanCreateDispatch();
    return _staffCreateDispatch(record);
  };
  const staffUpdateDispatch = (dispatchId: string, record: Record<string, unknown>) => {
    ensureCanCreateDispatch();
    return _staffUpdateDispatch(dispatchId, record);
  };
  const staffCancelDispatch = (dispatchId: string) => {
    ensureCanCreateDispatch();
    return _staffCancelDispatch(dispatchId);
  };
  const dismissDispatch = (dispatchId: string) => {
    ensureCanCreateDispatch();
    return _dismissDispatch(dispatchId);
  };

  // Data state
  const [wells, setWells] = useState<WellResponse[]>([]);
  const [routes, setRoutes] = useState<string[]>([]);
  // WB‑M vc58 parity: ONE shared client clock (useSharedNow). Every surface
  // (badge / Current Level (Est.) column / view filters / TTP / counts / sort / the
  // Assign & Reassign modals) recomputes the estimate at this single `asOfMs` so they
  // always agree. Foreground/resume recomputes immediately. Client-only recompute — it
  // never writes changing levels back to Firebase.
  const asOfMs = useSharedNow();
  // Checkpoint 3: detachable panes. Dock preference is a per-viewer convenience
  // persisted to localStorage (never customer data). Start docked on the server
  // render, then restore the saved preference on the client (avoids SSR mismatch).
  const [queueDetached, setQueueDetached] = useState(false);
  const [jobsDetached, setJobsDetached] = useState(false);
  useEffect(() => {
    try {
      setQueueDetached(localStorage.getItem('wb.dispatch.queueDetached') === '1');
      setJobsDetached(localStorage.getItem('wb.dispatch.jobsDetached') === '1');
    } catch { /* storage unavailable — stay docked */ }
  }, []);
  const dockQueue = useCallback((v: boolean) => {
    setQueueDetached(v);
    try { localStorage.setItem('wb.dispatch.queueDetached', v ? '1' : '0'); } catch { /* ignore */ }
  }, []);
  const dockJobs = useCallback((v: boolean) => {
    setJobsDetached(v);
    try { localStorage.setItem('wb.dispatch.jobsDetached', v ? '1' : '0'); } catch { /* ignore */ }
  }, []);
  const [drivers, setDrivers] = useState<ApprovedDriver[]>([]);
  const [dispatches, setDispatches] = useState<DispatchJob[]>([]);
  // True once the Active Jobs dispatch subscription has delivered its first real
  // dataset. Distinguishes "no jobs yet loaded" (initial []) from "loaded, zero
  // jobs" so expanded-group restore never prunes against a still-loading empty set.
  const [dispatchesLoaded, setDispatchesLoaded] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);
  const [driversLoading, setDriversLoading] = useState(true);
  // Governed shift-dot state (green/red/gray) via the staff batched resolve callable.
  const [shiftResults, setShiftResults] = useState<Map<string, ShiftResolveResult>>(new Map());
  const [shiftResolvedCompany, setShiftResolvedCompany] = useState<string | null>(null);
  const [shiftLoading, setShiftLoading] = useState(true);
  const [shiftError, setShiftError] = useState(false);
  const [readErrors, setReadErrors] = useState<{ drivers?: string; wells?: string; dispatches?: string }>({});
  // True when the authoritative live-status read failed for the whole queue.
  // A failed read is a QUEUE-LEVEL UNAVAILABLE state — never 80 individual
  // Needs-Data classifications.
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  // Cold-start guard: do not show counts (which would falsely read 0 / all
  // Needs-Data) until authentication resolved, the first well load completed,
  // and the authoritative status source is available.
  const queueReady = !loading && !dataLoading && !statusUnavailable && wells.length > 0;

  // UI state — initialized from the URL so a browser reload restores the exact
  // authorized location (Well Queue tab/filter/search), never the default view.
  const [search, setSearch] = useState(() => readInitialParam('q') ?? '');
  const [routeFilter, setRouteFilter] = useState<string>(() => readInitialParam('route') ?? 'all');
  // Primary actionable-queue view (default: wells that need pulling now).
  const [queueView, setQueueView] = useState<QueueView>(() => {
    const v = readInitialParam('view');
    return (v === 'needs-pull' || v === 'next-24h' || v === 'all' || v === 'needs-data') ? v : 'needs-pull';
  });
  // Z Fold recovery — collapsed-queue + stacked-layout UI state.
  const [wellQueueExpanded, setWellQueueExpanded] = useState(false);
  const [stackedLayout, setStackedLayout] = useState(isStackedDispatchLayout);
  const [message, setMessage] = useState('');

  // Assign modal state (single-well PW)
  // showAssignModal removed — PW card is always visible, assignTarget fills it
  const [assignTarget, setAssignTarget] = useState<WellResponse | null>(null);
  const [assignWellSearch, setAssignWellSearch] = useState('');
  const [assignDriverHash, setAssignDriverHash] = useState('');
  const [assignNotes, setAssignNotes] = useState('');
  const [assignDisposal, setAssignDisposal] = useState('');
  const [assignDisposalWell, setAssignDisposalWell] = useState<NdicWell | null>(null);
  const [assignLoadCount, setAssignLoadCount] = useState(1);
  const [disposalSearch, setDisposalSearch] = useState('');
  const [disposalResults, setDisposalResults] = useState<NdicWell[]>([]);
  const [allDisposals, setAllDisposals] = useState<NdicWell[]>([]);
  const [allOperatorWells, setAllOperatorWells] = useState<NdicWell[]>([]);
  const [assigning, setAssigning] = useState(false);

  // Multi-select dispatch state
  const [selectedWells, setSelectedWells] = useState<Map<string, number>>(new Map()); // wellName → load count
  const [bulkDriverHash, setBulkDriverHash] = useState('');
  const [bulkNotes, setBulkNotes] = useState('');
  const [bulkDisposal, setBulkDisposal] = useState('');
  const [bulkDisposalWell, setBulkDisposalWell] = useState<NdicWell | null>(null);
  const [bulkDisposalSearch, setBulkDisposalSearch] = useState('');
  const [bulkDisposalResults, setBulkDisposalResults] = useState<NdicWell[]>([]);
  const [bulkDispatching, setBulkDispatching] = useState(false);

  // Service work form state
  const [swWellName, setSwWellName] = useState('');
  const [swDropoff, setSwDropoff] = useState('');
  const [swServiceType, setSwServiceType] = useState('');
  const [swOnsiteBy, setSwOnsiteBy] = useState('');
  const [swNotes, setSwNotes] = useState('');
  const [swDriverHashes, setSwDriverHashes] = useState<Set<string>>(new Set());
  const [swSubmitting, setSwSubmitting] = useState(false);
  const [swSplitTicket, setSwSplitTicket] = useState(false);
  const [swHeavyWater, setSwHeavyWater] = useState(false);
  // Pre-dispatch extra split legs (C/D/E…). Companion to swSplitTicket:
  // when the dispatcher needs more than the implicit 2-leg chain, they
  // click "+ Add Leg" and fill a compact inline editor. Each saved entry
  // becomes one additional dispatch doc on submit, sharing the same
  // splitGroupId with monotonic splitSequence (3, 4, 5…) and splitTotal
  // updated everywhere atomically. NOT Multi-Haul. Cleared when
  // swSplitTicket toggles off or after a successful submit.
  type ExtraSplitLeg = { id: string; disposal: string; bbls: string; notes: string };
  const [swExtraSplitLegs, setSwExtraSplitLegs] = useState<ExtraSplitLeg[]>([]);
  const [swExtraLegDraft, setSwExtraLegDraft] = useState<{ disposal: string; bbls: string; notes: string } | null>(null);
  const [swDriverETAs, setSwDriverETAs] = useState<Map<string, DriverEtaResult>>(new Map());
  const [swEtaLoading, setSwEtaLoading] = useState(false);

  // Calculate driver ETAs when SW onsiteBy + well are set
  useEffect(() => {
    if (!swOnsiteBy || !swWellName.trim()) {
      setSwDriverETAs(new Map());
      return;
    }

    // Parse onsiteBy (datetime-local format: "2026-03-24T22:00") to minutes from now
    const target = new Date(swOnsiteBy);
    if (isNaN(target.getTime())) return;
    const onsiteByMinutes = (target.getTime() - Date.now()) / 60000;
    if (onsiteByMinutes <= 0) return; // Past deadline

    // Find target well GPS coords
    const matchedWell = wells.find(w =>
      (w.ndicName || w.wellName).toLowerCase() === swWellName.trim().toLowerCase()
    );
    const targetNdic = allOperatorWells.find(w =>
      w.well_name.toLowerCase() === swWellName.trim().toLowerCase()
    );
    const targetLat = (matchedWell as any)?.expectedLat ?? targetNdic?.latitude ?? null;
    const targetLng = (matchedWell as any)?.expectedLng ?? targetNdic?.longitude ?? null;
    if (!targetLat || !targetLng) {
      // No GPS for target — can't calculate drive times
      return;
    }

    // Calculate ETAs for all drivers
    setSwEtaLoading(true);
    const driverHashes = drivers.map(d => d.key);
    calculateDriverETAs(driverHashes, dispatches, { lat: targetLat, lng: targetLng, name: swWellName.trim() })
      .then(results => {
        const withDeadline = applyDeadline(results, onsiteByMinutes);
        const map = new Map<string, DriverEtaResult>();
        withDeadline.forEach(r => map.set(r.driverHash, r));
        setSwDriverETAs(map);
      })
      .catch(console.warn)
      .finally(() => setSwEtaLoading(false));
  }, [swOnsiteBy, swWellName, dispatches, drivers, wells, allOperatorWells]);

  // Add Pull modal state (shared component handles its own form state)
  const [showAddPullModal, setShowAddPullModal] = useState(false);

  // Builder tab state (PW / SW / Projects) — persists across page visits
  const [builderTab, setBuilderTab] = useState<'pw' | 'sw' | 'projects'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('dispatch_builder_tab');
      if (saved === 'pw' || saved === 'sw' || saved === 'projects') return saved;
    }
    return 'pw';
  });
  const handleBuilderTabChange = useCallback((tab: 'pw' | 'sw' | 'projects') => {
    setBuilderTab(tab);
    localStorage.setItem('dispatch_builder_tab', tab);
  }, []);

  // Edit dispatch modal state (shared for PW + SW)
  const [editSwJob, setEditSwJob] = useState<DispatchJob | null>(null);
  const [editSwNotes, setEditSwNotes] = useState('');
  const [editSwWellName, setEditSwWellName] = useState('');
  const [editSwAddDriverHashes, setEditSwAddDriverHashes] = useState<Set<string>>(new Set());
  const [editSwSaving, setEditSwSaving] = useState(false);
  // PW-specific fields on edit modal
  const [editPwDisposal, setEditPwDisposal] = useState('');
  const [editPwDisposalResults, setEditPwDisposalResults] = useState<NdicWell[]>([]);
  const [editPwShowDisposalDropdown, setEditPwShowDisposalDropdown] = useState(false);
  const [editPwSplitLoads, setEditPwSplitLoads] = useState(1);
  const [editPwSplitDriver, setEditPwSplitDriver] = useState('');
  // SW-specific edit fields
  const [editSwDisposal, setEditSwDisposal] = useState('');
  const [editSwDisposalResults, setEditSwDisposalResults] = useState<NdicWell[]>([]);
  const [editSwShowDisposalDropdown, setEditSwShowDisposalDropdown] = useState(false);
  const [editSwOnsiteBy, setEditSwOnsiteBy] = useState('');

  // Reassign declined job state
  const [reassignJob, setReassignJob] = useState<DispatchJob | null>(null);
  const [reassignDriverHash, setReassignDriverHash] = useState('');
  const [reassigning, setReassigning] = useState(false);
  const [reassignLoads, setReassignLoads] = useState(0); // 0 = all loads
  // 'declined' = classic reassign of a declined/cancelled job (new dispatch);
  // 'in_place' = reassign an assigned-but-not-started dispatch by UPDATING the
  // SAME dispatch identity (never mint a duplicate dispatch/invoice/job).
  const [reassignMode, setReassignMode] = useState<'declined' | 'in_place'>('declined');

  // Right panel tab
  const searchParams = useSearchParams();
  const [rightPanelTab, setRightPanelTab] = useState<'jobs' | 'completed' | 'projects'>('jobs');
  const [highlightJobId, setHighlightJobId] = useState<string | null>(null);

  // Handle URL params from notification deep links (e.g., ?tab=completed&highlight=abc123)
  useEffect(() => {
    const tab = searchParams.get('tab');
    const highlight = searchParams.get('highlight');
    if (tab === 'completed') {
      setRightPanelTab('completed');
      if (highlight) setHighlightJobId(highlight);
    } else if (tab === 'projects') {
      setRightPanelTab('projects');
    }
  }, [searchParams]);

  // Projects state
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projectInvoices, setProjectInvoices] = useState<ProjectInvoice[]>([]);
  const [projectDispatches, setProjectDispatches] = useState<DispatchJob[]>([]);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectWells, setNewProjectWells] = useState<string[]>([]);
  const [newProjectOperator, setNewProjectOperator] = useState('');
  const [allOperators, setAllOperators] = useState<NdicOperator[]>([]);
  const [operatorSuggestions, setOperatorSuggestions] = useState<NdicOperator[]>([]);
  const [newProjectNotes, setNewProjectNotes] = useState('');
  const [newProjectEndDate, setNewProjectEndDate] = useState('');
  const [newProjectDriverHashes, setNewProjectDriverHashes] = useState<Set<string>>(new Set());
  const [newProjectDriverShifts, setNewProjectDriverShifts] = useState<Map<string, 'day' | 'night'>>(new Map());
  const [newProjectDriverDisposals, setNewProjectDriverDisposals] = useState<{ [hash: string]: { name: string; lat?: number; lng?: number } }>({});
  const [newProjectJobType, setNewProjectJobType] = useState<'service' | 'pw'>('service');
  const [newProjectServiceType, setNewProjectServiceType] = useState('');
  const [npbTab, setNpbTab] = useState<'details' | 'drivers' | 'notes'>('details');
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectWellSearch, setProjectWellSearch] = useState('');

  // Dynamic service types from job packages (falls back to hardcoded)
  const FALLBACK_SERVICE_TYPES = ['Hot Shot', 'Equipment Delivery', 'Tank Cleanout', 'Flowback', 'Frac Water', 'Rig Move', 'Other'];
  const [dynamicServiceTypes, setDynamicServiceTypes] = useState<string[]>(FALLBACK_SERVICE_TYPES);
  // Map job type label → packageId (for stamping dispatch docs)
  const [jobTypeToPackageId, setJobTypeToPackageId] = useState<Record<string, string>>({});

  // Auth redirect — gated on auth resolution (no premature default redirect).
  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  // Governed shift dots: batch-resolve loaded drivers' canonical shift state via
  // staffResolveCompanyDriverShifts (server reads the client-denied authority). Refresh
  // on load, when the driver set changes, and every 60s so shift start/end reflects
  // without a logout. Error/absence → gray (never a false red).
  const driverCanonicalIds = useMemo(
    () => drivers.map(d => d.driverId || (typeof d.key === 'string' && d.key.includes('-') ? d.key : '')).filter(Boolean),
    [drivers],
  );
  useEffect(() => {
    if (!user || driversLoading) return;
    if (driverCanonicalIds.length === 0) { setShiftLoading(false); return; }
    let cancelled = false;
    const run = async () => {
      const r = await resolveCompanyDriverShifts(driverCanonicalIds);
      if (cancelled) return;
      setShiftResults(r.resultsByDriverId);
      setShiftResolvedCompany(r.companyId);
      setShiftError(r.error);
      setShiftLoading(false);
    };
    run();
    const timer = setInterval(run, 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [user, driversLoading, driverCanonicalIds]);

  const driverShiftDot = useCallback((d: { driverId?: string; key?: string; companyId?: string }) => shiftDotForDriver({
    canonicalDriverId: d.driverId || (typeof d.key === 'string' && d.key.includes('-') ? d.key : ''),
    companyId: d.companyId,
    resultsByDriverId: shiftResults,
    resolvedCompanyId: shiftResolvedCompany,
    loading: shiftLoading,
    error: shiftError,
  }), [shiftResults, shiftResolvedCompany, shiftLoading, shiftError]);

  // Persist navigable Well Queue state (view / route / search) into the URL WITHOUT
  // navigating, so a reload restores it. Only applied once auth is resolved and the
  // user is present, so it never rewrites the URL during the pre-auth/login redirect.
  useEffect(() => {
    if (loading || !user || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const setOrDel = (k: string, val: string, dflt: string) => {
      if (val && val !== dflt) params.set(k, val); else params.delete(k);
    };
    setOrDel('view', queueView, 'needs-pull');
    setOrDel('route', routeFilter, 'all');
    setOrDel('q', search.trim(), '');
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }, [queueView, routeFilter, search, loading, user]);

  // Z Fold recovery — track stacked (Fold/narrow/short) vs desktop-split layout.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1280px) and (min-height: 900px)');
    const apply = () => setStackedLayout(!mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Subscribe to well data — tenant containment (7/9): the RTDB well queue is
  // the global (Liquid Gold) pool with no tenancy dimension. Scoped
  // non-liquid-gold companies get an empty queue (see lib/tenantScope.ts).
  useEffect(() => {
    // Wait for Firebase Auth persistence + token/claims to restore before ANY
    // read — a cold hard-reload must not read against an unready token.
    if (loading) return;
    if (!user) { setDataLoading(false); return; }
    // Tenant containment (7/9): the well pool is the global (Liquid Gold) pool.
    // A non-liquid-gold scoped company has no entitlement to it AND there is no
    // governed own-company well-status read (backend gap) → empty by design, not
    // an error. Owner / Liquid Gold / platform admins get the governed pool.
    if (!canViewGlobalWellPool(user)) {
      setWells([]);
      setRoutes([]);
      setStatusUnavailable(false);
      setDataLoading(false);
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    // Source selection: dashboard email/password users are NEVER authorized for
    // the direct-client RTDB packets/outgoing path (it requires driver/staff/
    // wellbuiltAdmin CLAIMS they do not hold), so we do NOT attempt it and
    // produce zero expected permission-denied requests. The GOVERNED
    // adminGetWellPool callable is the authorized live-status source.
    const load = async () => {
      try {
        const pool = await adminGetWellPool();
        if (cancelled) return;
        if (pool.canViewWellPool === false) {
          // Server confirms no entitlement to the global pool for this caller.
          setWells([]); setRoutes([]); setStatusUnavailable(false);
          setReadErrors(prev => ({ ...prev, wells: undefined })); setDataLoading(false);
          return;
        }
        const wellsData = mergeWellPool((pool.wellConfig || {}) as Record<string, unknown>, (pool.wellStatus || {}) as Record<string, unknown>);
        const routeList = [...new Set(wellsData.map(w => w.route).filter((r): r is string => !!r))];
        setWells(wellsData);
        setRoutes(routeList.filter(r => r !== 'Unrouted'));
        setStatusUnavailable(false);
        setReadErrors(prev => ({ ...prev, wells: undefined }));
        setDataLoading(false);
      } catch (err) {
        if (cancelled) return;
        attempts += 1;
        // Bounded retry ONLY because the governed callable CAN become authorized
        // once a cold-start token finishes restoring — not a permanent denial.
        if (attempts < 2) { retryTimer = setTimeout(load, 1500); return; }
        // Genuine governed-source failure → honest QUEUE-LEVEL UNAVAILABLE.
        setStatusUnavailable(true);
        setWells([]); setRoutes([]);
        setReadErrors(prev => ({ ...prev, wells: classifiedReadFailure('well live status', err) }));
        setDataLoading(false);
      }
    };

    load();
    // Periodic liveness refresh (the governed read is one-shot; no RTDB realtime
    // is authorized for dashboard users).
    refreshTimer = setInterval(() => { if (!cancelled) load(); }, 60000);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (refreshTimer) clearInterval(refreshTimer);
    };
  }, [user, loading]);

  // Load drivers + disposals
  useEffect(() => {
    loadDriversData();
    loadDisposals().then(setAllDisposals).catch(() => {});
    loadOperators().then(setAllOperators).catch(console.error);
  }, []);

  // Load dynamic service types from job packages
  // WB admin (no companyId): loads ALL packages so dispatch has full service type list
  // Hauler admin: loads only their company's active packages
  useEffect(() => {
    if (!user) return;
    const loadPackageJobTypes = async () => {
      try {
        // Use user's company, or for WB admin derive from first driver's company
        let companyId: string | undefined = user.companyId;
        if (!companyId && drivers.length > 0) {
          companyId = drivers.find(d => d.companyId)?.companyId;
        }
        let activeFilter: string[] | null = null;
        let companyConfig: any = null;

        if (companyId) {
          companyConfig = await loadCompanyById(companyId);
          if (!companyConfig?.activePackages?.length) return; // no packages — keep fallback
          activeFilter = companyConfig.activePackages;

          // Load all operator wells for SW well search (not just route wells)
          if (companyConfig.assignedOperators?.length && allOperatorWells.length === 0) {
            Promise.all(
              companyConfig.assignedOperators.map((op: string) => loadWellsForOperator(op))
            ).then(results => {
              setAllOperatorWells(results.flat());
            }).catch(console.warn);
          }
        }

        const firestore = getFirestoreDb();
        const snap = await getDocs(collection(firestore, 'job_packages'));
        const allJobTypes: string[] = [];
        const pkgMap: Record<string, string> = {};
        snap.forEach(d => {
          // WB admin sees all packages; hauler admin sees only active ones
          if (activeFilter && !activeFilter.includes(d.id)) return;
          const pkg = d.data();
          if (pkg.jobTypes && Array.isArray(pkg.jobTypes)) {
            for (const jt of pkg.jobTypes) {
              const label = typeof jt === 'string' ? jt : jt.label || jt.id || String(jt);
              if (!allJobTypes.includes(label)) {
                allJobTypes.push(label);
                pkgMap[label] = d.id;
              }
            }
          }
        });

        // Also load custom job types from company config
        const mergeCustomTypes = (rawTypes: any[]) => {
          for (const ct of rawTypes) {
            // Support both old string format and new { label, packages } format
            const label = typeof ct === 'string' ? ct : ct?.label;
            if (label && !allJobTypes.includes(label)) {
              allJobTypes.push(label);
              pkgMap[label] = 'custom';
            }
          }
        };

        if (companyId) {
          mergeCustomTypes(companyConfig?.customJobTypes || []);
        } else {
          // WB admin — load custom types from ALL companies
          const allCompaniesSnap = await getDocs(collection(firestore, 'companies'));
          allCompaniesSnap.forEach(compDoc => {
            const compData = compDoc.data();
            if (compData.customJobTypes && Array.isArray(compData.customJobTypes)) {
              mergeCustomTypes(compData.customJobTypes);
            }
          });
        }

        if (allJobTypes.length > 0) {
          // Always include "Other" as escape hatch
          if (!allJobTypes.includes('Other')) allJobTypes.push('Other');
          setDynamicServiceTypes(allJobTypes);
          setJobTypeToPackageId(pkgMap);
        }
      } catch (err) {
        console.error('Failed to load job package types:', err);
        // Keep fallback on error
      }
    };
    loadPackageJobTypes();
  }, [user, drivers.length]);

  // Subscribe to active + completed dispatches in real-time.
  // Tenant containment (7/9): scoped users see only their company's
  // dispatches — CLIENT-SIDE filter (no composite index needed for the
  // status-in + companyId + orderBy combination). liquid-gold also owns
  // legacy docs written before companyId stamping (docBelongsToTenant).
  useEffect(() => {
    if (!user) return;
    const firestore = getFirestoreDb();
    const q = query(
      collection(firestore, 'dispatches'),
      where('status', 'in', ['pending', 'pending_approval', 'accepted', 'in_progress', 'paused', 'declined', 'cancelled', 'completed', 'dismissed']),
      orderBy('assignedAt', 'desc')
    );
    const unsub = onSnapshot(q, (snap) => {
      const jobs: DispatchJob[] = [];
      snap.forEach((d) => {
        jobs.push({ id: d.id, ...d.data() } as DispatchJob);
      });
      setDispatches(jobs.filter(j => docBelongsToTenant(j.companyId, user.companyId)));
      setDispatchesLoaded(true);
      setReadErrors(prev => ({ ...prev, dispatches: undefined }));
    }, (err) => {
      console.error('Dispatch listener error:', err);
      setReadErrors(prev => ({ ...prev, dispatches: classifiedReadFailure('dispatch jobs', err) }));
      loadDispatchesData();
    });
    return () => unsub();
  }, [user]);

  // Subscribe to projects in real-time (scoped to company for hauler admins)
  useEffect(() => {
    if (!user) return;
    const firestore = getFirestoreDb();
    const constraints: any[] = [
      where('status', 'in', ['active', 'paused']),
      orderBy('createdAt', 'desc'),
    ];
    // Hauler admin: only their company's projects. WB admin: all.
    if (user.companyId) {
      constraints.unshift(where('companyId', '==', user.companyId));
    }
    const q = query(collection(firestore, 'projects'), ...constraints);
    const unsub = onSnapshot(q, (snap) => {
      const items: Project[] = [];
      snap.forEach((d) => {
        items.push({ id: d.id, ...d.data() } as Project);
      });
      setProjects(items);
      // Sync selectedProject with latest data from Firestore
      setSelectedProject(prev => {
        if (!prev?.id) return prev;
        const updated = items.find(p => p.id === prev.id);
        return updated || null;
      });
    }, (err) => {
      console.error('Projects listener error:', err);
    });
    return () => unsub();
  }, [user]);

  // Load project dispatches + invoices when a project is selected
  useEffect(() => {
    if (!selectedProject?.id) {
      setProjectDispatches([]);
      setProjectInvoices([]);
      return;
    }
    const firestore = getFirestoreDb();

    // Subscribe to dispatches for this project
    const dq = query(
      collection(firestore, 'dispatches'),
      where('projectId', '==', selectedProject.id)
    );
    const unsubDispatches = onSnapshot(dq, (snap) => {
      const jobs: DispatchJob[] = [];
      snap.forEach((d) => jobs.push({ id: d.id, ...d.data() } as DispatchJob));
      // Sort: active first, then by date
      jobs.sort((a, b) => {
        const aActive = ['in_progress', 'accepted', 'pending'].includes(a.status) ? 0 : 1;
        const bActive = ['in_progress', 'accepted', 'pending'].includes(b.status) ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        const aTime = a.assignedAt?.toMillis?.() || 0;
        const bTime = b.assignedAt?.toMillis?.() || 0;
        return bTime - aTime;
      });
      setProjectDispatches(jobs);
    });

    // Subscribe to invoices for this project
    const iq = query(
      collection(firestore, 'invoices'),
      where('projectId', '==', selectedProject.id),
      orderBy('createdAt', 'desc')
    );
    const unsubInvoices = onSnapshot(iq, (snap) => {
      const inv: ProjectInvoice[] = [];
      snap.forEach((d) => {
        const data = d.data();
        inv.push({
          id: d.id,
          invoiceNumber: data.invoiceNumber,
          driverName: data.driverName || data.driver,
          wellName: data.wellName,
          totalBarrels: data.totalBarrels,
          createdAt: data.createdAt,
          status: data.status,
          ticketCount: data.tickets?.length || data.ticketCount || 0,
        });
      });
      setProjectInvoices(inv);
    }, () => {
      // Index might not exist yet — that's fine
      setProjectInvoices([]);
    });

    return () => {
      unsubDispatches();
      unsubInvoices();
    };
  }, [selectedProject?.id]);

  async function loadDriversData() {
    setDriversLoading(true);
    try {
      const catalog = await adminGetDashboardCatalog();
      const approved: ApprovedDriver[] = [];
      const data = (catalog.approved || {}) as Record<string, any>;

      Object.entries(data).forEach(([hash, val]: [string, any]) => {
          // Handle both flat and legacy nested formats
          if (val.displayName) {
            // Flat format
            if (val.active !== false) {
              approved.push({
                key: hash,
                driverId: val.driverId || (typeof hash === 'string' && hash.includes('-') ? hash : undefined),
                legacyAliases: [val.migratedToDriverId].filter(Boolean),
                displayName: val.displayName,
                legalName: val.legalName || val.profile?.legalName || '',
                loginAlias: val.name || val.profile?.name || undefined,
                active: val.active,
                companyId: val.companyId,
                companyName: val.companyName,
                assignedRoutes: val.assignedRoutes || [],
                phone: val.profile?.phone || '',
              });
            }
          } else {
            // Legacy nested format — grab first device
            const deviceKeys = Object.keys(val);
            if (deviceKeys.length > 0) {
              const first = val[deviceKeys[0]];
              if (first.active !== false && first.displayName) {
                approved.push({
                  key: hash,
                  driverId: first.driverId || (typeof hash === 'string' && hash.includes('-') ? hash : undefined),
                  legacyAliases: [first.migratedToDriverId].filter(Boolean),
                  displayName: first.displayName,
                  legalName: first.legalName || first.profile?.legalName || '',
                  loginAlias: first.name || first.profile?.name || undefined,
                  active: first.active,
                  companyId: first.companyId,
                  companyName: first.companyName,
                  assignedRoutes: first.assignedRoutes || [],
                  phone: first.profile?.phone || '',
                });
              }
            }
          }
        });

      // Tenant containment (7/9): scoped users see only their own company's
      // drivers (liquid-gold also owns legacy unstamped records).
      const scoped = approved.filter(d => docBelongsToTenant(d.companyId, user?.companyId));
      scoped.sort((a, b) => a.displayName.localeCompare(b.displayName));
      setDrivers(scoped);
      setReadErrors(prev => ({ ...prev, drivers: undefined }));

      // Shift status dot: intentionally NOT fetched here anymore.
      //
      // ROOT CAUSE of the "every driver red" defect: the prior code read
      // driver_shifts/{d.key}_{today} (the drivers/approved ROSTER KEY + TODAY's
      // local date) and set onShift = (last event !== 'logout'). Wrong on two axes:
      //   1. it keys by the roster key, not the canonical driverId;
      //   2. it inspects only TODAY's day document, so an open shift whose ORIGIN
      //      day is earlier (e.g. Mike ZFold7 Burger's open period 2026-09-13,
      //      viewed on 2026-09-15) is never found — the dot fell to red for everyone.
      // The authoritative state lives in the server-owned, client-DENIED
      // `driver_shift_authority/{canonicalDriverId}` record (decideResolve), which a
      // browser cannot read. Correct truth therefore requires a governed staff-/
      // company-scoped resolve callable (see report: staffResolveCompanyDriverShifts).
      // Until that callable is deployed the selector shows a gray "Shift status
      // unavailable" dot (shiftDotCore) rather than a FALSE red. Do NOT reintroduce a
      // shadow driver_shifts read or derive the dot from HOS/presence/GPS/dispatch.
    } catch (err) {
      console.error('Failed to load drivers:', err);
      setDrivers([]);
      setReadErrors(prev => ({ ...prev, drivers: classifiedReadFailure('drivers', err) }));
    } finally {
      setDriversLoading(false);
    }
  }

  async function loadDispatchesData() {
    try {
      const firestore = getFirestoreDb();
      const q = query(
        collection(firestore, 'dispatches'),
        where('status', 'in', ['pending', 'pending_approval', 'accepted', 'in_progress', 'paused', 'declined', 'cancelled']),
        orderBy('assignedAt', 'desc')
      );
      const snap = await getDocs(q);
      const jobs: DispatchJob[] = [];
      snap.forEach((d) => {
        jobs.push({ id: d.id, ...d.data() } as DispatchJob);
      });
      // Tenant containment (7/9) — same filter as the live subscription.
      setDispatches(jobs.filter(j => docBelongsToTenant(j.companyId, user?.companyId)));
    } catch (err) {
      console.error('Failed to load dispatches:', err);
      setReadErrors(prev => ({ ...prev, dispatches: classifiedReadFailure('dispatch jobs', err) }));
    }
  }

  // ─── PW Queue (sorted by priority) ──────────────────────────────────────────

  // Latest ACTIVE pw dispatch per well. Only pending/accepted/in_progress/paused
  // count as an assignment; declined/cancelled/dismissed/completed do NOT, so the
  // well is free to re-enter Needs Pull the instant the classifier still needs it.
  // Uses canonical well matching (matchWellInPool) so phone-created dispatches with
  // NDIC names (e.g. Gabriel 3-36-25H) link properly to the queue's well records.
  const pwAssignmentByWell = useMemo(() => {
    const m = new Map<string, { job: DispatchJob; status: string; driver: string; assignedMs: number }>();
    for (const d of dispatches) {
      if ((d.jobType && d.jobType !== 'pw') || !(PW_ACTIVE_STATUSES as readonly string[]).includes(d.status)) continue;
      const assignedMs = (d.assignedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;

      // Canonical well matching (matches by wellName, ndicName, or normalized name)
      const matched = matchWellInPool(wells, d.wellName) || (d.ndicWellName ? matchWellInPool(wells, d.ndicWellName) : undefined);
      const canonicalName = matched?.wellName || d.wellName;

      // Real driver name via the canonical resolver (never the login/stamped name).
      // Central identity policy for human-facing OPERATIONAL screens: prefer displayName,
      // fall back to legalName — but never the login (operationalDriverName guards the
      // case where a profile's displayName IS the login, e.g. "Mikezfold").
      const rd = resolveDispatchDriver(d, drivers || []);
      const driverLabel = rd ? operationalDriverName(rd) : (d.driverFirstName || d.driverName || 'Assigned');
      const entry = { job: d, status: d.status, driver: driverLabel, assignedMs };

      const prev = m.get(canonicalName);
      if (!prev || assignedMs >= prev.assignedMs) {
        m.set(canonicalName, entry);
        m.set(d.wellName, entry);
        if (d.ndicWellName) m.set(d.ndicWellName, entry);
        if (matched?.ndicName) m.set(matched.ndicName, entry);
      }
    }
    return m;
  }, [dispatches, drivers, wells]);

  // Most recent COMPLETED pw dispatch per well — used only to suppress a stale
  // pre-pull re-entry into Needs Pull until the fresh post-pull level lands.
  const pwCompletedByWell = useMemo(() => {
    const m = new Map<string, { assignedMs: number; completedMs: number }>();
    for (const d of dispatches) {
      if ((d.jobType && d.jobType !== 'pw') || d.status !== 'completed') continue;
      const assignedMs = (d.assignedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
      const completedMs = (d.completedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? assignedMs;

      const matched = matchWellInPool(wells, d.wellName) || (d.ndicWellName ? matchWellInPool(wells, d.ndicWellName) : undefined);
      const canonicalName = matched?.wellName || d.wellName;
      const entry = { assignedMs, completedMs };

      const prev = m.get(canonicalName);
      if (!prev || completedMs >= prev.completedMs) {
        m.set(canonicalName, entry);
        m.set(d.wellName, entry);
        if (d.ndicWellName) m.set(d.ndicWellName, entry);
        if (matched?.ndicName) m.set(matched.ndicName, entry);
      }
    }
    return m;
  }, [dispatches, wells]);

  // Parse a well's level-basis time (the reading the estimate is anchored to).
  const wellBasisMs = (w: WellResponse): number | null => {
    const t = w.lastPullDateTimeUTC || w.timestampUTC;
    const ms = t ? Date.parse(t) : NaN;
    return isNaN(ms) ? null : ms;
  };
  // Hold a just-completed, NOT-actively-assigned well out of Needs Pull while its
  // level basis is still stale (pre-pull) — prevents the completed→reappear flash.
  const suppressCompletedReentry = (w: WellResponse): boolean => {
    if (pwAssignmentByWell.has(w.wellName) || (w.ndicName && pwAssignmentByWell.has(w.ndicName))) return false; // active assignment takes precedence
    const c = pwCompletedByWell.get(w.wellName) || (w.ndicName ? pwCompletedByWell.get(w.ndicName) : undefined);
    if (!c) return false;
    return isStaleCompletedReentry({ basisMs: wellBasisMs(w), completedAssignedMs: c.assignedMs });
  };

  // Route-scoped well collection: all tab counts and queue views derive from this
  // collection when a route filter is active; 'all' yields the full company catalog.
  const routeWells = useMemo(() => {
    if (!routeFilter || routeFilter === 'all') return wells;
    return wells.filter(w => w.route === routeFilter);
  }, [wells, routeFilter]);

  const pwQueue = useMemo(() => {
    const live = routeWells.filter(w => !(w.isDown || w.currentLevel === 'DOWN'));
    const applyText = (list: WellResponse[]) => {
      let f = list;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        f = f.filter(w => (w.wellName || '').toLowerCase().includes(q) || (w.route || '').toLowerCase().includes(q) || (w.ndicName || '').toLowerCase().includes(q));
      }
      return f;
    };
    const asgn = (w: WellResponse) => pwAssignmentByWell.get(w.wellName) || (w.ndicName ? pwAssignmentByWell.get(w.ndicName) : undefined);
    const started = (w: WellResponse) => pwLifecycle(asgn(w)?.status) === 'started';
    const notStarted = (w: WellResponse) => pwLifecycle(asgn(w)?.status) === 'not_started';

    const candidates = live.filter(w => {
      if (queueView === 'needs-pull') {
        // Needs Pull: physically pull-now, started wells excluded, stale completed re-entry held
        return !started(w) && classifyWell(w, asOfMs).state === 'pull-now' && !suppressCompletedReentry(w);
      }
      return matchesView(w, queueView, asOfMs);
    });

    const filtered = applyText(candidates);

    return filtered
      .map(w => {
        const a = asgn(w);
        // Physical urgency is independent of assignment state (never pass { assigned: true }).
        const priority = classifyWell(w, asOfMs);
        const assignment: RowAssignment = a ? {
          state: notStarted(w) ? 'assigned_not_started' : 'assigned_started',
          driver: a.driver,
          job: a.job,
          status: a.status,
        } : null;
        return { well: w, priority, assignment };
      })
      .sort(compareQueueRows);
  }, [routeWells, dispatches, search, queueView, asOfMs, pwAssignmentByWell, pwCompletedByWell]);

  // Needs Pull physical-demand split: total = both groups; also the actionable
  // (unassigned) vs already-assigned counts so the primary number never implies
  // every listed well still needs a driver. Scoped to the active route filter.
  const needsPullSplit = useMemo(() => {
    const asgn = (w: WellResponse) => pwAssignmentByWell.get(w.wellName) || (w.ndicName ? pwAssignmentByWell.get(w.ndicName) : undefined);
    let unassigned = 0, assigned = 0;
    for (const w of routeWells) {
      if (w.isDown || w.currentLevel === 'DOWN') continue;
      const a = asgn(w);
      if (a && pwLifecycle(a.status) === 'started') continue;          // started → Active Jobs
      if (classifyWell(w, asOfMs).state !== 'pull-now') continue;         // physical demand only
      if (suppressCompletedReentry(w)) continue;                        // stale post-completion → hold
      if (a && pwLifecycle(a.status) === 'not_started') assigned++; else unassigned++;
    }
    return { total: unassigned + assigned, unassigned, assigned };
  }, [routeWells, asOfMs, pwAssignmentByWell, pwCompletedByWell]);

  // Counts per primary view, scoped to the selected route ('all' = company-wide totals).
  // Needs Pull = physical demand (both groups, started excluded); other views scoped identically.
  const viewCounts = useMemo(() => {
    const live = routeWells.filter(w => !(w.isDown || w.currentLevel === 'DOWN'));
    return {
      'needs-pull': needsPullSplit.total,
      'next-24h': live.filter(w => wellBucket(w, asOfMs) === 'next-24h').length,
      'needs-data': live.filter(w => wellBucket(w, asOfMs) === 'needs-data').length,
      'all': live.length,
    } as Record<QueueView, number>;
  }, [routeWells, asOfMs, needsPullSplit]);

  // Z Fold recovery — when the queue is collapsed (stacked + not expanded), a
  // search still surfaces matching wells so the list is reachable on the Fold.
  const searchHits = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return routeWells
      .filter(w => {
        const isDown = w.isDown || w.currentLevel === 'DOWN';
        if (isDown) return false;
        if (w.currentLevel === '--' && !w.nextPullTimeUTC) return false;
        if (!(w.wellName.toLowerCase().includes(q) || (w.route || '').toLowerCase().includes(q))) return false;
        return true;
      })
      .map(w => {
        const a = pwAssignmentByWell.get(w.wellName);
        // Assigned-but-not-started → dimmed Reassign presentation (physical badge);
        // otherwise the existing classify(assigned) behavior.
        if (a && pwLifecycle(a.status) === 'not_started') {
          return { well: w, priority: classifyWell(w, asOfMs), assignment: { state: 'assigned_not_started' as const, driver: a.driver, job: a.job, status: a.status } };
        }
        return { well: w, priority: classifyWell(w, asOfMs, { assigned: !!a }), assignment: null as RowAssignment };
      })
      .sort((a, b) => {
        if (a.priority.sortOrder !== b.priority.sortOrder) return a.priority.sortOrder - b.priority.sortOrder;
        const aR = a.priority.predictedReadyAtMs ?? Number.POSITIVE_INFINITY;
        const bR = b.priority.predictedReadyAtMs ?? Number.POSITIVE_INFINITY;
        return aR - bR;
      });
  }, [routeWells, search, asOfMs, pwAssignmentByWell]);

  const showingSearchHits = wellQueueUsesSearchHits(stackedLayout, wellQueueExpanded, search);
  const queueRows = showingSearchHits ? searchHits : pwQueue;
  const searchActive = wellQueueSearchActive(search);


  // ─── Assign PW Job ─────────────────────────────────────────────────────────

  function openAssignModal(well: WellResponse) {
    setSelectedWells(new Map()); // Exit multi-well mode
    setAssignTarget(well);
    setAssignDriverHash('');
    setAssignNotes('');
    setAssignLoadCount(1);
    setAssignDisposal('');
    setAssignDisposalWell(null);
    setDisposalSearch('');
    setDisposalResults([]);
  }

  async function submitPWDispatch() {
    if (!assignTarget || !assignDriverHash) return;
    setAssigning(true);
    try {
      const driver = drivers.find(d => d.key === assignDriverHash);
      if (!driver) throw new Error('Driver not found');

      const priority = getPriority(assignTarget);
      const firestore = getFirestoreDb();

      // Extract first name from legalName for privacy-safe display
      const driverFirstName = driver.legalName ? driver.legalName.split(' ')[0] : driver.displayName;

      // Resolve full NDIC/MBOGC legal name — check operator wells if ndicName not on well_config
      const resolvedNdicName = assignTarget.ndicName
        || allOperatorWells.find(w => w.well_name.toLowerCase().includes(assignTarget.wellName.toLowerCase()))?.well_name
        || assignTarget.wellName;

      const job: Omit<DispatchJob, 'id'> = {
        // Canonical driver identity contract (driverId + canonical driverHash + real name).
        ...assignmentIdentityForDriver(driver),
        driverFirstName,
        wellName: assignTarget.wellName,
        ndicWellName: resolvedNdicName,
        route: assignTarget.route || '',
        jobType: 'pw',
        packageId: 'water-hauling',
        status: 'pending',
        notes: assignNotes || '',
        priority: priority.sortOrder,
        assignedAt: Timestamp.now(),
        assignedBy: user?.email || 'dashboard',
        estimatedPullTime: assignTarget.nextPullTimeUTC || '',
        currentLevel: assignTarget.currentLevel || '',
        flowRate: assignTarget.flowRate || '',
        ...(assignLoadCount > 1 ? { loadCount: assignLoadCount } : {}),
        ...(assignDisposal ? {
          disposal: assignDisposal,
          ...(assignDisposalWell?.latitude ? { disposalLat: assignDisposalWell.latitude } : {}),
          ...(assignDisposalWell?.longitude ? { disposalLng: assignDisposalWell.longitude } : {}),
          ...(assignDisposalWell?.api_no ? { disposalApiNo: assignDisposalWell.api_no } : {}),
          ...(assignDisposalWell?.legal_desc ? { disposalLegalDesc: assignDisposalWell.legal_desc } : {}),
          ...(assignDisposalWell?.county ? { disposalCounty: assignDisposalWell.county } : {}),
        } : {}),
      };

      await staffCreateDispatch(job);

      // Track PW usage for R&D pipeline (non-blocking)
      const compId = user?.companyId || driver.companyId || 'unknown';
      trackJobTypeUsage('Production Water', compId, 'water-hauling');

      setMessage(`Dispatched ${assignTarget.wellName} to ${driver.legalName || driver.displayName}`);
      setAssignTarget(null);
      setAssignDriverHash('');
      setAssignNotes('');
      setAssignLoadCount(1);
      setAssignDisposal('');
      setAssignDisposalWell(null);
      setDisposalSearch('');
      setDisposalResults([]);
      setTimeout(() => setMessage(''), 4000);
    } catch (err: any) {
      setAssignTarget(null);
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setAssigning(false);
    }
  }

  // ─── Submit Service Work Job ───────────────────────────────────────────────

  async function submitServiceWork() {
    if (!swWellName.trim() || !swServiceType.trim() || swDriverHashes.size === 0) return;
    setSwSubmitting(true);
    try {
      const firestore = getFirestoreDb();
      const selectedDrivers = drivers.filter(d => swDriverHashes.has(d.key));
      if (selectedDrivers.length === 0) throw new Error('No drivers found');

      // Generate a group ID so Dashboard can link related service work dispatches
      const serviceGroupId = selectedDrivers.length > 1 ? `sg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : undefined;
      // Crew list — first names from legalName so logins stay private
      const getFirstName = (d: ApprovedDriver) => {
        if (d.legalName) return d.legalName.split(' ')[0];
        return d.displayName; // fallback if no legalName
      };
      const assignedDrivers = selectedDrivers.length > 1 ? selectedDrivers.map(getFirstName) : undefined;

      // Look up NDIC name from wells list
      const matchedWell = wells.find(w => w.wellName === swWellName.trim() || w.ndicName === swWellName.trim());
      const swNdicName = matchedWell?.ndicName || swWellName.trim();

      // Split ticket: generate shared splitGroupId for linked jobs.
      // splitTotal = 1 (base) + 1 (leg B from swDropoff) + N (extras C/D/E…).
      // All siblings carry the same splitTotal so the WB T client can show
      // "Split N of M" badges + the addSplitLeg CF can extend the chain
      // later without recomputing.
      const splitGroupId = swSplitTicket ? `split_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : undefined;
      const splitTotal = swSplitTicket
        ? 2 + swExtraSplitLegs.length
        : undefined;

      const promises = selectedDrivers.map(driver => {
        const baseJob: Omit<DispatchJob, 'id'> = {
          // Canonical driver identity contract (driverId + canonical driverHash + real name).
          ...assignmentIdentityForDriver(driver),
          ...(driver.legalName ? { driverFirstName: getFirstName(driver) } : {}),
          wellName: matchedWell?.wellName || swWellName.trim(),
          ndicWellName: swNdicName,
          ...(swDropoff.trim() ? { disposal: swDropoff.trim() } : {}),
          ...(swOnsiteBy ? { onsiteBy: swOnsiteBy } : {}),
          jobType: 'service',
          serviceType: swServiceType.trim(),
          packageId: jobTypeToPackageId[swServiceType.trim()] || undefined,
          status: 'pending',
          notes: swNotes || '',
          priority: 5,
          assignedAt: Timestamp.now(),
          assignedBy: user?.email || 'dashboard',
          ...(serviceGroupId ? { serviceGroupId } : {}),
          ...(assignedDrivers ? { assignedDrivers } : {}),
          ...(swHeavyWater ? { isHeavyWater: true } : {}),
          ...(splitGroupId ? { splitGroupId, splitSequence: 1, ...(splitTotal != null ? { splitTotal } : {}) } : {}),
        };

        const docs = [staffCreateDispatch(baseJob)];

        // Split ticket: create second linked job (drop-off → service work at destination)
        if (swSplitTicket && swDropoff.trim()) {
          const job2: Omit<DispatchJob, 'id'> = {
            ...baseJob,
            wellName: swDropoff.trim(),
            ndicWellName: swDropoff.trim(),
            disposal: swDropoff.trim(),
            notes: `Split ticket B — ${swNotes || swServiceType.trim()}`,
            splitGroupId: splitGroupId!,
            splitSequence: 2,
            ...(splitTotal != null ? { splitTotal } : {}),
          };
          docs.push(staffCreateDispatch(job2));
        }

        // Extra split legs (C/D/E…) — same metadata namespace as leg B, no
        // Multi-Haul. Each entry becomes a sibling dispatch doc with
        // monotonic splitSequence and the shared splitTotal. Pre-filled bbls
        // (optional) carries into the driver's TicketModule prefill on
        // accept via origin.dispatchBbls (per FlowController 4/29 changelog).
        if (swSplitTicket && swExtraSplitLegs.length > 0) {
          swExtraSplitLegs.forEach((extra, idx) => {
            const letter = String.fromCharCode(67 + idx); // C, D, E…
            const bblsNum = extra.bbls ? parseFloat(extra.bbls) : NaN;
            const extraJob: Omit<DispatchJob, 'id'> = {
              ...baseJob,
              wellName: extra.disposal,
              ndicWellName: extra.disposal,
              disposal: extra.disposal,
              notes: extra.notes
                ? `Split ticket ${letter} — ${extra.notes}`
                : `Split ticket ${letter} — ${swServiceType.trim()}`,
              splitGroupId: splitGroupId!,
              splitSequence: 3 + idx,
              ...(splitTotal != null ? { splitTotal } : {}),
              ...(isFinite(bblsNum) && bblsNum > 0 ? { bbls: bblsNum } : {}),
            };
            docs.push(staffCreateDispatch(extraJob));
          });
        }

        return Promise.all(docs);
      });

      await Promise.all(promises);

      // Track job type usage for R&D pipeline (non-blocking)
      const compId = user?.companyId || selectedDrivers[0]?.companyId || 'unknown';
      trackJobTypeUsage(swServiceType.trim(), compId, jobTypeToPackageId[swServiceType.trim()] || 'custom');

      // Auto-create group chat thread for multi-driver SW jobs
      if (selectedDrivers.length > 1 && serviceGroupId) {
        try {
          const myPid = user?.uid ? `user:${user.uid}` : '';
          const participants = [myPid, ...selectedDrivers.map(d => `driver:${d.key}`)].filter(Boolean);
          const participantNames: Record<string, string> = {};
          if (myPid) participantNames[myPid] = user?.displayName || 'Dispatch';
          selectedDrivers.forEach(d => {
            participantNames[`driver:${d.key}`] = d.legalName || d.displayName;
          });
          const threadTitle = `${swServiceType.trim()} — ${matchedWell?.wellName || swWellName.trim()}`;
          const crewNames = selectedDrivers.map(d => (d.legalName || d.displayName).split(' ')[0]).join(', ');
          const sysText = `Service work dispatched: ${swServiceType.trim()} at ${matchedWell?.wellName || swWellName.trim()}\nCrew: ${crewNames}${swNotes ? `\nNotes: ${swNotes}` : ''}${swDropoff.trim() ? `\nDrop-off: ${swDropoff.trim()}` : ''}`;
          const threadRef = await addDoc(collection(firestore, 'chat_threads'), {
            type: 'service_group',
            serviceGroupId,
            companyId: user?.companyId || '',
            title: threadTitle,
            participants,
            participantNames,
            status: 'active',
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
            lastRead: {},
            lastMessage: { text: sysText, senderId: 'system', senderName: 'System', timestamp: Timestamp.now(), type: 'system' },
          });
          await addDoc(collection(firestore, 'chat_threads', threadRef.id, 'messages'), {
            text: sysText, senderId: 'system', senderName: 'System', timestamp: Timestamp.now(), type: 'system',
            systemType: 'job_assigned',
          });
        } catch (chatErr) {
          console.warn('[Dispatch] Auto-create SW chat failed (non-blocking):', chatErr);
        }
      }

      const names = selectedDrivers.map(d => d.legalName || d.displayName).join(', ');
      setMessage(`Service work dispatched to ${names}`);
      setSwWellName('');
      setSwDropoff('');
      setSwServiceType('');
      setSwOnsiteBy('');
      setSwNotes('');
      setSwDriverHashes(new Set());
      setSwSplitTicket(false);
      setSwHeavyWater(false);
      setSwExtraSplitLegs([]);
      setSwExtraLegDraft(null);
      setTimeout(() => setMessage(''), 4000);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setSwSubmitting(false);
    }
  }

  // ─── Cancel Dispatch ───────────────────────────────────────────────────────

  async function dismissDeclinedDispatch(jobId: string) {
    try {
      await dismissDispatch(jobId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Dismiss failed';
      setMessage(`Dismiss failed: ${msg.replace(/^FirebaseError:\s*/i, '')}`);
      setTimeout(() => setMessage(''), 5000);
      throw err;
    }
  }

  async function cancelDispatch(jobId: string) {
    try {
      await staffCancelDispatch(jobId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Cancel failed';
      setMessage(`Failed to cancel dispatch [${msg.replace(/^FirebaseError:\s*/i, '')}]`);
      setTimeout(() => setMessage(''), 5000);
    }
  }

  // ─── Project CRUD ───────────────────────────────────────────────────────

  async function createProject() {
    if (!guardCreateDispatch()) return;
    if (!newProjectName.trim() || newProjectWells.length === 0) return;
    setCreatingProject(true);
    try {
      const firestore = getFirestoreDb();
      const today = new Date().toISOString().slice(0, 10);
      // Build initial driver schedule for today
      const schedule: Record<string, string[]> = {};
      if (newProjectDriverHashes.size > 0) {
        schedule[today] = Array.from(newProjectDriverHashes);
      }
      // Build day/night driver arrays from shift assignments
      const dayHashes: string[] = [];
      const nightHashes: string[] = [];
      for (const hash of newProjectDriverHashes) {
        const shift = newProjectDriverShifts.get(hash) || 'day';
        if (shift === 'day') dayHashes.push(hash);
        else nightHashes.push(hash);
      }

      // Firestore rejects `undefined` field values — every optional field
      // either uses `|| null` (string-typed optionals) or the spread-omit
      // pattern (array-typed optionals + objects). Replaces the prior
      // `|| undefined` form which threw "Unsupported field value: undefined"
      // at addDoc when any optional input was empty.
      const projectData: Omit<Project, 'id'> = {
        name: newProjectName.trim(),
        wellNames: newProjectWells,
        operatorName: newProjectOperator.trim(),
        companyId: user?.companyId || '',
        createdBy: user?.email || '',
        createdAt: Timestamp.now(),
        startDate: today,
        projectedEndDate: newProjectEndDate || null,
        status: 'active',
        jobType: newProjectJobType,
        serviceType: newProjectServiceType || null,
        notes: newProjectNotes.trim() || null,
        driverSchedule: schedule,
        ...(dayHashes.length > 0 ? { dayDriverHashes: dayHashes } : {}),
        ...(nightHashes.length > 0 ? { nightDriverHashes: nightHashes } : {}),
        ...(Object.keys(newProjectDriverDisposals).length > 0 ? { driverDisposals: newProjectDriverDisposals } : {}),
      } as Omit<Project, 'id'>;
      const docRef = await addDoc(collection(firestore, 'projects'), projectData);

      // Create dispatches for today's assigned drivers
      if (newProjectDriverHashes.size > 0) {
        for (const wellName of newProjectWells) {
          const wellData = wells.find(w => w.wellName === wellName);
          for (const driverHash of newProjectDriverHashes) {
            const driver = drivers.find(d => d.key === driverHash);
            if (!driver) continue;
            const driverFirstName = driver.legalName ? driver.legalName.split(' ')[0] : driver.displayName;
            const driverDisposal = newProjectDriverDisposals[driverHash];
            // Same `|| undefined` → `|| null` normalization as projectData
            // above. Optional string fields: null. Optional structured
            // groups: spread-omit. Firestore never sees `undefined`.
            await staffCreateDispatch({
              // Canonical driver identity contract (driverId + canonical driverHash + real name).
              ...assignmentIdentityForDriver(driver),
              driverFirstName,
              wellName,
              ndicWellName: wellData?.ndicName || wellName,
              operator: newProjectOperator.trim(),
              route: wellData?.route || '',
              jobType: newProjectJobType,
              serviceType: newProjectServiceType || null,
              status: 'pending',
              priority: 500,
              assignedAt: Timestamp.now(),
              assignedBy: user?.email || '',
              projectId: docRef.id,
              notes: newProjectNotes.trim() || null,
              ...(driverDisposal ? { disposal: driverDisposal.name, disposalLat: driverDisposal.lat, disposalLng: driverDisposal.lng } : {}),
            });
          }
        }
      }

      // Auto-create project chat thread with all assigned drivers
      if (newProjectDriverHashes.size > 0) {
        try {
          const allDriverHashes = Array.from(newProjectDriverHashes);
          const myPid = user?.uid ? `user:${user.uid}` : '';
          const participants = [myPid, ...allDriverHashes.map(h => `driver:${h}`)].filter(Boolean);
          const participantNames: Record<string, string> = {};
          if (myPid) participantNames[myPid] = user?.displayName || 'Dispatch';
          allDriverHashes.forEach(h => {
            const d = drivers.find(dr => dr.key === h);
            if (d) participantNames[`driver:${h}`] = d.displayName;
          });
          const threadTitle = newProjectName.trim() || `Project - ${newProjectWells[0] || 'Unnamed'}`;
          const crewNames = allDriverHashes.map(h => { const d = drivers.find(dr => dr.key === h); return d ? (d.legalName || d.displayName).split(' ')[0] : h; }).join(', ');
          const sysText = `Project "${threadTitle}" created\nCrew: ${crewNames}\nWells: ${newProjectWells.join(', ')}${newProjectNotes ? `\nNotes: ${newProjectNotes}` : ''}`;
          const threadRef = await addDoc(collection(firestore, 'chat_threads'), {
            type: 'project',
            projectId: docRef.id,
            companyId: user?.companyId || '',
            title: threadTitle,
            participants,
            participantNames,
            status: 'active',
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
            lastRead: {},
            lastMessage: { text: sysText, senderId: 'system', senderName: 'System', timestamp: Timestamp.now(), type: 'system' },
          });
          await addDoc(collection(firestore, 'chat_threads', threadRef.id, 'messages'), {
            text: sysText, senderId: 'system', senderName: 'System', timestamp: Timestamp.now(), type: 'system',
          });
        } catch (chatErr) {
          console.warn('[Dispatch] Auto-create project chat failed (non-blocking):', chatErr);
        }
      }

      // Reset form
      setNewProjectName('');
      setNewProjectWells([]);
      setNewProjectOperator('');
      setNewProjectNotes('');
      setNewProjectEndDate('');
      setNewProjectDriverHashes(new Set());
      setNewProjectDriverShifts(new Map());
      setNewProjectDriverDisposals({});
      setNewProjectJobType('service');
      setNewProjectServiceType('');
      setProjectWellSearch('');
      setMessage('Project created');
      setTimeout(() => setMessage(''), 3000);
    } catch (err: any) {
      setMessage(`Error creating project: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setCreatingProject(false);
    }
  }

  async function updateProjectStatus(projectId: string, status: 'active' | 'paused' | 'completed') {
    if (!guardCreateDispatch()) return;
    try {
      const firestore = getFirestoreDb();
      const updates: Record<string, any> = { status };
      if (status === 'completed') updates.actualEndDate = new Date().toISOString().slice(0, 10);
      await updateDoc(doc(firestore, 'projects', projectId), updates);
      if (status === 'completed') {
        setSelectedProject(null);
      }
      setMessage(`Project ${status === 'completed' ? 'completed' : status === 'paused' ? 'paused' : 'resumed'}`);
      setTimeout(() => setMessage(''), 3000);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    }
  }

  async function addDriverToProjectToday(projectId: string, driverHash: string) {
    if (!guardCreateDispatch()) return;
    const today = new Date().toISOString().slice(0, 10);
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    try {
      const firestore = getFirestoreDb();
      const currentSchedule = project.driverSchedule || {};
      const todayDrivers = currentSchedule[today] || [];
      if (todayDrivers.includes(driverHash)) return;
      await updateDoc(doc(firestore, 'projects', projectId), {
        [`driverSchedule.${today}`]: [...todayDrivers, driverHash],
      });

      // Create dispatches for this driver for project wells
      const driver = drivers.find(d => d.key === driverHash);
      if (driver) {
        const driverFirstName = driver.legalName ? driver.legalName.split(' ')[0] : driver.displayName;
        for (const wellName of project.wellNames) {
          const wellData = wells.find(w => w.wellName === wellName);
          const driverDisposal = project.driverDisposals?.[driverHash];
          await staffCreateDispatch({
            // Canonical driver identity contract (driverId + canonical driverHash + real name).
            ...assignmentIdentityForDriver(driver),
            driverFirstName,
            wellName,
            ndicWellName: wellData?.ndicName || wellName,
            operator: project.operatorName || '',
            route: wellData?.route || '',
            jobType: project.jobType || 'service',
            serviceType: project.serviceType || undefined,
            status: 'pending',
            priority: 500,
            assignedAt: Timestamp.now(),
            assignedBy: user?.email || '',
            projectId: projectId,
            ...(driverDisposal ? { disposal: driverDisposal.name, disposalLat: driverDisposal.lat, disposalLng: driverDisposal.lng } : {}),
          });
        }
      }
      // Auto-add driver to existing project chat thread
      if (driver) {
        try {
          const firestore2 = getFirestoreDb();
          const threadSnap = await getDocs(query(
            collection(firestore2, 'chat_threads'),
            where('projectId', '==', projectId),
            where('type', '==', 'project'),
          ));
          if (!threadSnap.empty) {
            const threadDoc = threadSnap.docs[0];
            const threadData = threadDoc.data();
            const driverPid = `driver:${driverHash}`;
            if (!threadData.participants?.includes(driverPid)) {
              const driverFirstName = driver.legalName ? driver.legalName.split(' ')[0] : driver.displayName;
              await updateDoc(doc(firestore2, 'chat_threads', threadDoc.id), {
                participants: [...(threadData.participants || []), driverPid],
                [`participantNames.${driverPid}`]: driver.legalName || driver.displayName,
                updatedAt: Timestamp.now(),
              });
              const joinText = `${driverFirstName} joined the project`;
              await addDoc(collection(firestore2, 'chat_threads', threadDoc.id, 'messages'), {
                text: joinText, senderId: 'system', senderName: 'System', timestamp: Timestamp.now(), type: 'system',
                systemType: 'driver_joined',
              });
              await updateDoc(doc(firestore2, 'chat_threads', threadDoc.id), {
                lastMessage: { text: joinText, senderId: 'system', senderName: 'System', timestamp: Timestamp.now(), type: 'system' },
              });
            }
          }
        } catch (chatErr) {
          console.warn('[Dispatch] Auto-add driver to project chat failed (non-blocking):', chatErr);
        }
      }
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    }
  }

  // ─── Batch Dispatch for Project Shift ─────────────────────────────────────

  async function batchDispatchShift(projectId: string, shift: 'day' | 'night') {
    if (!guardCreateDispatch()) return;
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    const driverHashes = shift === 'day' ? (project.dayDriverHashes || []) : (project.nightDriverHashes || []);
    if (driverHashes.length === 0) return;

    try {
      const firestore = getFirestoreDb();
      const today = new Date().toISOString().slice(0, 10);

      // Build set of existing active dispatch combos to prevent duplicates
      const activeStatuses = ['pending', 'accepted', 'in_progress', 'paused'];
      const existingCombos = new Set(
        projectDispatches
          .filter(d => activeStatuses.includes(d.status))
          .map(d => `${d.driverHash}::${d.wellName}`)
      );

      let created = 0;
      for (const wellName of project.wellNames) {
        const wellData = wells.find(w => w.wellName === wellName);
        for (const driverHash of driverHashes) {
          const combo = `${driverHash}::${wellName}`;
          if (existingCombos.has(combo)) continue;
          const driver = drivers.find(d => d.key === driverHash);
          if (!driver) continue;
          const driverFirstName = driver.legalName ? driver.legalName.split(' ')[0] : driver.displayName;
          const driverDisposal = project.driverDisposals?.[driverHash];
          await staffCreateDispatch({
            // Canonical driver identity contract (driverId + canonical driverHash + real name).
            ...assignmentIdentityForDriver(driver),
            driverFirstName,
            wellName,
            ndicWellName: wellData?.ndicName || wellName,
            operator: project.operatorName || '',
            route: wellData?.route || '',
            jobType: project.jobType || 'service',
            serviceType: project.serviceType || undefined,
            status: 'pending',
            priority: 500,
            assignedAt: Timestamp.now(),
            assignedBy: user?.email || '',
            projectId,
            notes: project.notes || undefined,
            ...(driverDisposal ? { disposal: driverDisposal.name, disposalLat: driverDisposal.lat, disposalLng: driverDisposal.lng } : {}),
          });
          created++;
        }
      }

      // Merge drivers into today's schedule
      const currentSchedule = project.driverSchedule || {};
      const todayDrivers = new Set(currentSchedule[today] || []);
      driverHashes.forEach(h => todayDrivers.add(h));
      await updateDoc(doc(firestore, 'projects', projectId), {
        [`driverSchedule.${today}`]: Array.from(todayDrivers),
      });

      // Auto-add new shift drivers to existing project chat thread
      if (created > 0) {
        try {
          const threadSnap = await getDocs(query(
            collection(firestore, 'chat_threads'),
            where('projectId', '==', projectId),
            where('type', '==', 'project'),
          ));
          if (!threadSnap.empty) {
            const threadDoc = threadSnap.docs[0];
            const threadData = threadDoc.data();
            const existingPids = new Set(threadData.participants || []);
            const newPids: string[] = [];
            const newNames: Record<string, string> = {};
            const joinedNames: string[] = [];
            for (const driverHash of driverHashes) {
              const driverPid = `driver:${driverHash}`;
              if (!existingPids.has(driverPid)) {
                const driver = drivers.find(d => d.key === driverHash);
                if (driver) {
                  newPids.push(driverPid);
                  newNames[`participantNames.${driverPid}`] = driver.legalName || driver.displayName;
                  joinedNames.push((driver.legalName || driver.displayName).split(' ')[0]);
                }
              }
            }
            if (newPids.length > 0) {
              await updateDoc(doc(firestore, 'chat_threads', threadDoc.id), {
                participants: [...Array.from(existingPids), ...newPids],
                ...newNames,
                updatedAt: Timestamp.now(),
              });
              const joinText = `${joinedNames.join(', ')} joined the ${shift} shift`;
              await addDoc(collection(firestore, 'chat_threads', threadDoc.id, 'messages'), {
                text: joinText, senderId: 'system', senderName: 'System', timestamp: Timestamp.now(), type: 'system',
                systemType: 'driver_joined',
              });
              await updateDoc(doc(firestore, 'chat_threads', threadDoc.id), {
                lastMessage: { text: joinText, senderId: 'system', senderName: 'System', timestamp: Timestamp.now(), type: 'system' },
              });
            }
          }
        } catch (chatErr) {
          console.warn('[Dispatch] Auto-add shift drivers to project chat failed (non-blocking):', chatErr);
        }
      }

      if (created > 0) {
        setMessage(`Created ${created} ${shift} shift dispatch${created !== 1 ? 'es' : ''}`);
      } else {
        setMessage(`All ${shift} shift drivers already dispatched`);
      }
      setTimeout(() => setMessage(''), 3000);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    }
  }

  // ─── Reassign Declined Job ────────────────────────────────────────────────

  // Reassign an assigned-but-not-started well from the Needs Pull queue. Updates
  // the existing dispatch in place (no duplicate). Accepted → explicit confirm.
  function openReassignInPlace(job: DispatchJob) {
    if (job.status === 'accepted') {
      const ok = window.confirm(
        `${job.ndicWellName || job.wellName} is already accepted by ${job.driverFirstName || job.driverName || 'the driver'}.\n\n` +
        `Reassign it to a different driver?`,
      );
      if (!ok) return;
    }
    setReassignMode('in_place');
    setReassignJob(job);
    setReassignDriverHash('');
    setReassignLoads(0);
  }

  function openReassignModal(job: DispatchJob) {
    setReassignMode('declined');
    setReassignJob(job);
    setReassignDriverHash('');
    setReassignLoads(0); // default: all remaining loads
  }

  async function submitReassign() {
    if (!reassignJob || !reassignDriverHash) return;
    setReassigning(true);
    try {
      const driver = drivers.find(d => d.key === reassignDriverHash);
      if (!driver) throw new Error('Driver not found');

      const firestore = getFirestoreDb();
      const driverFirstName = driver.legalName ? driver.legalName.split(' ')[0] : driver.displayName;

      // ── In-place reassign (assigned-but-not-started): update the SAME dispatch
      // identity with the new driver — never mint a duplicate dispatch/invoice/job. ──
      if (reassignMode === 'in_place') {
        if (reassignJob.id) {
          await staffUpdateDispatch(reassignJob.id, {
            // Reassign moves the SAME dispatch to the destination driver's canonical identity.
            ...assignmentIdentityForDriver(driver),
            driverFirstName,
            assignedAt: Timestamp.now(),
            assignedBy: user?.email || 'dashboard',
            status: 'pending', // hand the same job to the new driver
          });
        }
        setMessage(`Reassigned ${reassignJob.ndicWellName || reassignJob.wellName} to ${driverFirstName}`);
        setReassignJob(null);
        setReassignDriverHash('');
        setReassignMode('declined');
        setReassigning(false);
        return;
      }

      // Create a new dispatch with the same job details but new driver
      const newJob: Record<string, any> = {
        // Canonical driver identity contract (driverId + canonical driverHash + real name).
        ...assignmentIdentityForDriver(driver),
        driverFirstName,
        wellName: reassignJob.wellName,
        ndicWellName: reassignJob.ndicWellName || reassignJob.wellName,
        route: reassignJob.route || '',
        jobType: reassignJob.jobType,
        packageId: reassignJob.packageId || 'water-hauling',
        status: 'pending',
        notes: reassignJob.notes || '',
        priority: reassignJob.priority,
        assignedAt: Timestamp.now(),
        assignedBy: user?.email || 'dashboard',
        estimatedPullTime: reassignJob.estimatedPullTime || '',
        currentLevel: reassignJob.currentLevel || '',
        flowRate: reassignJob.flowRate || '',
      };

      // Carry over disposal info
      if (reassignJob.disposal) newJob.disposal = reassignJob.disposal;
      if (reassignJob.disposalLat) newJob.disposalLat = reassignJob.disposalLat;
      if (reassignJob.disposalLng) newJob.disposalLng = reassignJob.disposalLng;
      if (reassignJob.disposalApiNo) newJob.disposalApiNo = reassignJob.disposalApiNo;
      if (reassignJob.disposalCounty) newJob.disposalCounty = reassignJob.disposalCounty;
      // Handle load counts for multi-load jobs
      const remainingLoads = (reassignJob.loadCount || 1) - (reassignJob.loadsCompleted || 0);
      const loadsToReassign = reassignLoads > 0 ? Math.min(reassignLoads, remainingLoads) : remainingLoads;
      const loadsKept = remainingLoads - loadsToReassign;

      if (loadsToReassign > 1) newJob.loadCount = loadsToReassign;
      // Carry over service work fields
      if (reassignJob.serviceType) newJob.serviceType = reassignJob.serviceType;
      if (reassignJob.serviceGroupId) newJob.serviceGroupId = reassignJob.serviceGroupId;
      if (reassignJob.assignedDrivers) newJob.assignedDrivers = reassignJob.assignedDrivers;
      if (reassignJob.disposalLegalDesc) newJob.disposalLegalDesc = reassignJob.disposalLegalDesc;

      await staffCreateDispatch(newJob);

      // Update the original job
      if (reassignJob.id) {
        if (loadsKept > 0) {
          // Partial reassign — reduce load count on original, keep it active
          await staffUpdateDispatch(reassignJob.id, {
            loadCount: (reassignJob.loadsCompleted || 0) + loadsKept,
          });
        } else {
          // Full reassign — cancel the original
          await staffCancelDispatch(reassignJob.id);
          await staffUpdateDispatch(reassignJob.id, {
            reassignedTo: driver.displayName,
          });
        }
      }

      const loadLabel = loadsToReassign > 1 ? ` (${loadsToReassign} loads)` : '';
      setMessage(`Reassigned ${reassignJob.ndicWellName || reassignJob.wellName}${loadLabel} to ${driverFirstName}`);
      setReassignJob(null);
      setReassignDriverHash('');
      setTimeout(() => setMessage(''), 4000);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setReassigning(false);
    }
  }

  async function assignTransfer(jobId: string, driverHash: string, driverName: string) {
    try {
      const firestore = getFirestoreDb();
      const driver = drivers.find(d => d.key === driverHash);
      const driverFirstName = driver?.legalName ? driver.legalName.split(' ')[0] : driverName;
      await staffUpdateDispatch(jobId, {
        // Canonical driver identity when the driver resolves; compat fallback otherwise.
        ...(driver ? assignmentIdentityForDriver(driver) : { driverHash, driverName }),
        driverFirstName,
        status: 'pending', // Approve: move from pending_approval → pending so driver sees it
      });
      setMessage(`Transfer approved → assigned to ${driverFirstName}`);
      setTimeout(() => setMessage(''), 3000);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    }
  }

  // ─── Multi-Select Helpers ──────────────────────────────────────────────────

  function toggleWellSelection(wellName: string) {
    // Entering multi-well mode clears single-well assignment
    setAssignTarget(null);
    setSelectedWells(prev => {
      const next = new Map(prev);
      if (next.has(wellName)) {
        next.delete(wellName);
      } else {
        next.set(wellName, 1);
      }
      return next;
    });
  }

  function setWellLoadCount(wellName: string, count: number) {
    setSelectedWells(prev => {
      const next = new Map(prev);
      next.set(wellName, Math.max(1, count));
      return next;
    });
  }

  function toggleSelectAll() {
    setAssignTarget(null); // Clear single-well mode
    // Only actionable (unassigned, dispatchable) rows are bulk-selectable — the
    // assigned-but-not-started group has no Assign/checkbox.
    const selectableWells = queueRows.filter(q => !q.assignment && q.priority.state !== 'down').map(q => q.well.wellName);

    if (selectableWells.every(w => selectedWells.has(w))) {
      setSelectedWells(new Map());
    } else {
      const next = new Map(selectedWells);
      selectableWells.forEach(w => {
        if (!next.has(w)) next.set(w, 1);
      });
      setSelectedWells(next);
    }
  }

  const totalSelectedLoads = useMemo(() => {
    let total = 0;
    selectedWells.forEach(count => total += count);
    return total;
  }, [selectedWells]);

  // ─── Bulk Dispatch ──────────────────────────────────────────────────────────

  async function submitBulkDispatch() {
    if (selectedWells.size === 0 || !assignDriverHash) return;
    setAssigning(true);
    try {
      const driver = drivers.find(d => d.key === assignDriverHash);
      if (!driver) throw new Error('Driver not found');
      const firestore = getFirestoreDb();

      // Create one dispatch doc per well with loadCount from Action # boxes
      const promises: Promise<any>[] = [];
      selectedWells.forEach((loadCount, wellName) => {
        const well = wells.find(w => w.wellName === wellName);
        const priority = well ? getPriority(well) : { sortOrder: 5 };

        // Resolve full NDIC/MBOGC legal name
        const resolvedNdic = well?.ndicName
          || allOperatorWells.find(w => w.well_name.toLowerCase().includes(wellName.toLowerCase()))?.well_name
          || wellName;

        const driverFirstName = driver.legalName ? driver.legalName.split(' ')[0] : driver.displayName;
        const job: Omit<DispatchJob, 'id'> = {
          // Canonical driver identity contract (driverId + canonical driverHash + real name).
          ...assignmentIdentityForDriver(driver),
          driverFirstName,
          wellName,
          ndicWellName: resolvedNdic,
          route: well?.route || '',
          jobType: 'pw',
          status: 'pending',
          notes: assignNotes || '',
          priority: priority.sortOrder,
          assignedAt: Timestamp.now(),
          assignedBy: user?.email || 'dashboard',
          estimatedPullTime: well?.nextPullTimeUTC || '',
          currentLevel: well?.currentLevel || '',
          flowRate: well?.flowRate || '',
          ...(loadCount > 1 ? { loadCount } : {}),
          ...(assignDisposal ? {
            disposal: assignDisposal,
            ...(assignDisposalWell?.latitude ? { disposalLat: assignDisposalWell.latitude } : {}),
            ...(assignDisposalWell?.longitude ? { disposalLng: assignDisposalWell.longitude } : {}),
            ...(assignDisposalWell?.api_no ? { disposalApiNo: assignDisposalWell.api_no } : {}),
            ...(assignDisposalWell?.legal_desc ? { disposalLegalDesc: assignDisposalWell.legal_desc } : {}),
            ...(assignDisposalWell?.county ? { disposalCounty: assignDisposalWell.county } : {}),
          } : {}),
        };
        promises.push(staffCreateDispatch(job));
      });

      await Promise.all(promises);
      setMessage(`Dispatched ${totalSelectedLoads} load${totalSelectedLoads !== 1 ? 's' : ''} across ${selectedWells.size} well${selectedWells.size !== 1 ? 's' : ''} to ${driver.legalName || driver.displayName}`);

      // Reset — clear selections + DPW form
      setSelectedWells(new Map());
      setAssignTarget(null);
      setAssignDriverHash('');
      setAssignNotes('');
      setAssignLoadCount(1);
      setAssignDisposal('');
      setAssignDisposalWell(null);
      setDisposalSearch('');
      setDisposalResults([]);
      setTimeout(() => setMessage(''), 5000);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setAssigning(false);
    }
  }

  // ─── Edit Service Work Handlers ─────────────────────────────────────────────

  function openEditSwModal(job: DispatchJob) {
    setEditSwJob(job);
    setEditSwNotes(job.notes || '');
    setEditSwWellName(job.ndicWellName || job.wellName || '');
    setEditSwAddDriverHashes(new Set());
    // PW-specific
    setEditPwDisposal(job.disposal || job.hauledTo || '');
    setEditPwDisposalResults([]);
    setEditPwShowDisposalDropdown(false);
    setEditPwSplitLoads(1);
    setEditPwSplitDriver('');
    // SW-specific
    setEditSwDisposal(job.disposal || job.disposalName || '');
    setEditSwDisposalResults([]);
    setEditSwShowDisposalDropdown(false);
    setEditSwOnsiteBy(job.onsiteBy || '');
  }

  // Get all dispatches in the same service group
  const editSwGroupJobs = useMemo(() => {
    if (!editSwJob) return [];
    if (editSwJob.serviceGroupId) {
      return dispatches.filter(d => d.serviceGroupId === editSwJob.serviceGroupId);
    }
    // Solo service work — just this one
    return [editSwJob];
  }, [editSwJob, dispatches]);

  // Drivers already assigned to this service group
  const editSwAssignedDriverHashes = useMemo(() => {
    return new Set(editSwGroupJobs.map(j => j.driverHash));
  }, [editSwGroupJobs]);

  async function saveEditServiceWork() {
    if (!editSwJob) return;
    setEditSwSaving(true);
    try {
      const firestore = getFirestoreDb();

      // 1a. Update well name if changed (PW jobs — GPS resolved when driver accepts)
      const origWell = editSwJob.ndicWellName || editSwJob.wellName || '';
      if (editSwWellName.trim() && editSwWellName.trim() !== origWell && editSwJob.id) {
        await staffUpdateDispatch(editSwJob.id, {
          wellName: editSwWellName.trim(),
          ndicWellName: editSwWellName.trim(),
        });
      }

      // 1b. Update disposal if changed (PW jobs)
      if (editSwJob.jobType !== 'service' && editSwJob.id) {
        const origDisposal = editSwJob.disposal || editSwJob.hauledTo || '';
        if (editPwDisposal.trim() !== origDisposal) {
          await staffUpdateDispatch(editSwJob.id, { disposal: editPwDisposal.trim() });
        }
      }

      // 1b2. Update disposal + onsiteBy if changed (SW jobs)
      if (editSwJob.jobType === 'service' && editSwJob.id) {
        const swUpdates: Record<string, any> = {};
        if (editSwDisposal.trim() !== (editSwJob.disposal || editSwJob.disposalName || '')) {
          swUpdates.disposal = editSwDisposal.trim();
        }
        if (editSwOnsiteBy !== (editSwJob.onsiteBy || '')) {
          swUpdates.onsiteBy = editSwOnsiteBy || null;
        }
        if (Object.keys(swUpdates).length > 0) {
          // Update all jobs in the service group
          const groupUpdatePromises = editSwGroupJobs.map(j => {
            if (!j.id) return Promise.resolve();
            return staffUpdateDispatch(j.id, swUpdates);
          });
          await Promise.all(groupUpdatePromises);
        }
      }

      // 1c. Update notes on all group jobs (SW) or single job (PW)
      if (editSwNotes !== (editSwJob.notes || '')) {
        const updatePromises = editSwGroupJobs.map(j => {
          if (!j.id) return Promise.resolve();
          return staffUpdateDispatch(j.id, { notes: editSwNotes });
        });
        await Promise.all(updatePromises);
      }

      // 2. Add new drivers
      if (editSwAddDriverHashes.size > 0) {
        const newDrivers = drivers.filter(d => editSwAddDriverHashes.has(d.key));
        const getFirstName = (d: ApprovedDriver) => d.legalName ? d.legalName.split(' ')[0] : d.displayName;

        // Determine serviceGroupId — create one if this was a solo job
        let serviceGroupId = editSwJob.serviceGroupId;
        if (!serviceGroupId) {
          serviceGroupId = `sg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          // Tag the original job with this group ID
          if (editSwJob.id) {
            await staffUpdateDispatch(editSwJob.id, { serviceGroupId });
          }
        }

        // Build full crew list
        const allDrivers = [...editSwGroupJobs.map(j => j.driverFirstName || j.driverName), ...newDrivers.map(getFirstName)];

        // Create new dispatch docs for added drivers
        const addPromises = newDrivers.map(driver => {
          const job: Omit<DispatchJob, 'id'> = {
            // Canonical driver identity contract (driverId + canonical driverHash + real name).
            ...assignmentIdentityForDriver(driver),
            ...(driver.legalName ? { driverFirstName: getFirstName(driver) } : {}),
            wellName: editSwJob.wellName,
            ndicWellName: editSwJob.ndicWellName || editSwJob.wellName,
            jobType: 'service',
            serviceType: editSwJob.serviceType || '',
            status: 'pending',
            notes: editSwNotes || '',
            priority: 5,
            assignedAt: Timestamp.now(),
            assignedBy: user?.email || 'dashboard',
            serviceGroupId,
            assignedDrivers: allDrivers,
          };
          return staffCreateDispatch(job);
        });
        await Promise.all(addPromises);

        // Update assignedDrivers on all existing group jobs
        const updateCrewPromises = editSwGroupJobs.map(j => {
          if (!j.id) return Promise.resolve();
          return staffUpdateDispatch(j.id, {
            assignedDrivers: allDrivers,
            ...(serviceGroupId && !j.serviceGroupId ? { serviceGroupId } : {}),
          });
        });
        await Promise.all(updateCrewPromises);
      }

      setMessage('Dispatch updated');
      setEditSwJob(null);
      setTimeout(() => setMessage(''), 3000);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setEditSwSaving(false);
    }
  }

  async function cancelSwDriverAssignment(jobId: string) {
    try {
      await staffCancelDispatch(jobId);
      setMessage('Driver assignment cancelled');
      setTimeout(() => setMessage(''), 3000);
    } catch (err: any) {
      setMessage(`Failed to cancel assignment: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    }
  }

  // ─── PW Split Loads Handler ────────────────────────────────────────────────

  async function splitPwLoads() {
    if (!editSwJob?.id || !editPwSplitDriver || editPwSplitLoads < 1) return;
    setEditSwSaving(true);
    try {
      const driver = drivers.find(d => d.key === editPwSplitDriver);
      if (!driver) throw new Error('Driver not found');

      const firestore = getFirestoreDb();
      const driverFirstName = driver.legalName ? driver.legalName.split(' ')[0] : driver.displayName;
      const remaining = (editSwJob.loadCount || 1) - (editSwJob.loadsCompleted || 0);
      const loadsToGive = Math.min(editPwSplitLoads, remaining - 1);
      const loadsKept = remaining - loadsToGive;

      const newJob: Record<string, any> = {
        // Canonical driver identity contract (driverId + canonical driverHash + real name).
        ...assignmentIdentityForDriver(driver),
        driverFirstName,
        wellName: editSwJob.wellName,
        ndicWellName: editSwJob.ndicWellName || editSwJob.wellName,
        route: editSwJob.route || '',
        jobType: 'pw',
        packageId: editSwJob.packageId || 'water-hauling',
        status: 'pending',
        notes: editSwJob.notes || '',
        priority: editSwJob.priority,
        assignedAt: Timestamp.now(),
        assignedBy: user?.email || 'dashboard',
        estimatedPullTime: editSwJob.estimatedPullTime || '',
        currentLevel: editSwJob.currentLevel || '',
        flowRate: editSwJob.flowRate || '',
      };
      if (editSwJob.disposal) newJob.disposal = editSwJob.disposal;
      if (editSwJob.disposalLat) newJob.disposalLat = editSwJob.disposalLat;
      if (editSwJob.disposalLng) newJob.disposalLng = editSwJob.disposalLng;
      if (editSwJob.disposalApiNo) newJob.disposalApiNo = editSwJob.disposalApiNo;
      if (editSwJob.disposalCounty) newJob.disposalCounty = editSwJob.disposalCounty;
      if (editSwJob.disposalLegalDesc) newJob.disposalLegalDesc = editSwJob.disposalLegalDesc;
      if (loadsToGive > 1) newJob.loadCount = loadsToGive;

      await staffCreateDispatch(newJob);

      await staffUpdateDispatch(editSwJob.id, {
        loadCount: (editSwJob.loadsCompleted || 0) + loadsKept,
      });

      setMessage(`Gave ${loadsToGive} load${loadsToGive > 1 ? 's' : ''} to ${driverFirstName}`);
      setEditSwJob(null);
      setTimeout(() => setMessage(''), 4000);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setEditSwSaving(false);
    }
  }

  // Toolbar form state (must be before render guards — React hooks can't be conditional)
  const [toolbarMode, setToolbarMode] = useState<'none' | 'sw' | 'pull'>('none');

  // Active jobs panel — count active drivers
  const activeDriverCount = useMemo(() => {
    const driverSet = new Set<string>();
    dispatches.forEach(d => driverSet.add(d.driverHash));
    return driverSet.size;
  }, [dispatches]);

  // ─── Render Guards ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    );
  }

  if (!user) return null;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="dashboard-viewport-shell bg-gray-900">
      <AppHeader />

      <main data-dashboard-scroll="dispatch" data-dispatch-scroll="primary" className="dispatch-scroll-main px-4 py-4">

        {/* ═══════════════════════════════════════════════════════════════════════
            DISPATCH TOOLBAR — Always visible at top. Quick actions + inline forms.
            ═══════════════════════════════════════════════════════════════════════ */}
        <div className="flex-shrink-0 mb-4">
          {/* Top bar: title + priority badges + action buttons */}
          <div className="flex items-center gap-4 mb-3">
            <h2 className="text-lg font-semibold text-white flex-shrink-0">Dispatch</h2>

            {/* Height-first actionable counts (time-first Overdue/Soon chips removed). */}
            <div className="flex items-center gap-1.5 flex-shrink-0 text-xs">
              <span className="px-2 py-0.5 rounded bg-red-600 text-white font-bold whitespace-nowrap">
                {queueReady ? needsPullSplit.total : '—'} Pull Now
                {queueReady && needsPullSplit.assigned > 0 && (
                  <span className="font-medium opacity-90"> · {needsPullSplit.unassigned} Unassigned · {needsPullSplit.assigned} Assigned</span>
                )}
              </span>
              <span className="px-2 py-0.5 rounded bg-yellow-600 text-black font-bold">{queueReady ? viewCounts['next-24h'] : '—'} Next 24h</span>
              <span className="px-2 py-0.5 rounded bg-amber-600 text-white font-bold">{queueReady ? viewCounts['needs-data'] : '—'} Needs Data</span>
            </div>

            <span className="flex-1" />
          </div>

          {/* Status message */}
          {message && (
            <div className={`p-2.5 rounded text-sm mb-3 ${message.startsWith('Error') || message.startsWith('Dismiss failed') ? 'bg-red-900/50 text-red-200' : 'bg-blue-900/60 text-blue-200'}`}>
              {message}
            </div>
          )}
          {(readErrors.dispatches || readErrors.drivers || readErrors.wells) && (
            <div className="p-2.5 rounded text-sm mb-3 bg-red-900/50 text-red-200 space-y-1">
              {readErrors.dispatches && <div>{readErrors.dispatches}</div>}
              {readErrors.drivers && <div>{readErrors.drivers}</div>}
              {readErrors.wells && <div>{readErrors.wells}</div>}
            </div>
          )}
        </div>

        {/* ═══════════════════════════════════════════════════════════════════════
            MAIN WORKSPACE (Checkpoint 2). Desktop grid, right-biased:
              ┌──────────┬───────────────┐
              │ Builder  │               │  Builder pinned upper-left (natural height)
              ├──────────┤   Well Queue  │  Active Jobs scroll below the builder
              │ Active   │  (full height,│  Well Queue owns the full-height right column
              │ Jobs ↕   │   scroll ↕)   │  Builder + Queue always simultaneously visible
              └──────────┴───────────────┘
            Each column owns its own internal scroll (min-height:0). Short / narrow
            / Fold: stacked document flow (jobs-first) with page-level scroll.
            ═══════════════════════════════════════════════════════════════════════ */}
        <div className={`dispatch-workspace${queueDetached ? ' is-queue-detached' : ''}${jobsDetached ? ' is-jobs-detached' : ''}`}>

            {/* ── Tabbed Dispatch Builder (PW / SW / Projects) ── */}
            <div className={`dispatch-builder bg-gray-800 border rounded-lg p-4 flex flex-col ${
              builderTab === 'pw' ? 'border-blue-600/40' : builderTab === 'sw' ? 'border-purple-600/40' : 'border-emerald-600/40'
            }`}>
              {/* Builder tab bar + Add Pull */}
              <div className="flex items-center gap-1 mb-3 border-b border-gray-700 pb-2">
                {([
                  { key: 'pw' as const, label: 'PW', active: 'bg-blue-600/30 text-blue-400' },
                  { key: 'sw' as const, label: 'SW', active: 'bg-purple-600/30 text-purple-400' },
                  { key: 'projects' as const, label: 'Projects', active: 'bg-emerald-600/30 text-emerald-400' },
                ] as const).map(tab => (
                  <button key={tab.key} onClick={() => handleBuilderTabChange(tab.key)}
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                      builderTab === tab.key
                        ? tab.active
                        : 'text-gray-400 hover:text-white hover:bg-gray-700'
                    }`}>
                    {tab.label}
                  </button>
                ))}
                <span className="flex-1" />
                {/* Add Pull — dispatch-write capability only (UI containment).
                    The submit path itself is a recorded BLOCKER pending a
                    governed staff pull-ingest callable; this only stops
                    view-only users from reaching it. */}
                {canCreateDispatch && (
                <button
                  onClick={() => setShowAddPullModal(true)}
                  className="px-2.5 py-1 text-xs font-medium rounded transition-colors flex items-center gap-1 bg-gray-700 text-green-400 hover:bg-gray-600 border border-gray-600"
                >
                  <span className="text-sm">+</span> Add Pull
                </button>
                )}
              </div>

              {/* ── PW Tab ── */}
              {builderTab === 'pw' && (
                <div className="flex-1 flex flex-col min-h-0">
                  <div className="text-blue-400 text-xs font-medium uppercase tracking-wider mb-3">Dispatch Production Water</div>
                  {/* Top: Well input + static info box */}
                  <div className="space-y-2 flex-shrink-0">
                    {/* Well — greyed out in multi-well mode */}
                    <div className="relative">
                      <label className="block text-xs text-gray-400 mb-1">Well</label>
                      {selectedWells.size > 0 ? (
                        <div className="w-full px-3 py-1.5 bg-gray-900/50 border border-blue-500/50 rounded text-blue-300 text-sm cursor-not-allowed">
                          {selectedWells.size} well{selectedWells.size !== 1 ? 's' : ''} checked
                          {totalSelectedLoads !== selectedWells.size && <span className="text-blue-400 ml-1">({totalSelectedLoads} loads)</span>}
                        </div>
                      ) : (
                        <>
                          <input type="text"
                            value={assignTarget ? (assignTarget.ndicName || assignTarget.wellName) : assignWellSearch}
                            onChange={(e) => {
                              if (assignTarget) { setAssignTarget(null); setAssignDriverHash(''); }
                              setAssignWellSearch(e.target.value);
                            }}
                            placeholder="Search wells or click Assign below..."
                            className={`w-full px-3 py-1.5 bg-gray-900 border rounded text-white text-sm focus:outline-none ${assignTarget ? 'border-blue-500 font-bold' : 'border-gray-700 focus:border-blue-500'}`}
                          />
                          {assignTarget && (
                            <button onClick={() => { setAssignTarget(null); setAssignDriverHash(''); setAssignWellSearch(''); }}
                              className="absolute right-2 top-7 text-gray-400 hover:text-white text-xs">✕</button>
                          )}
                          {!assignTarget && assignWellSearch.length >= 2 && (
                            <div className="absolute z-10 w-full bg-gray-900 border border-gray-700 rounded mt-0.5 max-h-32 overflow-y-auto">
                              {wells
                                .filter(w => (w.ndicName || w.wellName).toLowerCase().includes(assignWellSearch.toLowerCase()))
                                .slice(0, 8)
                                .map(w => (
                                  <button key={w.wellName} onClick={() => { setAssignTarget(w); setAssignWellSearch(''); }}
                                    className="wb-option-row px-3 py-1.5 text-white text-xs border-b border-gray-800 last:border-0">
                                    {w.ndicName || w.wellName} <span className="wb-option-sub text-gray-500">{w.route}</span>
                                  </button>
                                ))}
                              {wells.filter(w => (w.ndicName || w.wellName).toLowerCase().includes(assignWellSearch.toLowerCase())).length === 0 && (
                                <div className="px-3 py-1.5 text-gray-500 text-xs">No wells found</div>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    {/* Well info box — static height, content shows when well selected */}
                    <div className="bg-gray-900 rounded px-2 py-1.5 min-h-[44px]">
                      {assignTarget && selectedWells.size === 0 ? (() => {
                        // Source the LIVE pool well by name (never a frozen copy) and
                        // project at the shared clock — the modal's Current Level (Est.)
                        // matches the queue exactly. When the governed pool no longer
                        // carries this well, show '--' (unavailable) rather than a stale
                        // copy. The raw last-pull bottom is shown separately, labeled.
                        const liveWell = wells.find(w => w.wellName === assignTarget.wellName) ?? null;
                        const proj = liveWell ? projectWellLevel(liveWell, asOfMs) : null;
                        return (
                        <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
                          <span className="text-gray-400">Current Level (Est.): <span className="text-white font-mono">{proj?.available ? proj.estDisplay : '--'}</span></span>
                          <span className="text-gray-400">Last Pull: <span className="text-white font-mono">{liveWell?.lastPullBottomLevel || '--'}</span></span>
                          <span className="text-gray-400">Flow: <span className="text-white font-mono">{assignTarget.flowRate || '--'}</span></span>
                          <span className="text-gray-400">TTP: <span className="text-white font-mono">{assignTarget.timeTillPull || '--'}</span></span>
                          <span className="text-gray-400">Route: <span className="text-white">{assignTarget.route || '--'}</span></span>
                          <span className="text-gray-400">BBL/day: <span className="text-white font-mono">{assignTarget.windowBblsDay || assignTarget.bbls24hrs || '--'}</span></span>
                          <span className="text-gray-400">ETA Max: <span className="text-white font-mono">{assignTarget.etaToMax || '--'}</span></span>
                        </div>
                        );
                      })() : (
                        <div className="text-gray-600 text-xs italic">Select a well to see info</div>
                      )}
                    </div>
                  </div>
                  {/* Spacer pushes driver+ to bottom */}
                  <div className="flex-1" />
                  {/* Bottom: Driver, Disposal, Loads+Notes, Dispatch */}
                  <div className="space-y-2">
                    {/* Driver */}
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Driver</label>
                      <select value={assignDriverHash} onChange={(e) => setAssignDriverHash(e.target.value)}
                        className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-blue-500">
                        <option value="">Select driver...</option>
                        {assignTarget?.route && drivers.filter(d => d.assignedRoutes?.includes(assignTarget.route!)).length > 0 && (
                          <optgroup label={`Route: ${assignTarget.route}`}>
                            {drivers.filter(d => d.assignedRoutes?.includes(assignTarget.route!)).map(d => (
                              <option key={d.key} value={d.key} title={driverShiftDot(d).title}>{driverShiftDot(d).symbol + ' '}{operationalDriverName(d)}</option>
                            ))}
                          </optgroup>
                        )}
                        <optgroup label="All Drivers">
                          {drivers.map(d => (<option key={d.key} value={d.key} title={driverShiftDot(d).title}>{driverShiftDot(d).symbol + ' '}{operationalDriverName(d)}</option>))}
                        </optgroup>
                      </select>
                    </div>
                    {/* Disposal */}
                    <div className="relative">
                      <label className="block text-xs text-gray-400 mb-1">Disposal</label>
                      {assignDisposalWell ? (
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-900 border border-cyan-700 rounded text-sm">
                          <span className="text-cyan-400 flex-1 truncate">{assignDisposal}</span>
                          <button onClick={() => { setAssignDisposal(''); setAssignDisposalWell(null); setDisposalSearch(''); }} className="text-gray-400 hover:text-white text-xs">✕</button>
                        </div>
                      ) : (
                        <input type="text" value={disposalSearch}
                          onChange={(e) => { setDisposalSearch(e.target.value); setDisposalResults(e.target.value.length >= 2 ? searchDisposals(e.target.value, allDisposals) : []); }}
                          placeholder="Search SWD..." className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500" />
                      )}
                      {disposalResults.length > 0 && !assignDisposalWell && (
                        <div className="absolute z-50 w-full mt-1 bg-gray-800 border border-gray-600 rounded max-h-36 overflow-y-auto shadow-lg">
                          {disposalResults.map((d, i) => (
                            <button key={d.api_no || i} onClick={() => { setAssignDisposal(d.well_name); setAssignDisposalWell(d); setDisposalSearch(''); setDisposalResults([]); }}
                              className="wb-option-row px-3 py-1.5 border-b border-gray-700/50 last:border-0 text-white text-sm">
                              {d.well_name} <span className="wb-option-sub text-gray-400 text-xs ml-1">{d.county || ''}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Loads + Notes — loads greyed in multi-well mode */}
                    <div className="flex gap-2">
                      <div className="w-16">
                        <label className="block text-xs text-gray-400 mb-1">Loads</label>
                        {selectedWells.size > 0 ? (
                          <div className="w-full px-2 py-1.5 bg-gray-900/50 border border-gray-600 rounded text-gray-500 text-sm text-center cursor-not-allowed">
                            {totalSelectedLoads}
                          </div>
                        ) : (
                          <input type="number" min={1} max={20} value={assignLoadCount}
                            onChange={(e) => setAssignLoadCount(Math.max(1, parseInt(e.target.value) || 1))}
                            className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm text-center focus:outline-none focus:border-blue-500" />
                        )}
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs text-gray-400 mb-1">Notes</label>
                        <input type="text" value={assignNotes} onChange={(e) => setAssignNotes(e.target.value)}
                          placeholder="Special instructions..." className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500" />
                      </div>
                    </div>
                    {/* Dispatch — routes to bulk or single based on mode */}
                    {selectedWells.size > 0 ? (
                      <button onClick={submitBulkDispatch} disabled={!assignDriverHash || assigning}
                        className="w-full px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-xs font-medium rounded transition-colors">
                        {assigning ? 'Sending...' : `Dispatch ${totalSelectedLoads} Load${totalSelectedLoads !== 1 ? 's' : ''}`}
                      </button>
                    ) : (
                      <button onClick={submitPWDispatch} disabled={!assignTarget || !assignDriverHash || assigning}
                        className="w-full px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-xs font-medium rounded transition-colors">
                        {assigning ? 'Sending...' : assignLoadCount > 1 ? `Dispatch ${assignLoadCount} Loads` : 'Dispatch'}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* ── SW Tab ── */}
              {builderTab === 'sw' && (
                <div className="flex-1 flex flex-col min-h-0">
                  <div className="text-purple-400 text-xs font-medium uppercase tracking-wider mb-2">Dispatch Service Work</div>
                  <div className="flex flex-col gap-2 flex-1 min-h-0">
                    {/* Top row: Well/Drop-off stacked left, Service Type + Onsite By stacked right */}
                    <div className="flex gap-3 flex-shrink-0">
                      {/* Left: Well + Drop-off stacked */}
                      <div className="flex-1 space-y-2">
                        <div className="relative">
                          <label className="block text-xs text-gray-400 mb-1">Well / Location</label>
                          <input
                            type="text"
                            value={swWellName}
                            onChange={(e) => setSwWellName(e.target.value)}
                            placeholder="Type to search..."
                            className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-purple-500"
                          />
                          {(() => {
                            const q = swWellName.trim().toLowerCase();
                            if (q.length < 2) return null;
                            const exactMatch = wells.some(w => (w.ndicName || w.wellName).toLowerCase() === q) ||
                              allOperatorWells.some(w => w.well_name.toLowerCase() === q) ||
                              allDisposals.some(d => d.well_name.toLowerCase() === q);
                            if (exactMatch) return null;
                            const seen = new Set<string>();
                            const wellMatches = wells
                              .filter(w => (w.ndicName || w.wellName).toLowerCase().includes(q))
                              .map(w => { seen.add((w.ndicName || w.wellName).toLowerCase()); return { label: w.ndicName || w.wellName, sub: w.route || '', value: w.ndicName || w.wellName }; });
                            const operatorMatches = allOperatorWells
                              .filter(w => w.well_name.toLowerCase().includes(q) && !seen.has(w.well_name.toLowerCase()))
                              .map(w => { seen.add(w.well_name.toLowerCase()); return { label: w.well_name, sub: w.operator || 'NDIC', value: w.well_name }; });
                            const disposalMatches = searchDisposals(q, allDisposals)
                              .filter(d => !seen.has(d.well_name.toLowerCase()))
                              .map(d => ({ label: d.well_name, sub: 'SWD', value: d.well_name }));
                            const combined = [...wellMatches, ...operatorMatches, ...disposalMatches].slice(0, 15);
                            if (combined.length === 0) return null;
                            return (
                              <div className="absolute z-50 w-full mt-1 bg-gray-800 border border-gray-600 rounded max-h-48 overflow-y-auto shadow-lg">
                                {combined.map((item, i) => (
                                  <button key={`${item.value}-${i}`} type="button" onClick={() => setSwWellName(item.value)}
                                    className="wb-option-row px-3 py-1.5 border-b border-gray-700/50 last:border-0 text-white text-sm">
                                    {item.label}
                                    {item.sub && <span className="wb-option-sub text-gray-500 text-xs ml-2">{item.sub}</span>}
                                  </button>
                                ))}
                              </div>
                            );
                          })()}
                        </div>
                        <div className="relative">
                          <label className="block text-xs text-gray-400 mb-1">Drop-off (optional)</label>
                          <input
                            type="text"
                            value={swDropoff}
                            onChange={(e) => setSwDropoff(e.target.value)}
                            placeholder="SWD or well..."
                            className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-purple-500"
                          />
                          {(() => {
                            const q = swDropoff.trim().toLowerCase();
                            if (q.length < 2) return null;
                            const exactMatch = wells.some(w => (w.ndicName || w.wellName).toLowerCase() === q) ||
                              allOperatorWells.some(w => w.well_name.toLowerCase() === q) ||
                              allDisposals.some(d => d.well_name.toLowerCase() === q);
                            if (exactMatch) return null;
                            const seen2 = new Set<string>();
                            const wellMatches = wells
                              .filter(w => (w.ndicName || w.wellName).toLowerCase().includes(q))
                              .map(w => { seen2.add((w.ndicName || w.wellName).toLowerCase()); return { label: w.ndicName || w.wellName, sub: w.route || '', value: w.ndicName || w.wellName }; });
                            const operatorMatches = allOperatorWells
                              .filter(w => w.well_name.toLowerCase().includes(q) && !seen2.has(w.well_name.toLowerCase()))
                              .map(w => { seen2.add(w.well_name.toLowerCase()); return { label: w.well_name, sub: w.operator || 'NDIC', value: w.well_name }; });
                            const disposalMatches = searchDisposals(q, allDisposals)
                              .filter(d => !seen2.has(d.well_name.toLowerCase()))
                              .map(d => ({ label: d.well_name, sub: 'SWD', value: d.well_name }));
                            const combined = [...wellMatches, ...operatorMatches, ...disposalMatches].slice(0, 15);
                            if (combined.length === 0) return null;
                            return (
                              <div className="absolute z-50 w-full mt-1 bg-gray-800 border border-gray-600 rounded max-h-48 overflow-y-auto shadow-lg">
                                {combined.map((item, i) => (
                                  <button key={`${item.value}-${i}`} type="button" onClick={() => setSwDropoff(item.value)}
                                    className="wb-option-row px-3 py-1.5 border-b border-gray-700/50 last:border-0 text-white text-sm">
                                    {item.label}
                                    {item.sub && <span className="wb-option-sub text-gray-500 text-xs ml-2">{item.sub}</span>}
                                  </button>
                                ))}
                              </div>
                            );
                          })()}
                        </div>
                      </div>{/* end left: Well + Drop-off */}
                      {/* Right: Service Type + Onsite By stacked */}
                      <div className="flex-1 space-y-2">
                        <div>
                          <label className="block text-xs text-gray-400 mb-1">Service Type</label>
                          <select value={swServiceType} onChange={(e) => setSwServiceType(e.target.value)}
                            className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500">
                            <option value="">Select type...</option>
                            {dynamicServiceTypes.map(st => (
                              <option key={st} value={st}>{st}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-400 mb-1">Be onsite by</label>
                          <input
                            type="datetime-local"
                            value={swOnsiteBy}
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val && val.length > 16) return;
                              setSwOnsiteBy(val);
                            }}
                            max="2099-12-31T23:59"
                            className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
                          />
                        </div>
                      </div>
                    </div>{/* end top row */}
                    {/* Options row: Split Ticket + Heavy Water */}
                    <div className="flex items-center gap-4 flex-shrink-0 flex-wrap">
                      <label className="flex items-center gap-2 cursor-pointer group">
                        <input type="checkbox" checked={swSplitTicket} onChange={(e) => {
                          const checked = e.target.checked;
                          setSwSplitTicket(checked);
                          if (!checked) {
                            // Clear extras + close any open draft when Split Ticket is turned off.
                            setSwExtraSplitLegs([]);
                            setSwExtraLegDraft(null);
                          }
                        }}
                          className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-purple-600 focus:ring-purple-500" />
                        <span className={`text-xs ${swSplitTicket ? 'text-purple-400 font-medium' : 'text-gray-400 group-hover:text-gray-300'}`}>
                          Split Ticket
                        </span>
                        {swSplitTicket && (
                          <span className="text-[9px] text-purple-500 bg-purple-900/30 px-1.5 py-0.5 rounded">
                            {2 + swExtraSplitLegs.length} linked jobs
                          </span>
                        )}
                      </label>
                      {swSplitTicket && (
                        <button
                          type="button"
                          onClick={() => setSwExtraLegDraft({ disposal: '', bbls: '', notes: '' })}
                          disabled={swExtraLegDraft !== null}
                          className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded bg-purple-900/40 hover:bg-purple-900/60 text-purple-200 disabled:opacity-50 disabled:cursor-not-allowed border border-purple-700/50"
                          title="Add another split leg (C, D, E…)"
                        >
                          + Add Leg
                        </button>
                      )}
                      <label className="flex items-center gap-2 cursor-pointer group">
                        <input type="checkbox" checked={swHeavyWater} onChange={(e) => setSwHeavyWater(e.target.checked)}
                          className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-amber-600 focus:ring-amber-500" />
                        <span className={`text-xs ${swHeavyWater ? 'text-amber-400 font-medium' : 'text-gray-400 group-hover:text-gray-300'}`}>
                          Heavy Water (10+ lb)
                        </span>
                      </label>
                    </div>
                    {/* Extra-split-legs chip list (only when Split Ticket on AND extras exist) */}
                    {swSplitTicket && swExtraSplitLegs.length > 0 && (
                      <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
                        {swExtraSplitLegs.map((leg, idx) => {
                          const letter = String.fromCharCode(67 + idx); // C, D, E…
                          return (
                            <span
                              key={leg.id}
                              className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] rounded bg-purple-900/30 text-purple-200 border border-purple-700/50"
                            >
                              <span className="font-bold">{letter}:</span>
                              <span className="truncate max-w-[140px]">{leg.disposal}</span>
                              {leg.bbls && <span className="text-purple-400">({leg.bbls} bbl)</span>}
                              <button
                                type="button"
                                onClick={() => setSwExtraSplitLegs(prev => prev.filter(l => l.id !== leg.id))}
                                className="ml-0.5 text-purple-400 hover:text-purple-200 font-bold leading-none"
                                title={`Remove leg ${letter}`}
                              >
                                ×
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {/* Compact inline editor for a new split leg */}
                    {swSplitTicket && swExtraLegDraft && (
                      <div className="flex items-center gap-2 flex-wrap flex-shrink-0 bg-gray-900 border border-purple-700/50 rounded px-2 py-1.5">
                        <span className="text-[10px] font-bold text-purple-300">
                          Leg {String.fromCharCode(67 + swExtraSplitLegs.length)}:
                        </span>
                        <input
                          type="text"
                          value={swExtraLegDraft.disposal}
                          onChange={(e) => setSwExtraLegDraft(d => d ? { ...d, disposal: e.target.value } : d)}
                          placeholder="Destination / SWD"
                          autoFocus
                          className="px-2 py-0.5 bg-gray-800 border border-gray-700 rounded text-white text-xs placeholder-gray-500 focus:outline-none focus:border-purple-500 w-44"
                        />
                        <input
                          type="text"
                          inputMode="decimal"
                          value={swExtraLegDraft.bbls}
                          onChange={(e) => setSwExtraLegDraft(d => d ? { ...d, bbls: e.target.value } : d)}
                          placeholder="BBLs"
                          className="px-2 py-0.5 bg-gray-800 border border-gray-700 rounded text-white text-xs placeholder-gray-500 focus:outline-none focus:border-purple-500 w-20"
                        />
                        <input
                          type="text"
                          value={swExtraLegDraft.notes}
                          onChange={(e) => setSwExtraLegDraft(d => d ? { ...d, notes: e.target.value } : d)}
                          placeholder="Notes (optional)"
                          className="px-2 py-0.5 bg-gray-800 border border-gray-700 rounded text-white text-xs placeholder-gray-500 focus:outline-none focus:border-purple-500 w-44"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const draft = swExtraLegDraft;
                            if (!draft || !draft.disposal.trim()) return;
                            const id = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                            setSwExtraSplitLegs(prev => [
                              ...prev,
                              { id, disposal: draft.disposal.trim(), bbls: draft.bbls.trim(), notes: draft.notes.trim() },
                            ]);
                            setSwExtraLegDraft(null);
                          }}
                          disabled={!swExtraLegDraft.disposal.trim()}
                          className="px-2 py-0.5 text-[10px] font-medium rounded bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setSwExtraLegDraft(null)}
                          className="px-2 py-0.5 text-[10px] rounded border border-gray-600 hover:border-gray-500 text-gray-300"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    {/* Bottom row: Driver list + Notes side by side, bottom-aligned */}
                    <div className="flex gap-3 flex-1 min-h-0">
                      {/* Driver picker */}
                      <div className="flex-1 flex flex-col min-h-0">
                        <label className="block text-xs text-gray-400 mb-1">
                          Driver{swDriverHashes.size > 1 ? 's' : ''}
                          {swDriverHashes.size > 0 && <span className="ml-1 px-1.5 py-0.5 bg-purple-600 text-white text-[10px] rounded-full">{swDriverHashes.size}</span>}
                          {swEtaLoading && <span className="ml-1 text-gray-500 text-[10px]">calculating ETAs...</span>}
                        </label>
                        <div className="bg-gray-900 border border-gray-700 rounded flex-1 overflow-y-auto">
                          {drivers.map(d => {
                            const checked = swDriverHashes.has(d.key);
                            const eta = swDriverETAs.get(d.key);
                            const activeJob = dispatches.find(j => j.driverHash === d.key && ['accepted', 'in_progress', 'paused'].includes(j.status));
                            const stageLabel = activeJob?.driverStage?.replace(/_/g, ' ') || (activeJob ? 'on job' : '');
                            const etaColor = eta?.status === 'can_make_it' ? '#22c55e'
                              : eta?.status === 'tight' ? '#eab308'
                              : eta?.status === 'cant_make_it' ? '#ef4444'
                              : '#666';
                            return (
                              <button key={d.key} type="button" onClick={() => { setSwDriverHashes(prev => { const next = new Set(prev); if (next.has(d.key)) next.delete(d.key); else next.add(d.key); return next; }); }}
                                className={`w-full flex items-center gap-2 px-2 py-1 text-xs text-left border-b border-gray-800 last:border-0 transition-colors ${checked ? 'bg-purple-900/30 text-white' : 'text-gray-300 hover:bg-gray-800'}`}>
                                <input type="checkbox" checked={checked} readOnly className="w-3 h-3 rounded border-gray-600 bg-gray-800 text-purple-600 pointer-events-none flex-shrink-0" />
                                <span className="flex-1 min-w-0 truncate">{d.legalName || d.displayName}</span>
                                {activeJob && (
                                  <span className="flex-shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-900/50 text-blue-400 border border-blue-800">On Job</span>
                                )}
                                {eta && swOnsiteBy && (
                                  <span className="flex-shrink-0 font-bold text-[10px]" style={{ color: etaColor }}>{eta.display}</span>
                                )}
                                {stageLabel && (
                                  <span className="flex-shrink-0 text-[10px] text-gray-500">{stageLabel}</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      {/* Notes */}
                      <div className="flex-1 flex flex-col min-h-0">
                        <label className="block text-xs text-gray-400 mb-1">Notes</label>
                        <textarea value={swNotes} onChange={(e) => setSwNotes(e.target.value)} placeholder="Special instructions, equipment needed, etc."
                          className="w-full flex-1 px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-purple-500 resize-none" />
                      </div>
                    </div>{/* end bottom row */}
                  </div>{/* end SW body */}
                  {/* Dispatch button */}
                  <button onClick={submitServiceWork}
                    disabled={!swWellName.trim() || !swServiceType || swDriverHashes.size === 0 || swSubmitting}
                    className="w-full mt-2 px-4 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-xs font-medium rounded transition-colors flex-shrink-0">
                    {swSubmitting ? 'Sending...' : 'Dispatch'}
                  </button>
                </div>
              )}

              {/* ── Projects Tab ── */}
              {builderTab === 'projects' && (
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                  {/* NPB Sub-tabs + Create Project */}
                  <div className="flex items-center gap-1 mb-3 border-b border-gray-700 pb-2">
                    {([
                      { key: 'details' as const, label: 'Details', badge: newProjectName ? newProjectWells.length > 0 ? '✓' : '' : '' },
                      { key: 'drivers' as const, label: 'Drivers', badge: newProjectDriverHashes.size > 0 ? `${newProjectDriverHashes.size}` : '' },
                      { key: 'notes' as const, label: 'Notes', badge: newProjectNotes.trim() ? '✓' : '' },
                    ]).map(tab => (
                      <button key={tab.key} onClick={() => setNpbTab(tab.key)}
                        className={`px-3 py-1 text-xs font-medium rounded transition-colors ${npbTab === tab.key ? 'bg-emerald-600/30 text-emerald-400' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}>
                        {tab.label}
                        {tab.badge && <span className="ml-1.5 px-1 py-0.5 bg-emerald-600/20 text-emerald-400 text-[9px] rounded font-bold">{tab.badge}</span>}
                      </button>
                    ))}
                    <span className="flex-1" />
                    <button onClick={createProject}
                      disabled={!newProjectName.trim() || newProjectWells.length === 0 || creatingProject}
                      className="px-4 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-xs font-medium rounded transition-colors">
                      {creatingProject ? 'Creating...' : 'Create Project'}
                    </button>
                  </div>
                {/* Details tab */}
                {npbTab === 'details' && (
                  <div className="space-y-2 overflow-y-auto flex-1">
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <label className="block text-xs text-gray-400 mb-1">Project Name</label>
                        <input type="text" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)}
                          placeholder="e.g. Hess Flowback - Antelope Creek"
                          className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-emerald-500" />
                      </div>
                      <div className="flex-1 relative">
                        <label className="block text-xs text-gray-400 mb-1">Operator</label>
                        <input type="text" value={newProjectOperator}
                          onChange={(e) => { setNewProjectOperator(e.target.value); setOperatorSuggestions(searchOperators(e.target.value, allOperators)); }}
                          placeholder="e.g. Hess, Slawson"
                          className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-emerald-500" />
                        {operatorSuggestions.length > 0 && (
                          <div className="absolute z-10 w-full bg-gray-900 border border-gray-700 rounded mt-0.5 max-h-32 overflow-y-auto">
                            {operatorSuggestions.map(op => (
                              <button key={op.name} onClick={() => { setNewProjectOperator(op.name); setOperatorSuggestions([]); }}
                                className="wb-option-row px-3 py-1.5 text-white text-xs border-b border-gray-800 last:border-0">{op.name}</button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Wells ({newProjectWells.length} selected)</label>
                      <input type="text" value={projectWellSearch} onChange={(e) => setProjectWellSearch(e.target.value)}
                        placeholder="Search wells..."
                        className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-emerald-500" />
                      {newProjectWells.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {newProjectWells.map(w => (
                            <span key={w} className="px-2 py-0.5 bg-emerald-600/30 text-emerald-300 text-[10px] rounded flex items-center gap-1">
                              {w}
                              <button onClick={() => setNewProjectWells(prev => prev.filter(n => n !== w))} className="text-emerald-400 hover:text-white">×</button>
                            </span>
                          ))}
                        </div>
                      )}
                      {projectWellSearch.length >= 2 && (
                        <div className="bg-gray-900 border border-gray-700 rounded max-h-24 overflow-y-auto mt-1">
                          {wells
                            .filter(w => w.wellName.toLowerCase().includes(projectWellSearch.toLowerCase()) && !newProjectWells.includes(w.wellName))
                            .slice(0, 10)
                            .map(w => (
                              <button key={w.wellName} onClick={() => { setNewProjectWells(prev => [...prev, w.wellName]); setProjectWellSearch(''); }}
                                className="wb-option-row px-3 py-1.5 text-white text-xs border-b border-gray-800 last:border-0">
                                {w.ndicName || w.wellName} <span className="wb-option-sub text-gray-500">{w.route}</span>
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <label className="block text-xs text-gray-400 mb-1">Service Type</label>
                        <select
                          value={newProjectServiceType}
                          onChange={(e) => {
                            setNewProjectServiceType(e.target.value);
                            setNewProjectJobType(e.target.value === 'Production Water' ? 'pw' : 'service');
                          }}
                          className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-emerald-500"
                        >
                          <option value="">Select type...</option>
                          {dynamicServiceTypes.map(t => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                          <option value="Production Water">Production Water</option>
                        </select>
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs text-gray-400 mb-1">End Date (optional)</label>
                        <input type="date" value={newProjectEndDate} onChange={(e) => setNewProjectEndDate(e.target.value)}
                          min={new Date().toISOString().slice(0, 10)}
                          className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-emerald-500" />
                      </div>
                    </div>
                  </div>
                )}
                {/* Drivers tab */}
                {npbTab === 'drivers' && (
                  <div className="flex-1 overflow-y-auto">
                    <div className="grid grid-cols-2 gap-3 h-full">
                      {/* Day shift column */}
                      <div className="flex flex-col">
                        <div className="text-amber-400 text-[10px] font-bold uppercase tracking-wider mb-1">Day Shift ({Array.from(newProjectDriverHashes).filter(h => (newProjectDriverShifts.get(h) || 'day') === 'day').length})</div>
                        <div className="bg-gray-900 border border-amber-600/20 rounded flex-1 overflow-y-auto">
                          {drivers.map(d => {
                            const checked = newProjectDriverHashes.has(d.key);
                            const shift = newProjectDriverShifts.get(d.key) || 'day';
                            if (checked && shift !== 'day') return null;
                            return (
                              <label key={d.key} className="flex items-center gap-2 px-2 py-1 hover:bg-gray-800 cursor-pointer border-b border-gray-800/50 last:border-0">
                                <input type="checkbox" checked={checked && shift === 'day'}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setNewProjectDriverHashes(prev => { const next = new Set(prev); next.add(d.key); return next; });
                                      setNewProjectDriverShifts(prev => { const next = new Map(prev); next.set(d.key, 'day'); return next; });
                                    } else {
                                      setNewProjectDriverHashes(prev => { const next = new Set(prev); next.delete(d.key); return next; });
                                      setNewProjectDriverShifts(prev => { const next = new Map(prev); next.delete(d.key); return next; });
                                    }
                                  }}
                                  className="w-3 h-3 rounded border-gray-600 bg-gray-800 text-amber-500 focus:ring-amber-500 flex-shrink-0" />
                                <span className={`text-xs truncate ${checked && shift === 'day' ? 'text-white' : 'text-gray-400'}`}>{d.legalName || d.displayName}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                      {/* Night shift column */}
                      <div className="flex flex-col">
                        <div className="text-blue-400 text-[10px] font-bold uppercase tracking-wider mb-1">Night Shift ({Array.from(newProjectDriverHashes).filter(h => newProjectDriverShifts.get(h) === 'night').length})</div>
                        <div className="bg-gray-900 border border-blue-600/20 rounded flex-1 overflow-y-auto">
                          {drivers.map(d => {
                            const checked = newProjectDriverHashes.has(d.key);
                            const shift = newProjectDriverShifts.get(d.key) || 'day';
                            if (checked && shift !== 'night') return null;
                            return (
                              <label key={d.key} className="flex items-center gap-2 px-2 py-1 hover:bg-gray-800 cursor-pointer border-b border-gray-800/50 last:border-0">
                                <input type="checkbox" checked={checked && shift === 'night'}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setNewProjectDriverHashes(prev => { const next = new Set(prev); next.add(d.key); return next; });
                                      setNewProjectDriverShifts(prev => { const next = new Map(prev); next.set(d.key, 'night'); return next; });
                                    } else {
                                      setNewProjectDriverHashes(prev => { const next = new Set(prev); next.delete(d.key); return next; });
                                      setNewProjectDriverShifts(prev => { const next = new Map(prev); next.delete(d.key); return next; });
                                    }
                                  }}
                                  className="w-3 h-3 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 flex-shrink-0" />
                                <span className={`text-xs truncate ${checked && shift === 'night' ? 'text-white' : 'text-gray-400'}`}>{d.legalName || d.displayName}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                    {/* Drop-off assignments for selected drivers */}
                    {newProjectDriverHashes.size > 0 && (
                      <div className="mt-3 pt-3 border-t border-gray-700/50">
                        <div className="text-gray-400 text-[10px] font-bold uppercase tracking-wider mb-1.5">Drop-off Assignments</div>
                        <div className="space-y-1">
                          {Array.from(newProjectDriverHashes).map(hash => {
                            const driver = drivers.find(d => d.key === hash);
                            if (!driver) return null;
                            return (
                              <DriverDisposalRow
                                key={hash}
                                hash={hash}
                                name={driver.legalName || driver.displayName}
                                disposal={newProjectDriverDisposals[hash]}
                                borderColor="border-gray-700"
                                allDisposals={allDisposals}
                                onRemove={() => {
                                  setNewProjectDriverHashes(prev => { const next = new Set(prev); next.delete(hash); return next; });
                                  setNewProjectDriverShifts(prev => { const next = new Map(prev); next.delete(hash); return next; });
                                  setNewProjectDriverDisposals(prev => { const next = { ...prev }; delete next[hash]; return next; });
                                }}
                                onSetDisposal={(disp) => {
                                  setNewProjectDriverDisposals(prev => {
                                    const next = { ...prev };
                                    if (disp) next[hash] = disp;
                                    else delete next[hash];
                                    return next;
                                  });
                                }}
                              />
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* Notes tab */}
                {npbTab === 'notes' && (
                  <div className="flex-1 flex flex-col">
                    <label className="block text-xs text-gray-400 mb-1">Job Description & Instructions</label>
                    <textarea value={newProjectNotes} onChange={(e) => setNewProjectNotes(e.target.value)}
                      placeholder={"Be on location loaded at 7:00am\n\nEmpty truck to Pad 379. Suck up rain water by the Recycle pump. Haul to SWD.\n\nYou will meet the roustabout crew around 1:30-2:00pm to clear the Recycle line at Pad 379.\n\nOnce finished follow the crew to Atlas Pad."}
                      className="w-full flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-emerald-500 resize-none" />
                  </div>
                )}
                </div>
              )}{/* end Projects tab */}
            </div>{/* end Tabbed Builder panel */}

            {/* ═══════ Well Queue (right column; detachable — CP3) ═══════ */}
            <div className={`dispatch-queue bg-gray-800 rounded-lg border border-gray-700 flex flex-col${wellQueueExpanded ? ' is-expanded' : ''}${searchActive ? ' has-search' : ''}${queueDetached ? ' is-detached' : ''}`}>
            <DetachablePane
              detached={queueDetached}
              onDock={() => dockQueue(false)}
              title="Well Queue"
              mountClassName="detached-pane detached-pane-queue"
            >
              {/* Panel header with filters */}
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-700 flex-shrink-0 flex-wrap">
                <h3 className="text-sm font-semibold text-white flex-shrink-0">Well Queue</h3>
                {/* Primary actionable views (route is a secondary filter below) */}
                <div className="flex rounded-md overflow-hidden border border-gray-600 flex-shrink-0">
                  {([
                    ['needs-pull', 'Needs Pull'],
                    ['next-24h', 'Next 24h'],
                    ['all', 'All Wells'],
                    ['needs-data', 'Needs Data'],
                  ] as [QueueView, string][]).map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => setQueueView(v)}
                      className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                        queueView === v ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:bg-gray-700'
                      }`}
                    >
                      {label}{queueReady && viewCounts[v] > 0 ? ` (${viewCounts[v]})` : ''}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  placeholder="Search wells..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="dispatch-queue-search px-2.5 py-1 bg-gray-900 border border-gray-700 rounded text-white text-xs placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                <select
                  value={routeFilter}
                  onChange={(e) => setRouteFilter(e.target.value)}
                  className="dispatch-queue-route px-2 py-1 bg-gray-900 border border-gray-700 rounded text-white text-xs focus:outline-none focus:border-blue-500"
                >
                  <option value="all">All Routes</option>
                  {routes.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => dockQueue(!queueDetached)}
                  title={queueDetached ? 'Return the Well Queue to the dashboard' : 'Open the Well Queue in its own window'}
                  // Pop-Out is a wide-screen convenience (xl only); once detached, the
                  // pop-out window is narrow (~560px) so Reattach must ALWAYS be visible
                  // there — otherwise there is no way to dock back from inside the window.
                  className={`${queueDetached ? 'inline-flex' : 'hidden xl:inline-flex'} items-center gap-1 px-2 py-1 text-[11px] font-medium rounded text-gray-300 bg-gray-900 border border-gray-700 hover:bg-gray-700 flex-shrink-0`}
                >{queueDetached ? '⧉ Reattach' : '⧉ Pop Out'}</button>
                <button
                  type="button"
                  className="dispatch-queue-toggle"
                  aria-expanded={wellQueueExpanded}
                  aria-controls="dispatch-queue-body"
                  onClick={() => setWellQueueExpanded((open) => !open)}
                >
                  {wellQueueExpanded ? 'Hide list' : 'Show list'}
                </button>
                <span className="text-gray-500 text-xs flex-shrink-0">
                  {statusUnavailable
                    ? 'status unavailable'
                    : search.trim()
                      ? `${queueRows.length} matching of ${routeWells.filter(w => !(w.isDown || w.currentLevel === 'DOWN')).length} route wells`
                      : `${queueRows.length} wells`}
                </span>
              </div>

              {/* Selection indicator — shows in Well Queue header area */}
              {selectedWells.size > 0 && (
                <div className="bg-blue-900/30 border-b border-blue-600/30 px-4 py-2 flex-shrink-0 flex items-center gap-3">
                  <span className="text-white text-xs font-medium">
                    {selectedWells.size} well{selectedWells.size !== 1 ? 's' : ''} selected
                    {totalSelectedLoads !== selectedWells.size && <span className="text-blue-300 ml-1">({totalSelectedLoads} loads)</span>}
                  </span>
                  <span className="flex-1" />
                  <button onClick={() => { setSelectedWells(new Map()); setAssignTarget(null); }} className="text-gray-400 hover:text-white text-xs">Clear</button>
                </div>
              )}

              <div id="dispatch-queue-body" className="dispatch-queue-body">
              {/* Scrollable well table */}
              <div className="overflow-x-auto">
                {dataLoading ? (
                  <div className="text-gray-400 py-8 text-center">Loading well data...</div>
                ) : statusUnavailable ? (
                  <div className="py-8 text-center" role="alert">
                    <div className="text-amber-400 font-medium">Live well status unavailable</div>
                    <div className="text-gray-500 text-xs mt-1">{readErrors.wells || 'The authoritative status read failed — pull eligibility cannot be determined. Retrying…'}</div>
                  </div>
                ) : queueRows.length === 0 ? (
                  <div className="text-gray-400 py-8 text-center">{showingSearchHits ? 'No wells match search' : 'No wells match filters'}</div>
                ) : (
                  <table className="w-full">
                    <thead className="bg-gray-700 sticky top-0 z-10">
                      <tr>
                        <th className="px-2 py-2 text-left text-[11px] font-medium text-gray-300 w-24 min-w-[88px]">Priority</th>
                        <th className="px-2 py-2 text-left text-[11px] font-medium text-gray-300 min-w-[130px]">Coverage</th>
                        <th className="px-2 py-2 text-left text-[11px] font-medium text-gray-300">Well</th>
                        <th className="px-2 py-2 text-left text-[11px] font-medium text-gray-300">Current Level (Est.)</th>
                        <th className="px-2 py-2 text-left text-[11px] font-medium text-gray-300">Flow</th>
                        <th className="px-2 py-2 text-left text-[11px] font-medium text-gray-300">TTP</th>
                        <th className="dispatch-queue-col-pulls px-2 py-2 text-left text-[11px] font-medium text-gray-300">Pulls/Day</th>
                        <th className="px-2 py-2 text-right text-[11px] font-medium text-gray-300 w-36">
                          <div className="flex items-center justify-end gap-1.5">
                            <span>Action</span>
                            {(() => { const sel = queueRows.filter(q => !q.assignment && q.priority.state !== 'down'); return (
                            <input type="checkbox" checked={sel.length > 0 && sel.every(q => selectedWells.has(q.well.wellName))} onChange={toggleSelectAll} className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer" />
                            ); })()}
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-700/50">
                      {queueRows.map(({ well, priority, assignment }) => {
                        const isSelected = selectedWells.has(well.wellName);
                        const loadCount = selectedWells.get(well.wellName) || 1;
                        // Assignment state: rendered in dedicated Coverage column, never demoting physical urgency.
                        // Assigned rows show 'ASSIGNED — driver', visible View affordance, and Reassign (never Assign).
                        const isAssigned = !!assignment;
                        // Assignment eligibility (documented policy — does NOT blindly
                        // track "actionable"): a DOWN well is never dispatchable; a
                        // predicted well (PULL NOW / APPROACHING) assigns normally; a
                        // NEEDS DATA / NO GAIN well has no pull prediction, so Assign is
                        // a visible manual OVERRIDE (dispatcher may send a driver to
                        // physically verify) — never presented as an agreeing prediction.
                        const assignBlocked = priority.state === 'down';
                        const assignOverride = priority.state === 'verify' || priority.state === 'no-gain';
                        const wbmHref = wellDetailHref(well);
                        return (
                          <tr
                            key={well.responseId || well.wellName}
                            onClick={wbmHref ? () => router.push(wbmHref) : undefined}
                            className={`transition-colors ${wbmHref ? 'cursor-pointer' : ''} ${isAssigned ? 'bg-gray-800/40 hover:bg-gray-750' : `hover:bg-gray-750 ${priority.state === 'pull-now' ? 'bg-red-900/10' : ''}`} ${isSelected ? 'bg-blue-900/20' : ''}`}
                          >
                            <td className="px-2 py-1.5">
                              <span className={`inline-block whitespace-nowrap px-1.5 py-0.5 text-[10px] font-bold rounded ${priority.color} ${priority.textColor}`}>{priority.label}</span>
                            </td>
                            <td className="px-2 py-1.5">
                              {isAssigned ? (
                                <span className="inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-900/40 text-blue-200 border border-blue-700/50">
                                  <span>ASSIGNED —</span>
                                  <span className="font-semibold text-white">{assignment!.driver}</span>
                                </span>
                              ) : (
                                <span className="inline-block whitespace-nowrap px-1.5 py-0.5 text-[10px] font-medium rounded bg-gray-700/50 text-gray-400 border border-gray-600/40">
                                  UNASSIGNED
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-1.5">
                              {wbmHref ? (
                                <div className="text-blue-300 hover:text-blue-200 font-medium text-xs underline decoration-dotted underline-offset-2" title="Open the exact well in WB-M">{well.wellName}</div>
                              ) : (
                                <div className="text-white font-medium text-xs" title="Open in WB-M unavailable — no canonical company/well identity">{well.wellName}</div>
                              )}
                              <div className="text-gray-500 text-[10px]">{well.route || 'Unrouted'}</div>
                            </td>
                            <td className="px-2 py-1.5 font-mono text-[10px]">
                              {(() => {
                                const c = classifyWell(well, asOfMs);
                                const hasEst = c.estFeet !== null;
                                return (
                                  <>
                                    {/* WB‑M vc58 estimated CURRENT level (the shared estimate) */}
                                    <span className={hasEst ? 'text-white font-bold' : 'text-gray-500'}>{c.estDisplay}</span>
                                    {!c.hasFlow && c.state !== 'down' && hasEst && (
                                      <span className="text-gray-500"> · frozen</span>
                                    )}
                                    {c.lastLevelAgeHours !== null && (
                                      <span className="text-gray-500"> · {formatAge(c.lastLevelAgeHours)}</span>
                                    )}
                                    {/* Pull-ready target + WB‑M loads available at the estimate */}
                                    {c.readyFeet !== null && (
                                      <span className="block text-gray-500">ready {inchesToLevel(c.readyFeet * 12)}{c.state === 'pull-now' && c.availableLoads > 0 ? ` · ${c.availableLoads} load${c.availableLoads !== 1 ? 's' : ''}` : c.remainingInches !== null && c.remainingInches > 0 ? ` · ${inchesToLevel(c.remainingInches)} to go` : ''}</span>
                                    )}
                                    {(c.state === 'verify' || c.state === 'no-gain') && (
                                      <span className={`block font-bold ${c.state === 'no-gain' ? 'text-gray-400' : 'text-amber-400'}`}>{c.label}</span>
                                    )}
                                  </>
                                );
                              })()}
                            </td>
                            <td className="px-2 py-1.5 text-white font-mono text-[10px]">{well.flowRate || '--'}</td>
                            <td className="px-2 py-1.5 text-white font-mono text-[10px]">{formatTTP(well, asOfMs)}</td>
                            <td className="dispatch-queue-col-pulls px-2 py-1.5"><PullsPredictionCell well={well} /></td>
                            <td className="px-2 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                              {isAssigned ? (
                                <div className="flex items-center justify-end gap-1.5">
                                  {wbmHref ? (
                                    <button
                                      type="button"
                                      onClick={() => router.push(wbmHref)}
                                      aria-label={`View ${well.wellName} in WB-M`}
                                      title={`View ${well.wellName} in WB-M`}
                                      className="px-2 py-1 text-[10px] font-medium rounded whitespace-nowrap bg-gray-700 hover:bg-gray-600 text-gray-200"
                                    >
                                      View
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      disabled
                                      aria-disabled="true"
                                      aria-label={`View ${well.wellName} (detail unavailable)`}
                                      title="Well detail unavailable (missing canonical company or NDIC API number)"
                                      className="px-2 py-1 text-[10px] font-medium rounded whitespace-nowrap bg-gray-800/60 text-gray-500 cursor-not-allowed border border-gray-700/50"
                                    >
                                      View
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => openReassignInPlace(assignment!.job)}
                                    aria-label={`Reassign ${well.wellName} to another driver`}
                                    title={`Reassign ${well.wellName} to another driver`}
                                    className="px-2 py-1 text-[10px] font-medium rounded whitespace-nowrap bg-purple-700 hover:bg-purple-600 text-white">💃 Reassign</button>
                                </div>
                              ) : (
                              <div className="flex items-center justify-end gap-2">
                                {/* View is UNCONDITIONAL — beside Assign on unassigned rows, exactly as it is
                                    beside Reassign on assigned rows. Previously it lived only in the assigned
                                    branch, so unassigned (e.g. Stock Yards) rows rendered no View affordance. */}
                                {wbmHref ? (
                                  <button
                                    type="button"
                                    onClick={() => router.push(wbmHref)}
                                    aria-label={`View ${well.wellName} in WB-M`}
                                    title={`View ${well.wellName} in WB-M`}
                                    className="px-2 py-1 text-[10px] font-medium rounded whitespace-nowrap bg-gray-700 hover:bg-gray-600 text-gray-200"
                                  >
                                    View
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    disabled
                                    aria-disabled="true"
                                    aria-label={`View ${well.wellName} (detail unavailable)`}
                                    title="Well detail unavailable (missing canonical company or NDIC API number)"
                                    className="px-2 py-1 text-[10px] font-medium rounded whitespace-nowrap bg-gray-800/60 text-gray-500 cursor-not-allowed border border-gray-700/50"
                                  >
                                    View
                                  </button>
                                )}
                                {isSelected ? (
                                  <div className="flex items-center gap-1">
                                    <input type="text" inputMode="numeric" pattern="[0-9]*" value={loadCount}
                                      onFocus={(e) => e.target.select()}
                                      onChange={(e) => {
                                        const val = parseInt(e.target.value) || 0;
                                        if (val >= 1 && val <= 20) setWellLoadCount(well.wellName, val);
                                        else if (e.target.value === '') setWellLoadCount(well.wellName, 1);
                                      }}
                                      className="w-10 px-1 py-0.5 bg-gray-900 border border-blue-600 rounded text-white text-[10px] text-center focus:outline-none" />
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => {
                                      if (assignOverride) {
                                        // Manual override: this well has no pull prediction. Explain the
                                        // exact verification reason and require confirmation before assigning.
                                        const reason = verifyReasonText(priority.reason);
                                        const ok = window.confirm(
                                          `${well.wellName} is not confirmed ready to pull — ${reason}.\n\n` +
                                          `The queue can't verify this well needs a pull right now. Assign a driver anyway?`
                                        );
                                        if (!ok) return;
                                      }
                                      openAssignModal(well);
                                    }}
                                    disabled={selectedWells.size > 0 || assignBlocked}
                                    title={assignBlocked
                                      ? 'Well is DOWN — not dispatchable'
                                      : assignOverride ? `${priority.label}: ${verifyReasonText(priority.reason)} — manual override (confirmation required)` : undefined}
                                    className={`px-2 py-1 text-white text-[10px] font-medium rounded transition-colors whitespace-nowrap ${
                                      selectedWells.size > 0 || assignBlocked ? 'bg-gray-600 cursor-not-allowed opacity-50'
                                        : assignOverride ? 'bg-amber-700 hover:bg-amber-600 ring-1 ring-amber-400/60'
                                        : 'bg-blue-600 hover:bg-blue-500'}`}>{assignOverride ? 'Assign anyway' : 'Assign'}</button>
                                )}
                                <input type="checkbox" checked={isSelected}
                                  disabled={!!assignTarget || assignBlocked}
                                  onChange={() => toggleWellSelection(well.wellName)}
                                  className={`w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500 focus:ring-offset-0 ${assignTarget || assignBlocked ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}`} />
                              </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              </div>
            </DetachablePane>
            </div>

          {/* ═══════ Active Jobs / Projects — left column, below the builder
                     (jobs-first on Fold/narrow via order); detachable — CP3 ═══════ */}
          <div className={`dispatch-pane dispatch-pane-jobs${jobsDetached ? ' is-detached' : ''}`}>
            <div className="dispatch-jobs bg-gray-800 rounded-lg border border-gray-700 flex flex-col">
            <DetachablePane
              detached={jobsDetached}
              onDock={() => dockJobs(false)}
              title="Active Jobs"
              mountClassName="detached-pane detached-pane-jobs"
              width={1100}
              height={800}
            >
              {/* Panel header with tabs. flex-wrap so at narrow widths the controls
                  (including Reattach) wrap cleanly onto a second line instead of the
                  Reattach button being pushed off / hidden. */}
              <div className="flex flex-wrap items-center justify-between gap-y-1 px-4 py-2.5 border-b border-gray-700 flex-shrink-0">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => { setRightPanelTab('jobs'); setSelectedProject(null); }}
                    className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                      rightPanelTab === 'jobs'
                        ? 'bg-blue-600 text-white'
                        : 'text-gray-400 hover:text-white hover:bg-gray-700'
                    }`}
                  >
                    Active Jobs
                    {(() => {
                      const activeCount = dispatches.filter(d => !['completed', 'dismissed'].includes(d.status)).reduce((sum, d) => sum + ((d as any).loadCount || 1), 0);
                      return activeCount > 0 ? (
                        <span className={`ml-1 px-1.5 py-0.5 text-[10px] rounded font-bold ${
                          rightPanelTab === 'jobs' ? 'bg-blue-500/40 text-blue-100' : 'bg-blue-600/20 text-blue-400'
                        }`}>{activeCount}</span>
                      ) : null;
                    })()}
                  </button>
                  <button
                    onClick={() => setRightPanelTab('completed')}
                    className={`px-3 py-1 rounded text-sm font-medium transition-colors flex items-center gap-1.5 ${
                      rightPanelTab === 'completed'
                        ? 'bg-green-600 text-white'
                        : 'text-gray-400 hover:text-white hover:bg-gray-700'
                    }`}
                  >
                    Completed
                    {dispatches.filter(d => d.status === 'completed').length > 0 && (
                      <span className={`px-1.5 py-0.5 text-[10px] rounded font-bold ${
                        rightPanelTab === 'completed' ? 'bg-green-500/40 text-green-100' : 'bg-green-600/20 text-green-400'
                      }`}>{dispatches.filter(d => d.status === 'completed').length}</span>
                    )}
                  </button>
                  <button
                    onClick={() => setRightPanelTab('projects')}
                    className={`px-3 py-1 rounded text-sm font-medium transition-colors flex items-center gap-1.5 ${
                      rightPanelTab === 'projects'
                        ? 'bg-emerald-600 text-white'
                        : 'text-gray-400 hover:text-white hover:bg-gray-700'
                    }`}
                  >
                    Projects
                    {projects.length > 0 && (
                      <span className={`px-1.5 py-0.5 text-[10px] rounded font-bold ${
                        rightPanelTab === 'projects' ? 'bg-emerald-500/40 text-emerald-100' : 'bg-emerald-600/20 text-emerald-400'
                      }`}>{projects.length}</span>
                    )}
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => dockJobs(!jobsDetached)}
                    title={jobsDetached ? 'Return Active Jobs to the dashboard' : 'Open Active Jobs in its own window'}
                    // Same rule as the Well Queue: Pop-Out is xl-only, but the Reattach
                    // control MUST be visible in the narrow detached window so Active Jobs
                    // can always be docked back. (Fixes the missing-Reattach pop-out bug.)
                    className={`${jobsDetached ? 'inline-flex' : 'hidden xl:inline-flex'} items-center gap-1 px-2 py-1 text-[11px] font-medium rounded text-gray-300 bg-gray-900 border border-gray-700 hover:bg-gray-700 flex-shrink-0`}
                  >{jobsDetached ? '⧉ Reattach' : '⧉ Pop Out'}</button>
                  {rightPanelTab === 'jobs' && (
                    <>
                      {(() => { const pw = dispatches.filter(d => d.jobType === 'pw' && d.status !== 'completed'); const pwLoads = pw.reduce((s, d) => s + ((d as any).loadCount || 1), 0); return pwLoads > 0 ? (
                        <span className="px-1.5 py-0.5 bg-blue-600/20 text-blue-400 text-[10px] rounded font-bold">
                          {pwLoads} {jobTypeCode('pw')}
                        </span>
                      ) : null; })()}
                      {(() => { const sw = dispatches.filter(d => d.jobType === 'service' && d.status !== 'completed'); const swLoads = sw.reduce((s, d) => s + ((d as any).loadCount || 1), 0); return swLoads > 0 ? (
                        <span className="px-1.5 py-0.5 bg-purple-600/20 text-purple-400 text-[10px] rounded font-bold">
                          {swLoads} {jobTypeCode('service')}
                        </span>
                      ) : null; })()}
                    </>
                  )}
                  {rightPanelTab === 'projects' && selectedProject && (
                    <button
                      onClick={() => setSelectedProject(null)}
                      className="px-2.5 py-1 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded transition-colors"
                    >
                      ← All Projects
                    </button>
                  )}
                </div>
              </div>
              {/* Project quick-switch pills */}
              {rightPanelTab === 'projects' && projects.length > 0 && (
                <div className="flex items-center gap-1.5 px-3 py-2 border-b border-gray-700/50 overflow-x-auto flex-shrink-0" style={{ scrollbarWidth: 'none' }}>
                  {projects.map(p => {
                    const isSelected = selectedProject?.id === p.id;
                    const colors = p.status === 'active'
                      ? isSelected ? 'bg-emerald-600 text-white' : 'border border-emerald-600/40 text-emerald-400 hover:bg-emerald-600/20'
                      : p.status === 'paused'
                      ? isSelected ? 'bg-amber-600 text-white' : 'border border-amber-600/40 text-amber-400 hover:bg-amber-600/20'
                      : isSelected ? 'bg-gray-600 text-white' : 'border border-gray-600 text-gray-400 hover:bg-gray-700';
                    return (
                      <button
                        key={p.id}
                        onClick={() => setSelectedProject(isSelected ? null : p)}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors flex-shrink-0 ${colors}`}
                        title={`${p.name} (${p.status})`}
                      >
                        {p.name.length > 24 ? p.name.slice(0, 22) + '…' : p.name}
                      </button>
                    );
                  })}
                </div>
              )}
              {/* Scrollable content (owns internal scroll in the CP2 desktop grid) */}
              <div className="dispatch-jobs-body p-3">
                {rightPanelTab === 'jobs' && (
                  <ActiveDispatchPanel
                    dispatches={dispatches.filter(d => d.status !== 'completed' && d.status !== 'dismissed')}
                    cancelDispatch={cancelDispatch}
                    drivers={drivers}
                    assignTransfer={assignTransfer}
                    onEditServiceWork={openEditSwModal}
                    onReassignDeclined={openReassignModal}
                    onDismissDeclined={dismissDeclinedDispatch}
                    activeJobsReady={!driversLoading && dispatchesLoaded}
                    wells={wells}
                    nowMs={asOfMs}
                  />
                )}
                {rightPanelTab === 'completed' && (
                  <CompletedJobsPanel
                    jobs={dispatches.filter(d => d.status === 'completed')}
                    drivers={drivers}
                    allWells={allOperatorWells}
                    allDisposals={allDisposals}
                    highlightJobId={highlightJobId}
                    onHighlightClear={() => setHighlightJobId(null)}
                    authenticatedCompanyId={user?.companyId || null}
                    updateCompletedJob={staffUpdateDispatch}
                  />
                )}
                {rightPanelTab === 'projects' && !selectedProject && (
                  <ProjectsListPanel
                    projects={projects}
                    dispatches={dispatches}
                    drivers={drivers}
                    onSelect={(p) => setSelectedProject(p)}
                  />
                )}
                {rightPanelTab === 'projects' && selectedProject && (
                  <ProjectDetailPanel
                    project={selectedProject}
                    projectDispatches={projectDispatches}
                    projectInvoices={projectInvoices}
                    drivers={drivers}
                    allDisposals={allDisposals}
                    cancelDispatch={cancelDispatch}
                    onStatusChange={updateProjectStatus}
                    onAddDriver={(hash) => addDriverToProjectToday(selectedProject.id!, hash)}
                    onUpdateProject={async (id, data) => {
                      if (!guardCreateDispatch()) return;
                      try {
                        const firestore = getFirestoreDb();
                        await updateDoc(doc(firestore, 'projects', id), data as any);
                      } catch (err) {
                        console.error('Failed to update project:', err);
                        setMessage('Error: ' + (err instanceof Error ? err.message : 'could not update project'));
                        setTimeout(() => setMessage(''), 5000);
                      }
                    }}
                    onBatchDispatch={(shift) => batchDispatchShift(selectedProject.id!, shift)}
                  />
                )}
              </div>
            </DetachablePane>
            </div>
          </div>
        </div>
      </main>

      {/* ═══════════════════════════════════════════════════════════════════════════
          CREATE PROJECT MODAL
          ═══════════════════════════════════════════════════════════════════════════ */}
      {/* Old Create Project modal removed — now inline over PW+SW cards */}

      {/* PW ASSIGN MODAL removed — replaced by inline PW dispatch card above */}

      {/* ═══════════════════════════════════════════════════════════════════════════
          REASSIGN DECLINED JOB MODAL
          ═══════════════════════════════════════════════════════════════════════════ */}
      {/* ADD PULL MODAL — shared component */}
      {showAddPullModal && (
        <AddPullModal
          wells={wells}
          drivers={drivers}
          allDisposals={allDisposals}
          onClose={() => setShowAddPullModal(false)}
          onMessage={(msg) => { setMessage(msg); setTimeout(() => setMessage(''), 5000); }}
          navigateOnSuccess={false}
        />

      )}

      {reassignJob && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 border border-gray-700">
            <h3 className="text-lg font-semibold text-white mb-1">Reassign Job</h3>
            <p className="text-gray-400 text-sm mb-4 flex items-center gap-2 flex-wrap">
              <JobTypeBadge type={reassignJob.jobType} serviceType={reassignJob.serviceType} />
              <span className="text-white font-medium">{reassignJob.ndicWellName || reassignJob.wellName}</span>
              {reassignJob.status === 'declined' && (
                <>
                  {' '}was declined by{' '}
                  <span className="text-red-400">{reassignJob.declinedBy || reassignJob.driverFirstName || reassignJob.driverName}</span>
                </>
              )}
              {reassignJob.status !== 'declined' && (
                <>
                  {' '}currently assigned to{' '}
                  <span className="text-amber-400">{reassignJob.driverFirstName || reassignJob.driverName}</span>
                </>
              )}
            </p>

            {/* Decline reason */}
            {reassignJob.declineReason && (
              <div className="bg-red-950/30 border border-red-600/20 rounded-lg px-3 py-2 mb-4">
                <span className="text-gray-500 text-xs">Reason: </span>
                <span className="text-gray-300 text-sm italic">&ldquo;{reassignJob.declineReason}&rdquo;</span>
              </div>
            )}

            {/* Job summary */}
            <div className="bg-gray-900 rounded-lg p-3 mb-4 grid grid-cols-2 gap-2 text-sm">
              {(() => {
                // The reassign job only carries a copied currentLevel — resolve the LIVE
                // pool well by name and project at the shared clock so this Current Level
                // (Est.) equals the queue's, never the stale copied value. The recorded
                // last-pull bottom is shown separately and labeled.
                const liveWell = wells.find(w => w.wellName === reassignJob.wellName);
                const proj = liveWell ? projectWellLevel(liveWell, asOfMs) : null;
                return (
                  <>
                    <div>
                      <span className="text-gray-500">Current Level (Est.):</span>
                      <span className="text-white ml-2 font-mono">{proj?.available ? proj.estDisplay : '--'}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Last Pull:</span>
                      <span className="text-white ml-2 font-mono">{liveWell?.lastPullBottomLevel || '--'}</span>
                    </div>
                  </>
                );
              })()}
              <div>
                <span className="text-gray-500">Flow Rate:</span>
                <span className="text-white ml-2 font-mono">{reassignJob.flowRate || '--'}</span>
              </div>
              {reassignJob.disposal && (
                <div className="col-span-2">
                  <span className="text-gray-500">Disposal:</span>
                  <span className="text-cyan-400 ml-2">{reassignJob.disposal}</span>
                </div>
              )}
              {reassignJob.notes && (
                <div className="col-span-2">
                  <span className="text-gray-500">Notes:</span>
                  <span className="text-gray-300 ml-2 italic">{reassignJob.notes}</span>
                </div>
              )}
            </div>

            {/* Load count picker — only for multi-load jobs; not for in-place
                reassign (which keeps the same single dispatch under a new driver). */}
            {reassignMode !== 'in_place' && (() => {
              const remaining = (reassignJob.loadCount || 1) - (reassignJob.loadsCompleted || 0);
              if (remaining <= 1) return null;
              return (
                <div className="mb-4">
                  <label className="block text-sm text-gray-400 mb-1">Loads to Reassign</label>
                  <div className="flex items-center gap-2">
                    <select
                      value={reassignLoads}
                      onChange={(e) => setReassignLoads(parseInt(e.target.value))}
                      className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
                    >
                      <option value={0}>All {remaining} loads</option>
                      {Array.from({ length: remaining - 1 }, (_, i) => i + 1).map(n => (
                        <option key={n} value={n}>{n} of {remaining} loads</option>
                      ))}
                    </select>
                    {reassignLoads > 0 && (
                      <span className="text-gray-500 text-xs whitespace-nowrap">
                        {remaining - reassignLoads} stays with {reassignJob.driverFirstName || reassignJob.driverName}
                      </span>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Driver picker */}
            <div className="mb-4">
              <label className="block text-sm text-gray-400 mb-1">Assign to Driver</label>
              <select
                value={reassignDriverHash}
                onChange={(e) => setReassignDriverHash(e.target.value)}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="">Select driver...</option>
                {drivers.map(d => (
                  <option key={d.key} value={d.key} title={driverShiftDot(d).title}>{driverShiftDot(d).symbol + ' '}{operationalDriverName(d)}</option>
                ))}
              </select>
            </div>

            {/* Buttons */}
            <div className="flex gap-3">
              <button
                onClick={() => { setReassignJob(null); setReassignDriverHash(''); }}
                className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submitReassign}
                disabled={!reassignDriverHash || reassigning}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
              >
                {reassigning ? 'Reassigning...' : 'Reassign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════════
          EDIT DISPATCH MODAL — unified for PW + SW, conditional rendering by jobType
          ═══════════════════════════════════════════════════════════════════════════ */}
      {editSwJob && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-lg w-full mx-4 border border-gray-700 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">
                Edit {editSwJob.jobType === 'service' ? 'Service Work' : 'Dispatch'}
              </h3>
              <button
                onClick={() => setEditSwJob(null)}
                className="text-gray-400 hover:text-white"
              >&#10005;</button>
            </div>

            {/* Job Info Header */}
            <div className="bg-gray-900 rounded-lg p-3 mb-4">
              <div className="flex items-center gap-2 mb-1">
                <JobTypeBadge type={editSwJob.jobType} serviceType={editSwJob.serviceType} />
                <span className="text-white font-medium text-sm">{editSwJob.ndicWellName || editSwJob.wellName}</span>
                {/* Multi-load badge */}
                {(() => {
                  const remaining = (editSwJob.loadCount || 1) - (editSwJob.loadsCompleted || 0);
                  return remaining > 1 ? (
                    <span className="px-1.5 py-0.5 bg-yellow-600/30 text-yellow-300 text-[10px] rounded font-bold">
                      {editSwJob.loadsCompleted || 0}/{editSwJob.loadCount} loads done · {remaining} remaining
                    </span>
                  ) : null;
                })()}
              </div>
              <div className="text-gray-500 text-xs">
                Assigned {formatDispatchTime(editSwJob.assignedAt)} by {editSwJob.assignedBy}
              </div>
            </div>

            {/* ── PW Layout ─────────────────────────────────────────────── */}
            {editSwJob.jobType !== 'service' && (
              <>
                {/* Pickup Well — editable with autocomplete */}
                <div className="mb-4">
                  <label className="block text-sm text-gray-400 mb-1">Pickup Well</label>
                  <div className="relative">
                    <input
                      type="text"
                      value={editSwWellName}
                      onChange={(e) => setEditSwWellName(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                    />
                    {editSwWellName.trim().length >= 2 && editSwWellName.trim() !== (editSwJob.ndicWellName || editSwJob.wellName) && wells.filter(w => (w.ndicName || w.wellName).toLowerCase().includes(editSwWellName.trim().toLowerCase())).length > 0 && (
                      <div className="absolute z-50 w-full mt-1 bg-gray-800 border border-gray-600 rounded max-h-40 overflow-y-auto shadow-lg">
                        {wells
                          .filter(w => (w.ndicName || w.wellName).toLowerCase().includes(editSwWellName.trim().toLowerCase()))
                          .slice(0, 10)
                          .map(w => (
                            <button key={w.wellName} type="button" onClick={() => setEditSwWellName(w.ndicName || w.wellName)}
                              className="wb-option-row px-3 py-1.5 border-b border-gray-700/50 last:border-0 text-white text-sm">
                              {w.ndicName || w.wellName}
                              {w.route && <span className="wb-option-sub text-gray-500 text-xs ml-2">{w.route}</span>}
                            </button>
                          ))
                        }
                      </div>
                    )}
                  </div>
                </div>

                {/* Drop-off / SWD — searchable */}
                <div className="mb-4 relative">
                  <label className="block text-sm text-gray-400 mb-1">Drop-off / SWD</label>
                  <input
                    type="text"
                    value={editPwDisposal}
                    onChange={(e) => {
                      const val = e.target.value;
                      setEditPwDisposal(val);
                      setEditPwDisposalResults(val.length >= 2 ? searchDisposals(val, allDisposals) : []);
                      setEditPwShowDisposalDropdown(val.length >= 2);
                    }}
                    onFocus={() => { if (editPwDisposal.length >= 2) setEditPwShowDisposalDropdown(true); }}
                    onBlur={() => setTimeout(() => setEditPwShowDisposalDropdown(false), 200)}
                    placeholder="Search SWDs..."
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  {editPwShowDisposalDropdown && editPwDisposalResults.length > 0 && (
                    <div className="absolute z-50 top-full left-0 w-full mt-1 bg-gray-900 border border-gray-600 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                      {editPwDisposalResults.map((d, i) => (
                        <button
                          key={`${d.well_name}-${i}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { setEditPwDisposal(d.well_name); setEditPwShowDisposalDropdown(false); }}
                          className="wb-option-row px-3 py-2 text-sm text-white"
                        >
                          <span>{d.well_name}</span>
                          {d.operator && <span className="wb-option-sub text-gray-500 ml-2 text-xs">{d.operator}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Notes */}
                <div className="mb-4">
                  <label className="block text-sm text-gray-400 mb-1">Notes</label>
                  <textarea
                    value={editSwNotes}
                    onChange={(e) => setEditSwNotes(e.target.value)}
                    placeholder="Special instructions..."
                    rows={2}
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
                  />
                </div>

                {/* Driver row — show current + Reassign button */}
                <div className="mb-4 px-3 py-2.5 bg-gray-900 rounded-lg flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-blue-600/40 flex items-center justify-center text-xs font-bold text-blue-300 flex-shrink-0">
                    {(editSwJob.driverFirstName || editSwJob.driverName || '?').charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-white text-sm font-medium">{editSwJob.driverFirstName || editSwJob.driverName}</span>
                    <div className="flex items-center gap-2">
                      <StageBadge job={editSwJob} />
                      {editSwJob.assignedAt && <span className="text-gray-600 text-xs">{timeAgo(editSwJob.assignedAt)}</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => { setEditSwJob(null); openReassignModal(editSwJob); }}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded transition-colors flex-shrink-0"
                  >
                    Reassign
                  </button>
                </div>

                {/* Multi-load: split loads to another driver */}
                {(() => {
                  const remaining = (editSwJob.loadCount || 1) - (editSwJob.loadsCompleted || 0);
                  if (remaining <= 1) return null;
                  return (
                    <div className="mb-4 p-3 rounded-lg border border-yellow-600/30 bg-yellow-950/20">
                      <label className="block text-sm text-yellow-400 font-medium mb-2">Give loads to another driver</label>
                      <div className="flex items-center gap-2">
                        <select
                          value={editPwSplitLoads}
                          onChange={(e) => setEditPwSplitLoads(parseInt(e.target.value))}
                          className="px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-yellow-500"
                        >
                          {Array.from({ length: remaining - 1 }, (_, i) => i + 1).map(n => (
                            <option key={n} value={n}>{n} load{n > 1 ? 's' : ''}</option>
                          ))}
                        </select>
                        <span className="text-gray-500 text-sm">→</span>
                        <select
                          value={editPwSplitDriver}
                          onChange={(e) => setEditPwSplitDriver(e.target.value)}
                          className="flex-1 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-yellow-500"
                        >
                          <option value="">Select driver...</option>
                          {drivers
                            .filter(d => d.key !== editSwJob.driverHash)
                            .map(d => (
                              <option key={d.key} value={d.key} title={driverShiftDot(d).title}>{driverShiftDot(d).symbol + ' '}{operationalDriverName(d)}</option>
                            ))
                          }
                        </select>
                        <button
                          onClick={splitPwLoads}
                          disabled={!editPwSplitDriver || editSwSaving}
                          className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-xs font-medium rounded transition-colors flex-shrink-0"
                        >
                          Split
                        </button>
                      </div>
                      <p className="text-gray-500 text-xs mt-1.5">
                        {remaining - editPwSplitLoads} load{remaining - editPwSplitLoads !== 1 ? 's' : ''} stays with {editSwJob.driverFirstName || editSwJob.driverName}
                      </p>
                    </div>
                  );
                })()}

                {/* Action Buttons */}
                <div className="flex gap-3">
                  <button
                    onClick={() => { if (editSwJob.id && confirm(`Cancel this dispatch for ${editSwJob.ndicWellName || editSwJob.wellName}?`)) { cancelDispatch(editSwJob.id); setEditSwJob(null); } }}
                    className="px-4 py-2 bg-gray-700 hover:bg-red-900/50 text-gray-300 hover:text-red-300 rounded-lg transition-colors text-sm"
                  >
                    Cancel Job
                  </button>
                  <span className="flex-1" />
                  <button
                    onClick={() => setEditSwJob(null)}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
                  >
                    Close
                  </button>
                  <button
                    onClick={saveEditServiceWork}
                    disabled={editSwSaving}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
                  >
                    {editSwSaving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </>
            )}

            {/* ── SW Layout ─────────────────────────────────────────────── */}
            {editSwJob.jobType === 'service' && (
              <>
                {/* Current Crew List */}
                <div className="mb-4">
                  <label className="block text-sm text-gray-400 mb-2">Current Crew ({editSwGroupJobs.length})</label>
                  <div className="space-y-1">
                    {editSwGroupJobs.map(j => (
                      <div key={j.id} className="flex items-center justify-between px-3 py-2 bg-gray-900 rounded">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-purple-600/40 flex items-center justify-center text-[10px] font-bold text-purple-300 flex-shrink-0">
                            {(j.driverFirstName || j.driverName || '?').charAt(0).toUpperCase()}
                          </div>
                          <span className="text-white text-sm">{j.driverFirstName || j.driverName}</span>
                          <StageBadge job={j} />
                          {j.assignedAt && (
                            <span className="text-gray-600 text-xs">{timeAgo(j.assignedAt)}</span>
                          )}
                        </div>
                        {editSwGroupJobs.length > 1 && (
                          <button
                            onClick={() => j.id && cancelSwDriverAssignment(j.id)}
                            className="text-red-400/60 hover:text-red-300 text-xs px-2 py-0.5 rounded hover:bg-red-900/20 transition-colors"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Add Drivers */}
                <div className="mb-4">
                  <label className="block text-sm text-gray-400 mb-2">Add Drivers</label>
                  <div className="bg-gray-900 border border-gray-700 rounded-lg max-h-36 overflow-y-auto">
                    {drivers
                      .filter(d => !editSwAssignedDriverHashes.has(d.key))
                      .map(d => {
                        const checked = editSwAddDriverHashes.has(d.key);
                        return (
                          <button
                            key={d.key}
                            type="button"
                            onClick={() => {
                              setEditSwAddDriverHashes(prev => {
                                const next = new Set(prev);
                                if (next.has(d.key)) next.delete(d.key);
                                else next.add(d.key);
                                return next;
                              });
                            }}
                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left border-b border-gray-800 last:border-0 transition-colors ${
                              checked ? 'bg-purple-900/30 text-white' : 'text-gray-300 hover:bg-gray-800'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              readOnly
                              className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-purple-600 focus:ring-purple-500 focus:ring-offset-0 pointer-events-none"
                            />
                            <span>{d.legalName || d.displayName}</span>
                          </button>
                        );
                      })
                    }
                    {drivers.filter(d => !editSwAssignedDriverHashes.has(d.key)).length === 0 && (
                      <div className="px-3 py-2 text-gray-500 text-sm">All drivers already assigned</div>
                    )}
                  </div>
                  {editSwAddDriverHashes.size > 0 && (
                    <div className="text-purple-400 text-xs mt-1">
                      +{editSwAddDriverHashes.size} driver{editSwAddDriverHashes.size !== 1 ? 's' : ''} will be added
                    </div>
                  )}
                </div>

                {/* Drop-off / SWD */}
                <div className="mb-4 relative">
                  <label className="block text-sm text-gray-400 mb-1">Drop-off (optional)</label>
                  <input
                    type="text"
                    value={editSwDisposal}
                    onChange={(e) => {
                      const val = e.target.value;
                      setEditSwDisposal(val);
                      setEditSwDisposalResults(val.length >= 2 ? searchDisposals(val, allDisposals) : []);
                      setEditSwShowDisposalDropdown(val.length >= 2);
                    }}
                    onFocus={() => { if (editSwDisposal.length >= 2) setEditSwShowDisposalDropdown(true); }}
                    onBlur={() => setTimeout(() => setEditSwShowDisposalDropdown(false), 200)}
                    placeholder="Search SWDs..."
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-purple-500"
                  />
                  {editSwShowDisposalDropdown && editSwDisposalResults.length > 0 && (
                    <div className="absolute z-50 top-full left-0 w-full mt-1 bg-gray-900 border border-gray-600 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                      {editSwDisposalResults.map((d, i) => (
                        <button
                          key={`${d.well_name}-${i}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { setEditSwDisposal(d.well_name); setEditSwShowDisposalDropdown(false); }}
                          className="wb-option-row px-3 py-2 text-sm text-white"
                        >
                          <span>{d.well_name}</span>
                          {d.operator && <span className="wb-option-sub text-gray-500 ml-2 text-xs">{d.operator}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Be Onsite By */}
                <div className="mb-4">
                  <label className="block text-sm text-gray-400 mb-1">Be onsite by</label>
                  <input
                    type="datetime-local"
                    value={editSwOnsiteBy}
                    onChange={(e) => setEditSwOnsiteBy(e.target.value)}
                    max="9999-12-31T23:59"
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
                  />
                </div>

                {/* Edit Notes */}
                <div className="mb-5">
                  <label className="block text-sm text-gray-400 mb-1">Notes / Instructions</label>
                  <textarea
                    value={editSwNotes}
                    onChange={(e) => setEditSwNotes(e.target.value)}
                    placeholder="Special instructions..."
                    rows={2}
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-purple-500 resize-none"
                  />
                </div>

                {/* Action Buttons */}
                <div className="flex gap-3">
                  <button
                    onClick={() => { if (editSwJob?.id && confirm(`Cancel this service work for ${editSwJob.ndicWellName || editSwJob.wellName}?`)) { cancelDispatch(editSwJob.id); setEditSwJob(null); } }}
                    className="px-4 py-2 bg-gray-700 hover:bg-red-900/50 text-gray-300 hover:text-red-300 rounded-lg transition-colors text-sm"
                  >
                    Cancel Job
                  </button>
                  <span className="flex-1" />
                  <button
                    onClick={() => setEditSwJob(null)}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
                  >
                    Close
                  </button>
                  <button
                    onClick={saveEditServiceWork}
                    disabled={editSwSaving}
                    className="flex-1 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
                  >
                    {editSwSaving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-Components ──────────────────────────────────────────────────────────

function PullsPredictionCell({ well }: { well: WellResponse }) {
  const pred = getWellPrediction(well);

  if (pred.pullsPerDay === null) {
    return <span className="text-gray-500 text-sm">--</span>;
  }

  const pullsDisplay = pred.pullsPerDay.toFixed(1);
  const hoursDisplay = pred.hoursPerPull ? `${Math.round(pred.hoursPerPull)}h apart` : '';

  // Color and badge based on driver load
  if (pred.driverLoad === 'critical') {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span className="px-2 py-0.5 bg-red-600 text-white text-xs font-bold rounded animate-pulse">
          {pullsDisplay}/day
        </span>
        <span className="text-red-400 text-[10px]">{hoursDisplay}</span>
      </div>
    );
  }

  if (pred.driverLoad === 'high') {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span className="px-2 py-0.5 bg-orange-600 text-white text-xs font-bold rounded">
          {pullsDisplay}/day
        </span>
        <span className="text-orange-400 text-[10px]">{hoursDisplay}</span>
      </div>
    );
  }

  if (pred.driverLoad === 'normal') {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span className="text-white font-mono text-sm">{pullsDisplay}/day</span>
        <span className="text-gray-500 text-[10px]">{hoursDisplay}</span>
      </div>
    );
  }

  // Low — single pull or less per day
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="text-gray-400 font-mono text-sm">{pullsDisplay}/day</span>
      {pred.hoursPerPull && pred.hoursPerPull < 48 && (
        <span className="text-gray-600 text-[10px]">{hoursDisplay}</span>
      )}
    </div>
  );
}

function ModalPredictionBanner({ well }: { well: WellResponse }) {
  const pred = getWellPrediction(well);

  if (!pred.warning) return null;

  const bgColor = pred.driverLoad === 'critical'
    ? 'bg-red-900/40 border-red-700/50'
    : 'bg-orange-900/40 border-orange-700/50';

  const textColor = pred.driverLoad === 'critical' ? 'text-red-300' : 'text-orange-300';
  const iconColor = pred.driverLoad === 'critical' ? 'text-red-400' : 'text-orange-400';

  return (
    <div className={`${bgColor} border rounded-lg p-3 mb-4`}>
      <div className="flex items-start gap-2">
        <span className={`${iconColor} text-lg`}>&#9888;</span>
        <div className="text-sm">
          <div className={`${textColor} font-medium`}>{pred.warning}</div>
          {pred.hoursPerPull && (
            <div className="text-gray-400 mt-0.5">
              Truck needed every ~{Math.round(pred.hoursPerPull)} hours to prevent overflow
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StageBadge({ job, slot }: { job: DispatchJob; slot?: boolean }) {
  // `slot` renders the categorical stage/status in the standardized Active-Job slot
  // (fixed width/height, centered); without it the original compact pill is used, so
  // shared surfaces (modals, history, crew panels) are unchanged.
  const Pill = ({ className, title, children }: { className: string; title?: string; children: ReactNode }) =>
    slot ? (
      <CategoryBadge className={className} title={title}>{children}</CategoryBadge>
    ) : (
      <span className={`px-2 py-0.5 text-xs font-medium rounded whitespace-nowrap ${className}`} title={title}>{children}</span>
    );
  const stageConfig: Record<string, { bg: string; text: string; icon: string; label: string }> = {
    en_route_pickup:  { bg: 'bg-blue-600/30',    text: 'text-blue-300',    icon: '>', label: 'To Pickup' },
    on_site_pickup:   { bg: 'bg-emerald-600/30',  text: 'text-emerald-300', icon: '*', label: 'At Pickup' },
    en_route_dropoff: { bg: 'bg-indigo-600/30',   text: 'text-indigo-300',  icon: '>', label: 'To Drop-off' },
    on_site_dropoff:  { bg: 'bg-teal-600/30',     text: 'text-teal-300',    icon: '#', label: 'At Drop-off' },
    paused:           { bg: 'bg-amber-600/30',     text: 'text-amber-300',   icon: '||', label: 'Paused' },
    completed:        { bg: 'bg-green-600/30',     text: 'text-green-300',   icon: 'ok', label: 'Done' },
  };

  const statusFallback: Record<string, { bg: string; text: string; label: string }> = {
    pending:           { bg: 'bg-yellow-600/30',  text: 'text-yellow-300', label: 'Pending' },
    pending_approval:  { bg: 'bg-orange-600/30',  text: 'text-orange-300', label: 'Needs Approval' },
    accepted:          { bg: 'bg-blue-600/30',    text: 'text-blue-300',   label: 'Accepted' },
    declined:          { bg: 'bg-red-600/30',     text: 'text-red-300',    label: 'Declined' },
    in_progress:       { bg: 'bg-purple-600/30',  text: 'text-purple-300', label: 'In Progress' },
    paused:            { bg: 'bg-amber-600/30',   text: 'text-amber-300',  label: 'Paused' },
  };

  // Use driver stage if available, otherwise fall back to dispatch status
  if (job.driverStage && stageConfig[job.driverStage]) {
    const cfg = stageConfig[job.driverStage];
    const dest = job.driverDest;
    return (
      <div className="flex items-center gap-1.5">
        {/* Categorical stage → standardized slot (when in an Active Job row). */}
        <Pill className={`${cfg.bg} ${cfg.text}`}>
          {cfg.label}
        </Pill>
        {/* Destination is informational, not categorical → separate truncated chip. */}
        {dest && (job.driverStage === 'en_route_pickup' || job.driverStage === 'en_route_dropoff') && (
          <span className="text-gray-500 text-xs truncate max-w-[140px]" title={dest}>{dest}</span>
        )}
      </div>
    );
  }

  const fb = statusFallback[job.status] || statusFallback.pending;
  const pendingAge = job.status === 'pending' ? timeAgo(job.assignedAt) : '';
  return (
    <Pill
      className={`${fb.bg} ${fb.text} ${job.status === 'pending_approval' ? 'animate-pulse' : ''}`}
      title={pendingAge ? `Pending for ${pendingAge} since assignment` : undefined}
    >
      {fb.label}{pendingAge ? ` · ${pendingAge}` : ''}
    </Pill>
  );
}

// Fixed-size categorical badge slot — ONE reusable treatment so every categorical
// pill in an Active Job row (PW/SW, load count, Ticket A/B, ★ Next, ⚠ DOWN, Heavy,
// Driver Started, Pending·age, and stage/status) shares an IDENTICAL width and
// height with centered content. A short label such as "PW" intentionally sits
// centered with empty slack inside the standardized slot. Long INFORMATIONAL text
// (transfer reason, driver name, stage destination) is not a category — it stays a
// separately constrained/truncated info chip and must NOT use this slot.
// w-[6.5rem] (104px) is a FIXED width — not a minimum — so every categorical badge
// is exactly the same size regardless of label length; short labels ("PW") center
// with empty slack, as requested. The width is sized to the widest categorical label
// the row can show (measured against the app font at 10px bold: "Needs Approval"
// ~89px, "Driver Started" ~79px, "Pending · 12h" ~78px, transient "Pending · just
// now" ~101px — all within the 104px box). h-5 fixes the height, text is centered,
// and whitespace-nowrap guarantees no wrap/clip.
const CATEGORY_BADGE_SLOT =
  'inline-flex items-center justify-center text-center h-5 w-[6.5rem] px-1.5 text-[10px] font-bold leading-none rounded whitespace-nowrap flex-shrink-0';
function CategoryBadge({ className = '', title, children }: { className?: string; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={`${CATEGORY_BADGE_SLOT} ${className}`}>
      {children}
    </span>
  );
}

// Job-type badge — its OWN compact identity group (~40x20), centered, ONE small
// shared size. Every job type renders as a canonical two-letter acronym (PW/SW/…);
// the full job-type name (and any service sub-type) is preserved in the tooltip /
// aria-label. This is deliberately NOT the larger 104px categorical slot — that slot
// stays for Next / DOWN / Heavy / Driver Started / stage-status badges.
const JOB_TYPE_BADGE_SLOT =
  'inline-flex items-center justify-center text-center w-10 h-5 text-[10px] font-bold leading-none rounded uppercase tracking-wider flex-shrink-0';
function JobTypeBadge({ type, serviceType }: { type: string; serviceType?: string }) {
  const { code, full } = jobTypeAcronym(type);
  const color =
    code === 'SW' ? 'bg-purple-600/30 text-purple-300'
    : code === 'PW' ? 'bg-blue-600/30 text-blue-300'
    : 'bg-slate-600/40 text-slate-200';
  const title = serviceType ? `${full} · ${serviceType}` : full;
  return (
    <span className={`${JOB_TYPE_BADGE_SLOT} ${color}`} title={title} aria-label={title}>
      {code}
    </span>
  );
}

// Single job row — shows all info a dispatcher needs
function DispatchJobRow({ job, cancelDispatch, compact, onClickServiceWork, onReassign, onDismiss, isRecommendedNext, isWellDown }: {
  job: DispatchJob;
  cancelDispatch: (id: string) => void;
  compact?: boolean;
  onClickServiceWork?: (job: DispatchJob) => void;
  onReassign?: (job: DispatchJob) => void;
  onDismiss?: (job: DispatchJob) => void;
  /** Marks the existing card as the Recommended next job (never a duplicate card). */
  isRecommendedNext?: boolean;
  /** Canonical live well state is DOWN — show a prominent warning; the job stays actionable. */
  isWellDown?: boolean;
}) {
  const dropoff = job.hauledTo || job.disposal;
  const isClickable = !!onClickServiceWork;

  // Split ticket visual — light tint so linked jobs stand out
  const splitBg = job.splitGroupId
    ? job.splitSequence === 1
      ? 'bg-purple-900/40 border-l-3 border-l-purple-400'
      : 'bg-purple-900/30 border-l-3 border-l-purple-400/60'
    : 'bg-gray-900/50';

  return (
    <div
      className={`${compact ? 'py-2 px-3' : 'py-3 px-4'} ${splitBg} rounded-lg hover:bg-gray-900/80 transition-colors ${isClickable ? 'cursor-pointer' : ''}`}
      onClick={isClickable ? () => onClickServiceWork!(job) : undefined}
    >
      <div className="flex items-center gap-2">
        {/* Identity: type, well, quantity, and linked-ticket facts always stay together. */}
        <div className="flex items-center gap-2 min-w-0">
          <JobTypeBadge type={job.jobType} serviceType={job.serviceType} />
          <span className="text-white font-medium text-sm truncate" style={{ minWidth: 100 }}>
            {job.ndicWellName || job.wellName}
          </span>
          {(() => {
            const remaining = (job.loadCount || 1) - (job.loadsCompleted || 0);
            return remaining > 1 ? (
              <CategoryBadge className="bg-yellow-600/30 text-yellow-300">
                x{remaining}
              </CategoryBadge>
            ) : null;
          })()}
          {job.splitGroupId && (
            <CategoryBadge className="bg-purple-600/30 text-purple-300">
              {job.splitSequence === 1 ? 'TICKET A' : job.splitSequence === 2 ? 'TICKET B' : `TICKET ${String.fromCharCode(64 + (job.splitSequence || 1))}`}
            </CategoryBadge>
          )}
        </div>

        <span className="flex-1" />

        {/* Operational flags: recommendations, warnings, and special handling. */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {isRecommendedNext && (
            <CategoryBadge
              className="bg-emerald-600/30 text-emerald-300"
              title="Recommended next job (first physically-ready assigned job)"
            >
              ★ Next
            </CategoryBadge>
          )}
          {isWellDown && (
            <CategoryBadge
              className="bg-red-600 text-white"
              title="Canonical well state is DOWN — job remains actionable (may still hold pullable water)"
            >
              ⚠ DOWN
            </CategoryBadge>
          )}
          {(job as any).isHeavyWater && (
            <CategoryBadge className="bg-amber-600/30 text-amber-300">
              HEAVY
            </CategoryBadge>
          )}
          {/* Informational (not categorical): driver name / transfer reason stay as
              separately constrained, truncated chips — never forced into the slot. */}
          {job.type === 'transfer' && job.transferFromDriver && (
            <span className="px-1.5 py-0.5 bg-orange-600/30 text-orange-300 text-[10px] rounded font-medium whitespace-nowrap max-w-[160px] truncate flex-shrink-0" title={`from ${job.transferFromDriver}`}>
              from {job.transferFromDriver}
            </span>
          )}
          {job.type === 'transfer' && job.transferReason && (
            <span
              className="px-1.5 py-0.5 bg-amber-700/30 text-amber-200 text-[10px] rounded font-medium max-w-[220px] truncate flex-shrink-0"
              title={job.transferReason}
            >
              Reason: {job.transferReason}
            </span>
          )}
        </div>

        {/* Job state: origin/progress followed by the current stage and its age. */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {job.source === 'driver' && (
            <CategoryBadge className="bg-emerald-600/30 text-emerald-300">
              Driver Started
            </CategoryBadge>
          )}
          <StageBadge job={job} slot />
        </div>

        {/* Controls always remain the final group. */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {isClickable && (
            <span className="text-gray-500 hover:text-gray-300 text-xs" title="Edit dispatch">
              &#9998;
            </span>
          )}
          {onReassign && (job.status === 'pending' || job.status === 'accepted') && (
            <button
              onClick={(e) => { e.stopPropagation(); onReassign(job); }}
              className="text-blue-400/60 hover:text-blue-300 text-xs transition-colors"
              title="Reassign to another driver"
            >👯</button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!job.id) return;
              if (!onDismiss) {
                window.alert('Dismiss is not wired. This is a control failure, not an empty action.');
                return;
              }
              onDismiss(job);
            }}
            className="text-red-400/60 hover:text-red-300 text-xs transition-colors p-1"
            title="Remove dispatch"
            aria-label={`Remove dispatch for ${job.ndicWellName || job.wellName}`}
          >&#10005;</button>
        </div>
      </div>

      {/* Detail row — invoice #, drop-off, notes */}
      {(job.invoiceNumber || job.ticketNumber || dropoff || job.notes) && (
        <div className="flex items-center gap-3 mt-1.5 ml-[42px] text-xs">
          {(job.invoiceNumber || job.ticketNumber) && (
            <span className="text-gray-400">
              <span className="text-gray-600">#</span>{job.invoiceNumber || job.ticketNumber}
            </span>
          )}
          {dropoff && (
            <span className="text-cyan-400/70 truncate max-w-[200px]" title={dropoff}>
              → {dropoff}
            </span>
          )}
          {job.notes && (
            <span className="text-gray-500 truncate max-w-[200px] italic" title={job.notes}>
              {job.notes}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Driver-centric active dispatch panel — groups ALL jobs by driver
// Multi-driver SW jobs shown separately at bottom with all crew visible
function ActiveDispatchPanel({ dispatches, cancelDispatch, drivers, assignTransfer, onEditServiceWork, onReassignDeclined, onDismissDeclined, activeJobsReady = true, wells, nowMs }: {
  dispatches: DispatchJob[];
  cancelDispatch: (id: string) => void;
  drivers?: { key: string; driverId?: string; legacyAliases?: string[]; companyId?: string; displayName: string; legalName?: string; assignedRoutes?: string[] }[];
  assignTransfer?: (jobId: string, driverHash: string, driverName: string) => void;
  onEditServiceWork?: (job: DispatchJob) => void;
  onReassignDeclined?: (job: DispatchJob) => void;
  onDismissDeclined?: (jobId: string) => Promise<void> | void;
  /** True once auth/company resolved AND the first real Active Jobs dataset loaded. */
  activeJobsReady?: boolean;
  /** Canonical well pool + shared clock — for the SAME physical-readiness order + live DOWN state as the Well Queue. */
  wells?: WellResponse[];
  nowMs?: number;
}) {
  // Expanded driver groups persist across refresh — session-scoped by uid+companyId+
  // pathname, keyed by the canonical group id the Active Jobs render groups on
  // (dispatchDriverGroupKey — canonical driverId), never a display name or list index.
  const { user: expandedUser } = useAuth();
  const expandedPathname = usePathname();
  const expandedScope = useMemo(
    () => ({ uid: expandedUser?.uid ?? null, companyId: expandedUser?.companyId ?? null, pathname: expandedPathname }),
    [expandedUser?.uid, expandedUser?.companyId, expandedPathname],
  );
  const [expandedList, setExpandedList] = useSessionDeepLinkState<string[]>(
    expandedScope,
    'activeJobs.expandedDrivers',
    [],
  );
  const expandedDrivers = useMemo(() => new Set(expandedList), [expandedList]);
  const [confirmDismissJob, setConfirmDismissJob] = useState<DispatchJob | null>(null);
  const [dismissSubmitting, setDismissSubmitting] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);

  async function handleExecuteDismiss() {
    if (!confirmDismissJob?.id) return;
    setDismissSubmitting(true);
    setDismissError(null);
    try {
      if (onDismissDeclined) {
        await onDismissDeclined(confirmDismissJob.id);
      }
      setConfirmDismissJob(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Dismiss failed';
      setDismissError(msg.replace(/^FirebaseError:\s*/i, ''));
    } finally {
      setDismissSubmitting(false);
    }
  }

  // Separate declined/cancelled jobs from active (completed filtered out before passing to this component)
  const declinedJobs = dispatches.filter(d => d.status === 'declined' || d.status === 'cancelled');
  const nonDeclined = dispatches.filter(d => d.status !== 'declined' && d.status !== 'cancelled');

  // Unassigned transfers need driver assignment
  const unassigned = nonDeclined.filter(d => d.type === 'transfer' && (!d.driverHash || d.status === 'pending_approval'));
  const assigned = nonDeclined.filter(d => !(d.type === 'transfer' && (!d.driverHash || d.status === 'pending_approval')));

  // Identify multi-driver SW groups (serviceGroupId with 2+ dispatches)
  // These appear in BOTH the driver's individual list AND the Crew Jobs section
  const crewGroups = useMemo(() => {
    const groupMap = new Map<string, DispatchJob[]>();

    assigned.forEach(d => {
      if (d.serviceGroupId) {
        if (!groupMap.has(d.serviceGroupId)) groupMap.set(d.serviceGroupId, []);
        groupMap.get(d.serviceGroupId)!.push(d);
      }
    });

    const crews: DispatchJob[][] = [];
    groupMap.forEach((jobs) => {
      if (jobs.length >= 2) crews.push(jobs);
    });

    return crews;
  }, [assigned]);

  // ONE canonical live-priority source: rank every well by the SAME comparator the Well
  // Queue uses (compareQueueRows over classifyWell at the SAME nowMs), so Active Jobs and
  // the Well Queue consume identical readiness. A job joins its well via matchWellInPool
  // (canonical NDIC identity, NOT display-name equality) — never a stale dispatch snapshot.
  const rankNowMs = nowMs ?? Date.now();
  const physicalWellRank = useMemo(() => buildWellQueueRankIndex(wells || [], rankNowMs), [wells, rankNowMs]);
  const rankOf = useCallback(
    (j: DispatchJob): PhysicalJobRankInput =>
      rankJob(
        { id: j.id, wellName: j.wellName, ndicWellName: j.ndicWellName, status: j.status, driverStage: j.driverStage, assignedAtMs: j.assignedAt?.toMillis?.() || 0 },
        wells || [],
        physicalWellRank,
        rankNowMs,
      ),
    [wells, physicalWellRank, rankNowMs],
  );

  // Group ALL jobs by driver — every dispatch shows in the driver's personal list
  // (multi-driver SW jobs also appear in Crew Jobs section for at-a-glance crew view)
  const grouped = useMemo(() => {
    const map = new Map<string, DispatchJob[]>();
    assigned.forEach(d => {
      // Group by the CANONICAL driver identity (driverId preferred; governed legacy-hash
      // fallback) so a driver's jobs consolidate even when driverHash is stale/legacy.
      const key = dispatchDriverGroupKey(d, drivers || []);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(d);
    });
    // Sort each driver's jobs by the SHARED physical-readiness contract, so the assigned
    // subset matches the Well Queue: in-progress pinned, then by the well's Well-Queue
    // rank, deterministic ties. Assignment status never alters physical priority.
    map.forEach((jobs, key) => {
      const rankById = new Map(jobs.map(jb => [jb.id, rankOf(jb)]));
      const ordered = [...jobs].sort((a, b) => comparePhysicalJobs(rankById.get(a.id)!, rankById.get(b.id)!));
      map.set(key, ordered);
    });
    return new Map(
      Array.from(map.entries()).sort(([, a], [, b]) => {
        const aActive = a.filter(j => j.status !== 'pending').length;
        const bActive = b.filter(j => j.status !== 'pending').length;
        return bActive - aActive;
      })
    );
  }, [assigned, drivers, rankOf]);

  // Recommended-next per driver group: first non-in-progress job in physical order (DOWN
  // is NOT categorically excluded — a DOWN well may hold pullable water — it just sorts to
  // the DOWN tier, so a ready well wins first). Marks an existing card; never a duplicate.
  const recommendedByGroup = useMemo(() => {
    const m = new Map<string, string | null>();
    grouped.forEach((jobs, key) => m.set(key, recommendedNextJobId(jobs.map(rankOf))));
    return m;
  }, [grouped, rankOf]);

  // Live canonical DOWN state per job (joined via matchWellInPool, not a stale snapshot).
  const downByJobId = useMemo(() => {
    const s = new Set<string>();
    grouped.forEach(jobs => jobs.forEach(j => { if (rankOf(j).down && j.id) s.add(j.id); }));
    return s;
  }, [grouped, rankOf]);

  // Prune stored expanded groups to the live canonical group set — but ONLY once
  // the dataset is ready (auth/company resolved + first real Active Jobs dataset +
  // canonical group keys available). While loading, hold the restored set verbatim
  // so a still-empty live set never collapses Mike's restored group or persists [].
  useEffect(() => {
    if (!activeJobsReady) return;
    const liveKeys = new Set(grouped.keys());
    const { next, changed } = pruneExpandedGroups(expandedList, liveKeys, true);
    if (changed) setExpandedList(next);
    // expandedList intentionally omitted from deps — this reconciles against the
    // live group set when data/readiness change, not on every expand/collapse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobsReady, grouped]);

  function toggleDriver(hash: string) {
    setExpandedList(prev => (prev.includes(hash) ? prev.filter(h => h !== hash) : [...prev, hash]));
  }

  if (dispatches.length === 0) {
    return <div className="text-center text-gray-500 py-8">No active dispatches</div>;
  }

  return (
    <div className="space-y-3">
      {/* Declined jobs — need dispatcher attention */}
      {declinedJobs.length > 0 && (
        <>
          <div className="flex items-center gap-2">
            <div className="h-px bg-red-600/30 flex-1" />
            <span className="text-red-400 text-[10px] font-bold uppercase tracking-wider flex-shrink-0">Declined ({declinedJobs.length})</span>
            <div className="h-px bg-red-600/30 flex-1" />
          </div>
          {declinedJobs.map(job => (
            <div key={job.id} className="border border-red-600/30 rounded-lg overflow-hidden bg-red-950/20">
              <div className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <JobTypeBadge type={job.jobType} serviceType={job.serviceType} />
                  <span className="text-white font-medium text-sm truncate">{job.ndicWellName || job.wellName}</span>
                  {(() => {
                    const remaining = (job.loadCount || 1) - (job.loadsCompleted || 0);
                    return remaining > 1 ? (
                      <span className="px-1.5 py-0.5 bg-yellow-600/30 text-yellow-300 text-[10px] rounded font-bold flex-shrink-0">x{remaining}</span>
                    ) : null;
                  })()}
                  <span className="px-2 py-0.5 bg-red-600/30 text-red-300 text-[10px] font-bold rounded">{job.status === 'cancelled' ? 'CANCELLED' : 'DECLINED'}</span>
                  <span className="flex-1" />
                  <button
                    onClick={() => onReassignDeclined?.(job)}
                    className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded transition-colors"
                  >Reassign</button>
                  <button
                    onClick={() => {
                      setConfirmDismissJob(job);
                      setDismissError(null);
                    }}
                    className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium rounded transition-colors"
                    title="Accept decline and dismiss"
                  >Dismiss</button>
                </div>
                {/* Decline details */}
                <div className="mt-2 ml-[42px] space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-red-400/80 font-medium">
                      {job.declinedBy || job.driverFirstName || job.driverName}
                    </span>
                    {job.declinedAt && (
                      <span className="text-gray-600">{timeAgo(job.declinedAt)}</span>
                    )}
                  </div>
                  {job.declineReason && (
                    <div className="text-gray-400 text-xs italic">&ldquo;{job.declineReason}&rdquo;</div>
                  )}
                  {(job.invoiceNumber || job.ticketNumber) && (
                    <span className="text-gray-400 text-xs"><span className="text-gray-600">#</span>{job.invoiceNumber || job.ticketNumber}</span>
                  )}
                  {job.disposal && (
                    <span className="text-cyan-400/70 text-xs">→ {job.disposal}</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {/* Unassigned transfers — urgent, pulsing */}
      {unassigned.map(job => (
        <UnassignedTransferRow key={job.id} job={job} drivers={drivers || []} assignTransfer={assignTransfer} cancelDispatch={cancelDispatch} />
      ))}

      {/* Driver cards (solo jobs + single-driver SW) */}
      {Array.from(grouped.entries()).map(([driverHash, jobs]) => {
        const isExpanded = expandedDrivers.has(driverHash);
        // Resolve by canonical driverId (legacy-hash fallback), NOT driverHash===key, and
        // show the driver's REAL profile name — never the login/stamped name.
        const driverRecord = resolveDispatchDriver(jobs[0], drivers || []);
        const driverName = dispatchDriverDisplayName(jobs[0], drivers || []);
        const pwCount = jobs.filter(j => j.jobType === 'pw').reduce((s, j) => s + ((j as any).loadCount || 1), 0);
        const swCount = jobs.filter(j => j.jobType === 'service').reduce((s, j) => s + ((j as any).loadCount || 1), 0);

        const activeJob = jobs.find(j => j.driverStage && !['completed', 'paused'].includes(j.driverStage));
        const isPaused = jobs.some(j => j.driverStage === 'paused' || j.status === 'paused');
        const allPending = jobs.every(j => j.status === 'pending');

        return (
          <div key={driverHash} className="border border-gray-700/50 rounded-lg overflow-hidden">
            <button
              onClick={() => toggleDriver(driverHash)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                allPending ? 'bg-gray-800/50' : 'bg-gray-800'
              } hover:bg-gray-750 cursor-pointer`}
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                activeJob ? 'bg-blue-600 text-white' : isPaused ? 'bg-amber-600 text-white' : allPending ? 'bg-gray-600 text-gray-300' : 'bg-gray-600 text-white'
              }`}>
                {driverName.charAt(0).toUpperCase()}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-white font-semibold text-sm">{driverName}</span>
                  {pwCount > 0 && (
                    <span className="px-1.5 py-0.5 bg-blue-600/20 text-blue-400 text-[10px] rounded font-bold">{pwCount} {jobTypeCode('pw')}</span>
                  )}
                  {swCount > 0 && (
                    <span className="px-1.5 py-0.5 bg-purple-600/20 text-purple-400 text-[10px] rounded font-bold">{swCount} {jobTypeCode('service')}</span>
                  )}
                </div>
                {/* Active job detail line — shows what the driver is currently doing */}
                {!isExpanded && activeJob && (
                  <div className="flex items-center gap-1.5 mt-0.5 text-xs">
                    <span className="text-white font-medium truncate">{activeJob.ndicWellName || activeJob.wellName}</span>
                    {(activeJob.hauledTo || activeJob.disposal || activeJob.disposalName) && (
                      <>
                        <span className="text-gray-600">→</span>
                        <span className="text-gray-400 truncate">{activeJob.hauledTo || activeJob.disposal || activeJob.disposalName}</span>
                      </>
                    )}
                    <div className="flex-shrink-0 ml-auto"><StageBadge job={activeJob} /></div>
                  </div>
                )}
                {!isExpanded && !activeJob && jobs.length >= 1 && (
                  <div className="text-gray-500 text-xs mt-0.5 truncate">
                    {jobs.map(j => j.ndicWellName || j.wellName).join(' · ')}
                  </div>
                )}
                {!isExpanded && activeJob && jobs.length > 1 && (
                  <div className="text-gray-500 text-[10px] mt-0.5 truncate">
                    {jobs.filter(j => j.id !== activeJob.id).map(j => j.ndicWellName || j.wellName).join(' · ')}
                  </div>
                )}
              </div>

              {/* Stage badge only shows standalone when no active job line (pending/paused drivers) */}
              {activeJob && isExpanded && <StageBadge job={activeJob} />}
              <span className="text-gray-500 text-xs flex-shrink-0">{isExpanded ? '▲' : '▼'}</span>
            </button>

            {isExpanded && (
              <div className="space-y-1 p-2 bg-gray-900/30">
                {jobs.map(job => (
                  <DispatchJobRow
                    key={job.id}
                    job={job}
                    cancelDispatch={cancelDispatch}
                    compact={jobs.length > 2}
                    onClickServiceWork={onEditServiceWork}
                    onReassign={onReassignDeclined}
                    isRecommendedNext={recommendedByGroup.get(driverHash) === job.id}
                    isWellDown={!!job.id && downByJobId.has(job.id)}
                    onDismiss={(j) => {
                      setConfirmDismissJob(j);
                      setDismissError(null);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* ─── Multi-Driver Crew Jobs ─── */}
      {crewGroups.length > 0 && (
        <>
          <div className="flex items-center gap-2 pt-2">
            <div className="h-px bg-purple-600/30 flex-1" />
            <span className="text-purple-400 text-[10px] font-bold uppercase tracking-wider flex-shrink-0">Crew Jobs</span>
            <div className="h-px bg-purple-600/30 flex-1" />
          </div>

          {crewGroups.map((crewJobs, groupIdx) => {
            const firstJob = crewJobs[0];
            const wellName = firstJob.ndicWellName || firstJob.wellName;
            const serviceType = firstJob.serviceType || 'Service Work';
            const notes = firstJob.notes;
            const ago = timeAgo(firstJob.assignedAt);

            return (
              <div
                key={firstJob.serviceGroupId || `crew-${groupIdx}`}
                className="border border-purple-600/30 rounded-lg overflow-hidden bg-gray-800/50 cursor-pointer hover:bg-gray-800 transition-colors"
                onClick={() => onEditServiceWork?.(firstJob)}
              >
                {/* Job header */}
                <div className="px-4 py-2.5 border-b border-gray-700/50">
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 bg-purple-600/30 text-purple-300 text-[10px] font-bold rounded uppercase tracking-wider flex-shrink-0">
                      SW · {serviceType}
                    </span>
                    <span className="text-white font-medium text-sm truncate">{wellName}</span>
                    {ago && <span className="text-gray-600 text-[10px] flex-shrink-0">{ago}</span>}
                    <span className="flex-1" />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Cancel entire crew job at ${wellName}? This will cancel all ${crewJobs.length} dispatches.`)) {
                          crewJobs.forEach(j => { if (j.id) cancelDispatch(j.id); });
                        }
                      }}
                      className="text-red-400/50 hover:text-red-300 text-xs font-medium flex-shrink-0 transition-colors px-2 py-0.5 rounded hover:bg-red-400/10"
                      title="Cancel entire crew job"
                    >Cancel Job</button>
                    <span className="text-purple-400/60 text-xs flex-shrink-0 ml-1" title="Edit crew">&#9998;</span>
                  </div>
                  {notes && (
                    <div className="text-gray-500 text-xs mt-1 italic truncate">{notes}</div>
                  )}
                </div>

                {/* Crew list — each driver with their stage */}
                <div className="px-4 py-2 space-y-1.5">
                  {crewJobs.map(j => (
                    <div key={j.id} className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-purple-600/30 flex items-center justify-center text-[10px] font-bold text-purple-300 flex-shrink-0">
                        {(j.driverFirstName || j.driverName || '?').charAt(0).toUpperCase()}
                      </div>
                      <span className="text-white text-xs font-medium">{j.driverFirstName || j.driverName}</span>
                      <StageBadge job={j} />
                      {j.invoiceNumber && (
                        <span className="text-gray-500 text-[10px]">#{j.invoiceNumber}</span>
                      )}
                      <span className="flex-1" />
                      <button
                        onClick={(e) => { e.stopPropagation(); j.id && cancelDispatch(j.id); }}
                        className="text-red-400/40 hover:text-red-300 text-[10px] flex-shrink-0 transition-colors"
                        title="Remove from crew"
                      >✕</button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* Remove / Dismiss Confirmation Modal */}
      {confirmDismissJob && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={(e) => e.stopPropagation()}>
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full border border-gray-700 shadow-xl text-white">
            <h3 className="text-lg font-semibold text-white mb-2">Remove Dispatch</h3>
            <p className="text-gray-300 text-sm mb-3">
              Are you sure you want to remove this dispatch? This will dismiss the dispatch record from active operations.
            </p>
            <div className="bg-gray-900/60 border border-gray-700/60 rounded p-3 mb-4 space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Well:</span>
                <span className="text-white font-medium">{confirmDismissJob.ndicWellName || confirmDismissJob.wellName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Driver:</span>
                <span className="text-white">{dispatchDriverDisplayName(confirmDismissJob, drivers || []) || confirmDismissJob.driverName || 'Unassigned'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Status:</span>
                <span className="text-gray-200 capitalize">{confirmDismissJob.status.replace('_', ' ')}</span>
              </div>
              {(confirmDismissJob.invoiceNumber || confirmDismissJob.ticketNumber) && (
                <div className="flex items-center justify-between">
                  <span className="text-gray-400">Ticket/Invoice:</span>
                  <span className="text-gray-200">{confirmDismissJob.invoiceNumber || confirmDismissJob.ticketNumber}</span>
                </div>
              )}
            </div>

            {dismissError && (
              <div className="mb-4 p-2.5 rounded bg-red-900/50 border border-red-700 text-red-200 text-xs">
                Removal failed: {dismissError}
              </div>
            )}

            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                disabled={dismissSubmitting}
                onClick={() => {
                  setConfirmDismissJob(null);
                  setDismissError(null);
                }}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs font-medium rounded transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={dismissSubmitting}
                onClick={handleExecuteDismiss}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {dismissSubmitting ? 'Removing...' : 'Remove Dispatch'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Completed Jobs Panel (own tab) ──────────────────────────────────────────

function CompletedJobsPanel({ jobs, drivers, allWells, allDisposals, highlightJobId, onHighlightClear, authenticatedCompanyId, updateCompletedJob }: {
  jobs: DispatchJob[];
  drivers?: { key: string; displayName: string; legalName?: string }[];
  allWells?: NdicWell[];
  allDisposals?: NdicWell[];
  highlightJobId?: string | null;
  onHighlightClear?: () => void;
  authenticatedCompanyId?: string | null;
  // Capability-guarded update supplied by the parent (blocks view-only users).
  updateCompletedJob: (dispatchId: string, record: Record<string, unknown>) => Promise<void>;
}) {
  const [driverFilter, setDriverFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dateRange, setDateRange] = useState<'today' | '7d' | '30d' | 'custom' | 'all'>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [wellResults, setWellResults] = useState<NdicWell[]>([]);
  const [disposalResults, setDisposalResults] = useState<NdicWell[]>([]);
  const [showWellDropdown, setShowWellDropdown] = useState(false);
  const [showDisposalDropdown, setShowDisposalDropdown] = useState(false);
  const [ticketDetailJobId, setTicketDetailJobId] = useState<string | null>(null);

  // Auto-expand highlighted job from notification deep link
  useEffect(() => {
    if (highlightJobId && jobs.some(j => j.id === highlightJobId)) {
      setExpandedJobId(highlightJobId);
      setDateRange('all'); // Ensure the job is visible regardless of date filter
      // Clear highlight after 5 seconds
      const timer = setTimeout(() => onHighlightClear?.(), 5000);
      return () => clearTimeout(timer);
    }
  }, [highlightJobId, jobs]);
  const [ticketDetailData, setTicketDetailData] = useState<any>(null);
  const [ticketDetailLoading, setTicketDetailLoading] = useState(false);

  // Fetch invoice/ticket data from Firestore for inline viewing.
  // Durable invoiceDocId / ticketDocId first; human numbers only with companyId.
  async function loadTicketDetail(identifier: string, jobId: string, invoiceDocId?: string) {
    if (ticketDetailJobId === jobId) { setTicketDetailJobId(null); return; } // toggle off
    setTicketDetailJobId(jobId);
    setTicketDetailLoading(true);
    try {
      const { collection, query, where, getDocs, doc, getDoc } = await import('firebase/firestore');
      const { getFirestoreDb } = await import('@/lib/firebase');
      const db = getFirestoreDb();
      const job = jobs.find((j) => j.id === jobId);
      const companyId = scopeCompanyId({
        authenticatedCompanyId: authenticatedCompanyId || null,
        jobCompanyId: job?.companyId,
      });
      const plan = planInvoiceLookup({
        invoiceDocId,
        invoiceNumber: identifier,
        companyId,
      });
      if (plan.kind === 'refuse_unscoped') {
        setTicketDetailData(null);
        return;
      }

      let inv: any = null;
      if (plan.kind === 'by_doc_id') {
        const docSnap = await getDoc(doc(db, 'invoices', plan.invoiceDocId));
        if (docSnap.exists() && invoiceBelongsToCompany(docSnap.data(), plan.companyId)) {
          inv = docSnap.data();
        }
      }
      if (!inv && plan.kind === 'by_company_and_number') {
        const q = query(
          collection(db, 'invoices'),
          where('companyId', '==', plan.companyId),
          where('invoiceNumber', '==', plan.invoiceNumber),
        );
        const snap = await getDocs(q);
        const owned = snap.docs.filter((d) => invoiceBelongsToCompany(d.data(), plan.companyId));
        if (owned.length === 1) inv = owned[0].data();
      }

      if (inv) {
        const ticketPlan = planTicketFetch({
          companyId: plan.companyId,
          ticketSummaries: Array.isArray(inv.ticketSummaries) ? inv.ticketSummaries : [],
          ticketNumbers: Array.isArray(inv.tickets) ? inv.tickets : [],
        });
        const tickets: any[] = [];
        if (ticketPlan.kind === 'by_doc_ids') {
          for (const id of ticketPlan.ticketDocIds.slice(0, 10)) {
            const snap = await getDoc(doc(db, 'tickets', id));
            if (snap.exists()) tickets.push({ id: snap.id, ...snap.data() });
          }
        } else if (ticketPlan.kind === 'by_company_and_numbers') {
          const tq = query(
            collection(db, 'tickets'),
            where('companyId', '==', ticketPlan.companyId),
            where('ticketNumber', 'in', ticketPlan.ticketNumbers.slice(0, 10)),
          );
          const tsnap = await getDocs(tq);
          tsnap.forEach((d) => tickets.push({ id: d.id, ...d.data() }));
        }
        setTicketDetailData({
          invoice: inv,
          tickets: filterTicketsForCompany(tickets, plan.companyId),
        });
      } else {
        setTicketDetailData(null);
      }
    } catch (err) {
      console.error('[CompletedJobs] Failed to fetch ticket detail:', err);
      setTicketDetailData(null);
    } finally {
      setTicketDetailLoading(false);
    }
  }

  function startEdit(job: DispatchJob) {
    const completed = toDate(job.completedAt);
    const assigned = toDate(job.assignedAt);
    setEditingJobId(job.id || null);
    setEditForm({
      wellName: job.ndicWellName || job.wellName || '',
      disposal: job.hauledTo || job.disposal || job.disposalName || '',
      totalBBL: String(job.totalBBL || ''),
      notes: job.notes || '',
      operator: job.operator || '',
      invoiceNumber: job.invoiceNumber || '',
      date: completed ? completed.toISOString().split('T')[0] : '',
      startTime: assigned ? assigned.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '',
      stopTime: completed ? completed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '',
    });
  }

  async function saveEdit(jobId: string) {
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {};
      if (editForm.wellName) { updates.ndicWellName = editForm.wellName; updates.wellName = editForm.wellName; }
      if (editForm.disposal !== undefined) { updates.hauledTo = editForm.disposal; updates.disposal = editForm.disposal; }
      if (editForm.totalBBL !== undefined) updates.totalBBL = parseFloat(editForm.totalBBL) || 0;
      if (editForm.notes !== undefined) updates.notes = editForm.notes;
      if (editForm.operator !== undefined) updates.operator = editForm.operator;
      if (editForm.invoiceNumber !== undefined) updates.invoiceNumber = editForm.invoiceNumber;
      await updateCompletedJob(jobId, updates);
      setEditingJobId(null);
    } catch (err: unknown) {
      console.error('Failed to save completed job edit:', err);
      window.alert(`Failed to save dispatch edit. This is a write failure, not a no-op.`);
    } finally {
      setSaving(false);
    }
  }

  function toDate(ts: any): Date | null {
    if (!ts) return null;
    if (ts.toDate) return ts.toDate();
    if (ts.seconds) return new Date(ts.seconds * 1000);
    if (typeof ts === 'string') return new Date(ts);
    return null;
  }

  function getDriverName(hash: string) {
    const d = drivers?.find(dr => dr.key === hash);
    return d?.legalName?.split(' ')[0] || d?.displayName || hash?.slice(0, 6) || 'Unknown';
  }

  function getDriverFullName(hash: string) {
    const d = drivers?.find(dr => dr.key === hash);
    return d?.legalName || d?.displayName || hash?.slice(0, 8) || 'Unknown';
  }

  // Get unique drivers from completed jobs
  const uniqueDrivers = useMemo(() => {
    const map = new Map<string, string>();
    jobs.forEach(j => {
      if (!map.has(j.driverHash)) {
        map.set(j.driverHash, getDriverFullName(j.driverHash));
      }
    });
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [jobs, drivers]);

  // Filter + search
  const filtered = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    return jobs.filter(job => {
      // Driver filter
      if (driverFilter !== 'all' && job.driverHash !== driverFilter) return false;

      // Date range filter
      const completed = toDate(job.completedAt);
      if (dateRange === 'today') {
        if (!completed || completed < startOfToday) return false;
      } else if (dateRange === '7d') {
        const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        if (!completed || completed < cutoff) return false;
      } else if (dateRange === '30d') {
        const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        if (!completed || completed < cutoff) return false;
      } else if (dateRange === 'custom') {
        if (!completed) return false;
        if (customFrom) {
          const from = new Date(customFrom + 'T00:00:00');
          if (completed < from) return false;
        }
        if (customTo) {
          const to = new Date(customTo + 'T23:59:59');
          if (completed > to) return false;
        }
      }

      // Search filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const wellName = (job.ndicWellName || job.wellName || '').toLowerCase();
        const disposal = (job.disposal || job.hauledTo || '').toLowerCase();
        const invoiceNum = (job.invoiceNumber || job.ticketNumber || '').toLowerCase();
        const driverName = getDriverFullName(job.driverHash).toLowerCase();
        const serviceType = (job.serviceType || '').toLowerCase();
        if (!wellName.includes(q) && !disposal.includes(q) && !invoiceNum.includes(q) && !driverName.includes(q) && !serviceType.includes(q)) return false;
      }

      return true;
    }).sort((a, b) => {
      const aTime = toDate(a.completedAt)?.getTime() || 0;
      const bTime = toDate(b.completedAt)?.getTime() || 0;
      return bTime - aTime;
    });
  }, [jobs, driverFilter, searchQuery, dateRange, customFrom, customTo, drivers]);

  return (
    <div className="space-y-2">
      {/* ── Filter bar ── */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Driver dropdown */}
        <select
          value={driverFilter}
          onChange={e => setDriverFilter(e.target.value)}
          className="bg-gray-900 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1.5 min-w-[120px]"
        >
          <option value="all">All Drivers</option>
          {uniqueDrivers.map(([hash, name]) => (
            <option key={hash} value={hash}>{name}</option>
          ))}
        </select>

        {/* Search */}
        <div className="relative flex-1 min-w-[140px]">
          <input
            type="text"
            placeholder="Search well, SWD, invoice#..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1.5 pl-7"
          />
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-600 text-xs">⌕</span>
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-xs"
            >×</button>
          )}
        </div>

        {/* Date range pills */}
        <div className="flex items-center bg-gray-900 border border-gray-700 rounded overflow-hidden">
          {(['today', '7d', '30d', 'custom', 'all'] as const).map(range => (
            <button
              key={range}
              onClick={() => setDateRange(range)}
              className={`px-2 py-1 text-[10px] font-medium transition-colors ${
                dateRange === range
                  ? 'bg-green-600 text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              }`}
            >
              {range === 'today' ? 'Today' : range === '7d' ? '7d' : range === '30d' ? '30d' : range === 'custom' ? 'Custom' : 'All'}
            </button>
          ))}
        </div>
      </div>

      {/* Custom date range inputs */}
      {dateRange === 'custom' && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">From</span>
          <input
            type="date"
            value={customFrom}
            onChange={e => setCustomFrom(e.target.value)}
            className="bg-gray-900 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1"
          />
          <span className="text-gray-500">To</span>
          <input
            type="date"
            value={customTo}
            onChange={e => setCustomTo(e.target.value)}
            className="bg-gray-900 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1"
          />
          {(customFrom || customTo) && (
            <button
              onClick={() => { setCustomFrom(''); setCustomTo(''); }}
              className="text-gray-500 hover:text-gray-300 text-xs"
            >Clear</button>
          )}
        </div>
      )}

      {/* ── Count ── */}
      <div className="text-gray-500 text-xs">
        {filtered.length} completed job{filtered.length !== 1 ? 's' : ''}
        {driverFilter !== 'all' || searchQuery || dateRange !== 'today' ? ` (filtered${dateRange === 'custom' && customFrom ? ` from ${customFrom}` : ''}${dateRange === 'custom' && customTo ? ` to ${customTo}` : ''})` : ''}
      </div>

      {/* ── Job list ── */}
      {filtered.length === 0 ? (
        <div className="text-center text-gray-600 py-6 text-sm">
          {jobs.length === 0 ? 'No completed jobs yet' : 'No jobs match filters'}
        </div>
      ) : (
        filtered.map(job => {
          const completed = toDate(job.completedAt);
          const accepted = toDate((job as any).acceptedAt) || toDate(job.assignedAt);
          const assigned = toDate(job.assignedAt);
          const timeStr = completed ? completed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
          const dateStr = completed ? completed.toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
          const driverName = getDriverFullName(job.driverHash);
          const loads = job.loadsCompleted || job.loadCount || 1;
          const isExpanded = expandedJobId === job.id;
          const isHighlighted = highlightJobId === job.id;

          return (
            <div
              key={job.id}
              className={`border rounded-lg transition-colors cursor-pointer ${
                isHighlighted
                  ? 'border-cyan-500 bg-cyan-950/30 ring-1 ring-cyan-500/50'
                  : isExpanded
                  ? 'border-green-600/50 bg-gray-800/80'
                  : 'border-gray-700/50 bg-gray-800/50 hover:border-gray-600/50'
              }`}
              onClick={() => setExpandedJobId(isExpanded ? null : (job.id || null))}
            >
              {/* Summary row */}
              <div className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-green-600/30 flex items-center justify-center flex-shrink-0">
                    <span className="text-green-300 text-xs">✓</span>
                  </div>
                  <JobTypeBadge type={job.jobType} serviceType={job.serviceType} />
                  <span className="text-white font-medium text-sm truncate">{job.ndicWellName || job.wellName}</span>
                  {job.disposal && (
                    <span className="text-cyan-400/60 text-xs truncate">→ {job.disposal}</span>
                  )}
                  <span className="flex-1" />
                  <span className="text-gray-500 text-xs flex-shrink-0">{timeStr}</span>
                  <span className={`text-gray-600 text-xs transition-transform ${isExpanded ? 'rotate-180' : ''}`}>▾</span>
                </div>
                <div className="flex items-center gap-3 mt-1.5 ml-8 text-xs text-gray-500">
                  <span>{driverName}</span>
                  {(job.totalBBL || 0) > 0 && <span className="text-blue-400">{job.totalBBL} BBL</span>}
                  {loads > 1 && <span>{loads} load{loads !== 1 ? 's' : ''}</span>}
                  {dateStr && <span>{dateStr}</span>}
                  {(job.invoiceNumber || job.ticketNumber) && <span className="text-cyan-400/50">#{job.invoiceNumber || job.ticketNumber}</span>}
                  {job.source === 'driver' && (
                    <span className="px-1.5 py-0.5 bg-gray-700 text-gray-400 rounded text-[10px]">Driver Started</span>
                  )}
                  {job.projectId && (
                    <span className="px-1.5 py-0.5 bg-emerald-700/40 text-emerald-400 rounded text-[10px]">Project</span>
                  )}
                </div>
              </div>

              {/* Expanded detail */}
              {isExpanded && editingJobId === job.id ? (
                /* ── EDIT MODE ── */
                <div className="border-t border-green-600/30 px-4 py-3 space-y-2" onClick={e => e.stopPropagation()}>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <div className="relative">
                      <span className="text-gray-500">Well</span>
                      <input value={editForm.wellName || ''} onChange={e => {
                        const v = e.target.value;
                        setEditForm(f => ({ ...f, wellName: v }));
                        if (v.length >= 2 && allWells) {
                          const q = v.toLowerCase();
                          setWellResults(allWells.filter(w => w.well_name.toLowerCase().includes(q)).slice(0, 8));
                          setShowWellDropdown(true);
                        } else { setShowWellDropdown(false); }
                      }}
                        onFocus={() => { if (wellResults.length > 0) setShowWellDropdown(true); }}
                        onBlur={() => setTimeout(() => setShowWellDropdown(false), 150)}
                        className="w-full bg-gray-900 border border-gray-600 text-white text-xs rounded px-2 py-1.5 mt-0.5" />
                      {showWellDropdown && wellResults.length > 0 && (
                        <div className="absolute z-50 left-0 right-0 mt-0.5 bg-gray-800 border border-gray-600 rounded shadow-lg max-h-36 overflow-y-auto">
                          {wellResults.map((w, i) => (
                            <button key={i} type="button"
                              onMouseDown={() => { setEditForm(f => ({ ...f, wellName: w.well_name, operator: w.operator || f.operator })); setShowWellDropdown(false); }}
                              className="w-full text-left px-2 py-1 text-xs text-gray-200 hover:bg-gray-700 truncate"
                            >{w.well_name} <span className="text-gray-500">{w.operator}</span></button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="relative">
                      <span className="text-gray-500">Drop-off</span>
                      <input value={editForm.disposal || ''} onChange={e => {
                        const v = e.target.value;
                        setEditForm(f => ({ ...f, disposal: v }));
                        if (v.length >= 2 && allDisposals) {
                          const q = v.toLowerCase();
                          setDisposalResults(allDisposals.filter(d => d.well_name.toLowerCase().includes(q)).slice(0, 8));
                          setShowDisposalDropdown(true);
                        } else { setShowDisposalDropdown(false); }
                      }}
                        onFocus={() => { if (disposalResults.length > 0) setShowDisposalDropdown(true); }}
                        onBlur={() => setTimeout(() => setShowDisposalDropdown(false), 150)}
                        className="w-full bg-gray-900 border border-gray-600 text-white text-xs rounded px-2 py-1.5 mt-0.5" />
                      {showDisposalDropdown && disposalResults.length > 0 && (
                        <div className="absolute z-50 left-0 right-0 mt-0.5 bg-gray-800 border border-gray-600 rounded shadow-lg max-h-36 overflow-y-auto">
                          {disposalResults.map((d, i) => (
                            <button key={i} type="button"
                              onMouseDown={() => { setEditForm(f => ({ ...f, disposal: d.well_name })); setShowDisposalDropdown(false); }}
                              className="w-full text-left px-2 py-1 text-xs text-gray-200 hover:bg-gray-700 truncate"
                            >{d.well_name} <span className="text-gray-500">{d.operator}</span></button>
                          ))}
                        </div>
                      )}
                    </div>
                    <label className="block">
                      <span className="text-gray-500">BBLs</span>
                      <input type="number" value={editForm.totalBBL || ''} onChange={e => setEditForm(f => ({ ...f, totalBBL: e.target.value }))}
                        className="w-full bg-gray-900 border border-gray-600 text-white text-xs rounded px-2 py-1.5 mt-0.5" />
                    </label>
                    <label className="block">
                      <span className="text-gray-500">Invoice #</span>
                      <input value={editForm.invoiceNumber || ''} onChange={e => setEditForm(f => ({ ...f, invoiceNumber: e.target.value }))}
                        className="w-full bg-gray-900 border border-gray-600 text-white text-xs rounded px-2 py-1.5 mt-0.5" />
                    </label>
                    <label className="block">
                      <span className="text-gray-500">Operator</span>
                      <input value={editForm.operator || ''} onChange={e => setEditForm(f => ({ ...f, operator: e.target.value }))}
                        className="w-full bg-gray-900 border border-gray-600 text-white text-xs rounded px-2 py-1.5 mt-0.5" />
                    </label>
                    <label className="block">
                      <span className="text-gray-500">Date</span>
                      <input type="date" value={editForm.date || ''} onChange={e => setEditForm(f => ({ ...f, date: e.target.value }))}
                        className="w-full bg-gray-900 border border-gray-600 text-gray-300 text-xs rounded px-2 py-1.5 mt-0.5" />
                    </label>
                    <label className="block">
                      <span className="text-gray-500">Start Time</span>
                      <input type="time" value={editForm.startTime || ''} onChange={e => setEditForm(f => ({ ...f, startTime: e.target.value }))}
                        className="w-full bg-gray-900 border border-gray-600 text-gray-300 text-xs rounded px-2 py-1.5 mt-0.5" />
                    </label>
                    <label className="block">
                      <span className="text-gray-500">Stop Time</span>
                      <input type="time" value={editForm.stopTime || ''} onChange={e => setEditForm(f => ({ ...f, stopTime: e.target.value }))}
                        className="w-full bg-gray-900 border border-gray-600 text-gray-300 text-xs rounded px-2 py-1.5 mt-0.5" />
                    </label>
                  </div>
                  <label className="block text-xs">
                    <span className="text-gray-500">Notes</span>
                    <textarea value={editForm.notes || ''} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                      rows={2} className="w-full bg-gray-900 border border-gray-600 text-white text-xs rounded px-2 py-1.5 mt-0.5 resize-none" />
                  </label>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => job.id && saveEdit(job.id)}
                      disabled={saving}
                      className="px-3 py-1 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded transition-colors disabled:opacity-50"
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditingJobId(null)}
                      className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : isExpanded ? (
                /* ── VIEW MODE ── */
                <div className="border-t border-gray-700/50 px-4 py-3 space-y-3">
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                    <div>
                      <span className="text-gray-500">Driver</span>
                      <div className="text-gray-200">{getDriverFullName(job.driverHash)}</div>
                    </div>
                    <div>
                      <span className="text-gray-500">Job Type</span>
                      <div className="text-gray-200">
                        {job.jobType === 'pw' ? 'Production Water' : `Service Work${job.serviceType ? ` — ${job.serviceType}` : ''}`}
                        {job.packageId && job.packageId !== 'water-hauling' && (
                          <span className="ml-1 text-gray-500">({job.packageId})</span>
                        )}
                      </div>
                    </div>
                    <div>
                      <span className="text-gray-500">Well</span>
                      <div className="text-gray-200">{job.ndicWellName || job.wellName}</div>
                    </div>
                    <div>
                      <span className="text-gray-500">Drop-off</span>
                      <div className="text-gray-200">{job.hauledTo || job.disposal || job.disposalName || '—'}</div>
                    </div>
                    <div>
                      <span className="text-gray-500">BBLs</span>
                      <div className="text-blue-300 font-medium">{job.totalBBL || '—'}</div>
                    </div>
                    {(job.loadCount || 0) > 1 && (
                      <div>
                        <span className="text-gray-500">Loads</span>
                        <div className="text-gray-200">{job.loadsCompleted || job.loadCount} / {job.loadCount}</div>
                      </div>
                    )}
                    <div>
                      <span className="text-gray-500">{job.invoiceNumber ? 'Invoice #' : 'Ticket #'}</span>
                      <div className="text-cyan-300">{job.invoiceNumber || job.ticketNumber || '—'}</div>
                    </div>
                    {job.operator && (
                      <div>
                        <span className="text-gray-500">Operator</span>
                        <div className="text-gray-200">{job.operator}</div>
                      </div>
                    )}
                    {job.route && (
                      <div>
                        <span className="text-gray-500">Route</span>
                        <div className="text-gray-200">{job.route}</div>
                      </div>
                    )}
                  </div>

                  {/* Timeline */}
                  <div className="border-t border-gray-700/30 pt-2">
                    <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-1.5">Timeline</div>
                    <div className="flex items-center gap-4 text-xs">
                      {(accepted || assigned) && (
                        <div className="flex items-center gap-1.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                          <span className="text-gray-400">{job.source === 'driver' ? 'Created' : accepted ? 'Accepted' : 'Dispatched'}</span>
                          <span className="text-gray-300">{(accepted || assigned)!.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                        </div>
                      )}
                      {completed && (
                        <div className="flex items-center gap-1.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                          <span className="text-gray-400">Completed</span>
                          <span className="text-gray-300">{completed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                        </div>
                      )}
                      {assigned && completed && (
                        <span className="text-gray-600 text-[10px]">
                          ({Math.round((completed.getTime() - assigned.getTime()) / 60000)} min)
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Notes */}
                  {job.notes && (
                    <div className="border-t border-gray-700/30 pt-2">
                      <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-1">Notes</div>
                      <div className="text-gray-300 text-xs">{job.notes}</div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="border-t border-gray-700/30 pt-2 flex items-center gap-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); startEdit(job); }}
                      className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded transition-colors"
                    >
                      Edit
                    </button>
                    {(job.invoiceNumber || job.ticketNumber || (job as any).invoiceDocId) && (
                      <button
                        onClick={(e) => { e.stopPropagation(); loadTicketDetail(job.invoiceNumber || job.ticketNumber || '', job.id!, (job as any).invoiceDocId); }}
                        className={`px-3 py-1 text-xs rounded transition-colors ${ticketDetailJobId === job.id ? 'bg-cyan-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-cyan-400'}`}
                      >
                        {ticketDetailJobId === job.id ? 'Hide Ticket' : 'View Ticket'}
                      </button>
                    )}
                  </div>

                  {/* Inline paper-style ticket detail */}
                  {ticketDetailJobId === job.id && (
                    <div className="mt-3">
                      {ticketDetailLoading ? (
                        <div className="bg-[#FAFAF8] rounded-lg p-6 text-center text-gray-400 text-sm animate-pulse">Loading...</div>
                      ) : ticketDetailData?.invoice ? (
                        <div className="bg-[#FAFAF8] rounded-lg shadow border-l-4 border-yellow-500">
                          <div className="p-4 space-y-0">
                            {/* Header */}
                            <div className="flex items-start justify-between mb-3">
                              <h4 className="text-[#111] font-black text-lg tracking-tight">
                                INVOICE
                              </h4>
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold border border-gray-400 text-gray-600">
                                {(ticketDetailData.invoice.status || 'closed').toUpperCase()}
                              </span>
                            </div>

                            {/* Invoice # / Date */}
                            <div className="flex items-center justify-between py-1 border-b border-gray-200">
                              <span className="text-xs text-gray-500">Invoice #</span>
                              <span className="text-xs text-[#111] font-mono font-semibold">{job.invoiceNumber || job.ticketNumber || '—'}</span>
                            </div>
                            <div className="flex items-center justify-between py-1 border-b border-gray-200">
                              <span className="text-xs text-gray-500">Date</span>
                              <span className="text-xs text-[#111]">{ticketDetailData.invoice.date || '--'}</span>
                            </div>

                            {/* Job Details */}
                            <h5 className="text-[#111] font-extrabold text-[10px] tracking-[1.5px] uppercase pt-3 pb-1">JOB DETAILS</h5>
                            <div className="flex items-center justify-between py-1 border-b border-gray-200">
                              <span className="text-xs text-gray-500">Operator</span>
                              <span className="text-xs text-[#111] text-right">{ticketDetailData.invoice.operator || '--'}</span>
                            </div>
                            <div className="flex items-center justify-between py-1 border-b border-gray-200">
                              <span className="text-xs text-gray-500">Well</span>
                              <span className="text-xs text-[#111] text-right">{ticketDetailData.invoice.wellName || '--'}</span>
                            </div>
                            <div className="flex items-center justify-between py-1 border-b border-gray-200">
                              <span className="text-xs text-gray-500">Drop-off</span>
                              <span className="text-xs text-[#111] text-right">{ticketDetailData.invoice.hauledTo || '--'}</span>
                            </div>

                            {/* Driver & Vehicle */}
                            <h5 className="text-[#111] font-extrabold text-[10px] tracking-[1.5px] uppercase pt-3 pb-1">DRIVER & VEHICLE</h5>
                            <div className="flex items-center justify-between py-1 border-b border-gray-200">
                              <span className="text-xs text-gray-500">Driver</span>
                              <span className="text-xs text-[#111]">{ticketDetailData.invoice.driver || '--'}</span>
                            </div>
                            <div className="flex items-center justify-between py-1 border-b border-gray-200">
                              <span className="text-xs text-gray-500">Truck #</span>
                              <span className="text-xs text-[#111]">{ticketDetailData.invoice.truckNumber || '--'}</span>
                            </div>
                            {ticketDetailData.invoice.trailer && (
                              <div className="flex items-center justify-between py-1 border-b border-gray-200">
                                <span className="text-xs text-gray-500">Trailer #</span>
                                <span className="text-xs text-[#111]">{ticketDetailData.invoice.trailer}</span>
                              </div>
                            )}

                            {/* Time */}
                            {(ticketDetailData.invoice.startTime || ticketDetailData.invoice.stopTime) && (
                              <>
                                <h5 className="text-[#111] font-extrabold text-[10px] tracking-[1.5px] uppercase pt-3 pb-1">TIME</h5>
                                {ticketDetailData.invoice.startTime && (
                                  <div className="flex items-center justify-between py-1 border-b border-gray-200">
                                    <span className="text-xs text-gray-500">Start</span>
                                    <span className="text-xs text-[#111] font-mono">{ticketDetailData.invoice.startTime}</span>
                                  </div>
                                )}
                                {ticketDetailData.invoice.stopTime && (
                                  <div className="flex items-center justify-between py-1 border-b border-gray-200">
                                    <span className="text-xs text-gray-500">Stop</span>
                                    <span className="text-xs text-[#111] font-mono">{ticketDetailData.invoice.stopTime}</span>
                                  </div>
                                )}
                              </>
                            )}

                            {/* Ticket cards */}
                            <h5 className="text-[#111] font-extrabold text-[10px] tracking-[1.5px] uppercase pt-3 pb-1">LINE ITEMS</h5>
                            {ticketDetailData.tickets.map((t: any, idx: number) => (
                              <div key={idx} className="border border-gray-300 rounded-lg overflow-hidden mb-2">
                                {/* s_t: ticket # is the invoice #, no separate header needed. i_t: show WATER TICKET header per line item */}
                                {ticketDetailData.tickets.length > 1 && (
                                  <div className="flex items-center justify-between px-3 py-1.5 bg-gray-100 border-b border-gray-300">
                                    <span className="text-[10px] font-bold tracking-wide text-red-500">WATER TICKET</span>
                                    <span className="text-[#111] font-mono font-semibold text-xs">#{t.ticketNumber}</span>
                                  </div>
                                )}
                                <div className="px-3 py-2 space-y-0.5">
                                  {t.location && <div className="flex justify-between"><span className="text-[10px] text-gray-500">Pickup</span><span className="text-[10px] text-[#111]">{t.location}</span></div>}
                                  {t.hauledTo && <div className="flex justify-between"><span className="text-[10px] text-gray-500">Drop-off</span><span className="text-[10px] text-[#111]">{t.hauledTo}</span></div>}
                                  {t.timeGauged && <div className="flex justify-between"><span className="text-[10px] text-gray-500">Time Gauged</span><span className="text-[10px] text-[#111]">{t.timeGauged}</span></div>}
                                </div>
                                {/* 5-col: TYPE | PICKUP BBL | DROP-OFF BBL | TOP | BOTTOM.
                                    Mirrored values for normal jobs; diverge for split-ticket chains. */}
                                <div className="grid grid-cols-5 border-t border-gray-300">
                                  <div className="text-center py-1.5 border-r border-gray-300"><div className="text-[8px] text-gray-400 uppercase">TYPE</div><div className="text-xs font-semibold text-[#111] font-mono">{t.type || 'PW'}</div></div>
                                  <div className="text-center py-1.5 border-r border-gray-300"><div className="text-[8px] text-gray-400 uppercase">PICKUP BBL</div><div className="text-xs font-semibold text-[#111] font-mono">{t.pickupBbls != null ? String(t.pickupBbls) : (t.qty || t.bbls || '--')}</div></div>
                                  <div className="text-center py-1.5 border-r border-gray-300"><div className="text-[8px] text-gray-400 uppercase">DROP-OFF BBL</div><div className="text-xs font-semibold text-[#111] font-mono">{t.dropoffBbls != null ? String(t.dropoffBbls) : (t.qty || t.bbls || '--')}</div></div>
                                  <div className="text-center py-1.5 border-r border-gray-300"><div className="text-[8px] text-gray-400 uppercase">TOP</div><div className="text-xs font-semibold text-[#111] font-mono">{t.top || '--'}</div></div>
                                  <div className="text-center py-1.5"><div className="text-[8px] text-gray-400 uppercase">BOTTOM</div><div className="text-xs font-semibold text-[#111] font-mono">{t.bottom || '--'}</div></div>
                                </div>
                                {(t.apiNo || t.legalDesc || t.county || t.hauledToApiNo || t.hauledToLegalDesc) && (
                                  <div className="px-3 py-1.5 border-t border-gray-200 grid grid-cols-2 gap-4">
                                    <div>
                                      <p className="text-[9px] font-semibold text-gray-500 mb-0.5">Pickup</p>
                                      {t.apiNo && <p className="text-[9px] text-gray-400">API# {t.apiNo}</p>}
                                      {t.county && <p className="text-[9px] text-gray-400">County: {t.county}</p>}
                                      {t.legalDesc && <p className="text-[9px] text-gray-400">Legal: {t.legalDesc}</p>}
                                      {t.gpsLat && <p className="text-[9px] text-gray-400">GPS: {Number(t.gpsLat).toFixed(7)}, {Number(t.gpsLng).toFixed(7)}</p>}
                                    </div>
                                    <div>
                                      <p className="text-[9px] font-semibold text-gray-500 mb-0.5">Drop-off</p>
                                      {t.hauledToApiNo && <p className="text-[9px] text-gray-400">API# {t.hauledToApiNo}</p>}
                                      {t.hauledToCounty && <p className="text-[9px] text-gray-400">County: {t.hauledToCounty}</p>}
                                      {t.hauledToLegalDesc && <p className="text-[9px] text-gray-400">Legal: {t.hauledToLegalDesc}</p>}
                                      {t.hauledToGpsLat && <p className="text-[9px] text-gray-400">GPS: {Number(t.hauledToGpsLat).toFixed(7)}, {Number(t.hauledToGpsLng).toFixed(7)}</p>}
                                    </div>
                                  </div>
                                )}
                              </div>
                            ))}

                            {ticketDetailData.tickets.length === 0 && (
                              <div className="text-xs text-gray-400 py-2">No ticket records found</div>
                            )}

                            {/* Notes */}
                            {/* GPS Timeline */}
                            {ticketDetailData.invoice.timeline?.length > 0 && (
                              <>
                                <h5 className="text-[#111] font-extrabold text-[10px] tracking-[1.5px] uppercase pt-3 pb-1">JOB TIMELINE</h5>
                                <div className="space-y-2 ml-1">
                                  {(() => { let arriveIdx = 0; return [...ticketDetailData.invoice.timeline]
                                    .sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
                                    .map((ev: any, i: number) => {
                                      const t = new Date(ev.timestamp);
                                      const time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                                      const dotColor = ev.type === 'depart' || ev.type === 'depart_site' ? 'bg-blue-400'
                                        : ev.type === 'arrive' ? 'bg-green-400'
                                        : ev.type === 'close' ? 'bg-red-400'
                                        : ev.type === 'pause' ? 'bg-yellow-400'
                                        : 'bg-gray-400';
                                      const label = ev.type === 'accept' ? 'Accepted'
                                        : ev.type === 'depart_site' ? 'Loaded / Departure'
                                        : ev.type === 'depart' ? 'Departed'
                                        : ev.type === 'arrive' ? (arriveIdx++ % 2 === 0 ? 'Pickup Arrival' : 'Drop-off Arrival')
                                        : ev.type === 'close' ? 'Job Closed'
                                        : ev.type === 'pause' ? 'Paused'
                                        : ev.type === 'resume' ? 'Resumed'
                                        : ev.type === 'reroute' ? 'Rerouted'
                                        : ev.type;
                                      return (
                                        <div key={i} className="flex items-start gap-2">
                                          <div className={`w-2 h-2 rounded-full mt-1 shrink-0 ${dotColor}`} />
                                          <span className="text-[10px] font-mono text-gray-500 w-14 shrink-0">{time}</span>
                                          <div>
                                            <span className="text-xs font-semibold text-[#111]">{label}</span>
                                            {ev.locationName && <div className="text-[10px] text-gray-400">{ev.locationName}</div>}
                                          </div>
                                        </div>
                                      );
                                    }); })()}
                                </div>
                              </>
                            )}

                            {ticketDetailData.invoice.notes && (
                              <>
                                <h5 className="text-[#111] font-extrabold text-[10px] tracking-[1.5px] uppercase pt-3 pb-1">REMARKS</h5>
                                <p className="text-xs text-[#111] whitespace-pre-wrap">{ticketDetailData.invoice.notes}</p>
                              </>
                            )}

                            {/* Photos — type='jsa' renders as JSA tile after image photos */}
                            {ticketDetailData.invoice.photos?.length > 0 && (() => {
                              const imagePhotos: any[] = [];
                              const jsaPhotos: any[] = [];
                              for (const p of ticketDetailData.invoice.photos) {
                                const t = typeof p === 'object' ? p?.type : '';
                                if (t === 'jsa') jsaPhotos.push(p); else imagePhotos.push(p);
                              }
                              return (
                                <>
                                  <h5 className="text-[#111] font-extrabold text-[10px] tracking-[1.5px] uppercase pt-3 pb-1">PHOTOS ({imagePhotos.length}){jsaPhotos.length > 0 ? ' + JSA' : ''}</h5>
                                  <div className="flex gap-2 overflow-x-auto pb-2">
                                    {imagePhotos.map((photo: any, i: number) => {
                                      let url = typeof photo === 'string' ? photo : photo?.uri;
                                      const loc = typeof photo === 'object' ? photo?.location : '';
                                      const photoType = typeof photo === 'object' ? photo?.type : '';
                                      if (!url) return null;
                                      // Rewrite firebasestorage.googleapis.com URLs — that domain has DNS issues.
                                      // storage.googleapis.com/{bucket}/{path} is reliable.
                                      if (url.includes('firebasestorage.googleapis.com')) {
                                        const m = url.match(/\/o\/(.+?)(\?|$)/);
                                        const bucketM = url.match(/\/b\/([^/]+)\//);
                                        if (m && bucketM) url = `https://storage.googleapis.com/${bucketM[1]}/${decodeURIComponent(m[1])}`;
                                      }
                                      return (
                                        // The completed-job card collapses on outer-row click; stopPropagation
                                        // on the photo anchor prevents click-through from bubbling up and
                                        // collapsing the card behind the new browser tab.
                                        <div key={`img-${i}`} className="flex-shrink-0 text-center" onClick={(e) => e.stopPropagation()}>
                                          <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                                            <img src={url} alt={`Photo ${i + 1}`} className="w-16 h-16 object-cover rounded border border-gray-300 hover:border-yellow-500 transition-colors cursor-pointer" />
                                          </a>
                                          {loc && <p className="text-[8px] text-gray-400 mt-0.5 max-w-[64px] truncate">{photoType === 'pickup' ? '📍' : '📦'} {loc}</p>}
                                        </div>
                                      );
                                    })}
                                    {jsaPhotos.map((photo: any, i: number) => {
                                      let url = typeof photo === 'string' ? photo : photo?.uri;
                                      if (!url) return null;
                                      if (url.includes('firebasestorage.googleapis.com')) {
                                        const m = url.match(/\/o\/(.+?)(\?|$)/);
                                        const bucketM = url.match(/\/b\/([^/]+)\//);
                                        if (m && bucketM) url = `https://storage.googleapis.com/${bucketM[1]}/${decodeURIComponent(m[1])}`;
                                      }
                                      return (
                                        <div key={`jsa-${i}`} className="flex-shrink-0 text-center" onClick={(e) => e.stopPropagation()}>
                                          <a href={url} target="_blank" rel="noopener noreferrer" title="Open Job Safety Analysis PDF" onClick={(e) => e.stopPropagation()}>
                                            <div className="w-16 h-16 rounded border-2 border-yellow-500 bg-yellow-50 hover:bg-yellow-100 transition-colors cursor-pointer flex flex-col items-center justify-center">
                                              <svg className="w-7 h-7 text-yellow-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                                              </svg>
                                              <span className="text-[9px] font-bold text-yellow-700 mt-0.5 tracking-wider">JSA</span>
                                            </div>
                                          </a>
                                          <p className="text-[8px] text-yellow-700 mt-0.5 font-semibold">Tap to open</p>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </>
                              );
                            })()}

                            {/* Totals */}
                            <div className="border-t-2 border-yellow-500 mt-4 pt-2">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-[#111]">Total BBL</span>
                                <span className="text-xs font-semibold text-[#111] font-mono">{ticketDetailData.invoice.totalBBL || '--'}</span>
                              </div>
                              {ticketDetailData.invoice.totalHours > 0 && (
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-semibold text-[#111]">Total Hours</span>
                                  <span className="text-xs font-semibold text-[#111] font-mono">{ticketDetailData.invoice.totalHours}</span>
                                </div>
                              )}
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-[#111]">Tickets</span>
                                <span className="text-xs font-semibold text-[#111] font-mono">{ticketDetailData.tickets.length}</span>
                              </div>
                            </div>

                            <div className="text-center pt-3 pb-1">
                              <span className="text-[10px] text-gray-400 tracking-wider">WellBuilt Tickets</span>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="bg-[#FAFAF8] rounded-lg p-4 text-center text-gray-400 text-xs">No invoice found for #{job.invoiceNumber}</div>
                      )}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}

// Row for unassigned transfer requests — pulsing orange, driver dropdown for dispatch to assign
function UnassignedTransferRow({ job, drivers, assignTransfer, cancelDispatch }: {
  job: DispatchJob;
  drivers: { key: string; displayName: string; legalName?: string; loginAlias?: string; onShift?: boolean }[];
  assignTransfer?: (jobId: string, driverHash: string, driverName: string) => void;
  cancelDispatch: (id: string) => void;
}) {
  // Pre-select intended driver if Driver A picked someone (pending_approval flow)
  const [selectedHash, setSelectedHash] = useState(job.intendedDriverHash || '');
  const isPendingApproval = job.status === 'pending_approval';

  const handleAssign = () => {
    if (!selectedHash || !job.id || !assignTransfer) return;
    const driver = drivers.find(d => d.key === selectedHash);
    if (driver) assignTransfer(job.id, driver.key, driver.displayName);
  };

  const handleDeny = () => {
    if (!job.id) return;
    if (!confirm('Deny this transfer request? Driver will be returned to the source job.')) return;
    cancelDispatch(job.id);
  };

  return (
    <div className="px-3 py-2 bg-orange-950/40 border border-orange-600/40 rounded text-sm space-y-2">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-orange-500" />
        </span>
        <span className="text-white font-medium truncate">{job.ndicWellName || job.wellName}</span>
        <span className="px-1.5 py-0.5 bg-orange-600/30 text-orange-300 text-xs rounded font-medium">
          Transfer from {job.transferFromDriver}
        </span>
        {isPendingApproval && job.intendedDriverName && (
          <span className="text-gray-400 text-xs">→ requested for {job.intendedDriverName}</span>
        )}
        {job.sourceInvoiceNumber && (
          <span className="text-gray-500 text-xs">Invoice #{job.sourceInvoiceNumber}</span>
        )}
        <span className="flex-1" />
      </div>
      {/* Transfer reason — driver's stated reason for requesting transfer.
          Prominent line so the dispatcher knows context before assigning. */}
      {job.transferReason && (
        <div className="px-2 py-1 bg-amber-700/20 border border-amber-600/40 rounded text-xs text-amber-100">
          <span className="font-semibold mr-1">Reason:</span>{job.transferReason}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-orange-300 text-xs font-medium">{isPendingApproval ? 'Approve to:' : 'Assign to:'}</span>
        <select
          value={selectedHash}
          onChange={(e) => setSelectedHash(e.target.value)}
          className="flex-1 px-2 py-1 bg-gray-900 border border-gray-700 rounded text-white text-xs focus:outline-none focus:border-orange-500"
        >
          <option value="">Select driver...</option>
          {/* Transfer-approval sub-row: shift dot not resolved in this component's context. */}
          {drivers.map(d => (
            <option key={d.key} value={d.key} title="Shift status unavailable (transfer picker)">{'⚪ '}{operationalDriverName(d)}</option>
          ))}
        </select>
        <button
          onClick={handleAssign}
          disabled={!selectedHash}
          className="px-3 py-1 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs font-medium rounded transition-colors"
        >
          {isPendingApproval ? 'Approve' : 'Assign'}
        </button>
        <button
          onClick={handleDeny}
          className="px-3 py-1 bg-gray-700 hover:bg-red-700 text-gray-200 hover:text-white text-xs font-medium rounded transition-colors"
          title="Deny transfer request and return Driver A to the source job"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

// ─── Driver Disposal Row (Projects) ──────────────────────────────────────

function DriverDisposalRow({ hash, name, disposal, borderColor, allDisposals, onRemove, onSetDisposal }: {
  hash: string;
  name: string;
  disposal?: { name: string; lat?: number; lng?: number };
  borderColor: string;
  allDisposals: NdicWell[];
  onRemove: () => void;
  onSetDisposal: (disp: { name: string; lat?: number; lng?: number } | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState('');
  const results = search.length >= 2 ? searchDisposals(search, allDisposals) : [];

  return (
    <div className={`bg-gray-900 border ${borderColor} rounded px-3 py-1.5`}>
      <div className="flex items-center justify-between">
        <span className="text-white text-xs">{name}</span>
        <button onClick={onRemove} className="text-red-400/50 hover:text-red-400 text-[10px]">Remove</button>
      </div>
      {!editing ? (
        <button
          onClick={() => { setEditing(true); setSearch(disposal?.name || ''); }}
          className="text-[10px] mt-0.5 text-left w-full"
        >
          {disposal?.name
            ? <span className="text-cyan-400">{disposal.name}</span>
            : <span className="text-gray-500 italic">No drop-off assigned</span>
          }
        </button>
      ) : (
        <div className="mt-1 relative">
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search SWD..."
              autoFocus
              className="flex-1 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-[11px] focus:outline-none focus:border-cyan-500"
            />
            {disposal && (
              <button
                onClick={() => { onSetDisposal(null); setEditing(false); setSearch(''); }}
                className="text-red-400 text-[10px] px-1"
              >Clear</button>
            )}
            <button
              onClick={() => { setEditing(false); setSearch(''); }}
              className="text-gray-400 text-[10px] px-1"
            >Done</button>
          </div>
          {results.length > 0 && (
            <div className="absolute z-50 left-0 right-0 top-full mt-1 bg-gray-800 border border-gray-600 rounded max-h-32 overflow-y-auto shadow-lg">
              {results.slice(0, 8).map((d, i) => (
                <button
                  key={i}
                  onClick={() => {
                    onSetDisposal({ name: d.well_name, lat: d.latitude || undefined, lng: d.longitude || undefined });
                    setEditing(false);
                    setSearch('');
                  }}
                  className="block w-full text-left px-2 py-1.5 hover:bg-gray-700 text-[11px]"
                >
                  <div className="text-white">{d.well_name}</div>
                  {d.operator && <div className="text-gray-400 text-[10px]">{d.operator}</div>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Projects List Panel ──────────────────────────────────────────────────

function ProjectsListPanel({ projects, dispatches, drivers, onSelect }: {
  projects: Project[];
  dispatches: DispatchJob[];
  drivers: { key: string; displayName: string; legalName?: string }[];
  onSelect: (p: Project) => void;
}) {
  if (projects.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-gray-500 text-sm mb-2">No active projects</div>
        <div className="text-gray-600 text-xs">Create a project for long-running jobs like flowback, frac cleanup, or extended campaigns.</div>
      </div>
    );
  }

  function getDriverName(hash: string) {
    const d = drivers.find(dr => dr.key === hash);
    return d?.legalName?.split(' ')[0] || d?.displayName || hash.slice(0, 6);
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-3">
      {projects.map(project => {
        const projectJobs = dispatches.filter((d: any) => d.projectId === project.id);
        const activeJobs = projectJobs.filter(j => ['pending', 'accepted', 'in_progress'].includes(j.status));
        const todayDriverHashes = project.driverSchedule?.[today] || [];
        const daysActive = Math.max(1, Math.ceil((Date.now() - new Date(project.startDate).getTime()) / 86400000));

        return (
          <button
            key={project.id}
            onClick={() => onSelect(project)}
            className="w-full text-left bg-gray-900 border border-gray-700 rounded-lg p-4 hover:border-emerald-600/50 transition-colors"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <h4 className="text-white font-medium text-sm">{project.name}</h4>
                <span className={`px-1.5 py-0.5 text-[10px] rounded font-bold ${
                  project.status === 'active' ? 'bg-emerald-600/20 text-emerald-400' :
                  project.status === 'paused' ? 'bg-amber-600/20 text-amber-400' :
                  'bg-gray-600/20 text-gray-400'
                }`}>
                  {project.status.toUpperCase()}
                </span>
              </div>
              <span className="text-gray-500 text-xs">{daysActive}d active</span>
            </div>

            <div className="flex items-center gap-3 text-xs text-gray-400 mb-2">
              <span>{project.operatorName}</span>
              <span>·</span>
              <span>{project.wellNames.length} well{project.wellNames.length !== 1 ? 's' : ''}</span>
              {project.projectedEndDate && (
                <>
                  <span>·</span>
                  <span>→ {project.projectedEndDate}</span>
                </>
              )}
            </div>

            <div className="flex items-center gap-3">
              {activeJobs.length > 0 && (
                <span className="px-1.5 py-0.5 bg-blue-600/20 text-blue-400 text-[10px] rounded font-bold">
                  {activeJobs.length} active
                </span>
              )}
              {todayDriverHashes.length > 0 && (
                <div className="flex items-center gap-1">
                  {todayDriverHashes.slice(0, 4).map(hash => (
                    <span key={hash} className="px-1.5 py-0.5 bg-gray-700 text-gray-300 text-[10px] rounded">
                      {getDriverName(hash)}
                    </span>
                  ))}
                  {todayDriverHashes.length > 4 && (
                    <span className="text-gray-500 text-[10px]">+{todayDriverHashes.length - 4}</span>
                  )}
                </div>
              )}
            </div>

            {activeJobs.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {activeJobs.map(job => (
                  <span key={job.id} className="flex items-center gap-1 px-1.5 py-0.5 bg-gray-800 rounded text-[10px]">
                    <span className="text-gray-400">{getDriverName(job.driverHash)}</span>
                    <StageBadge job={job} />
                  </span>
                ))}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Project Detail Panel ─────────────────────────────────────────────────

function ProjectDetailPanel({ project, projectDispatches, projectInvoices, drivers, allDisposals, cancelDispatch, onStatusChange, onAddDriver, onUpdateProject, onBatchDispatch }: {
  project: Project;
  projectDispatches: DispatchJob[];
  projectInvoices: ProjectInvoice[];
  drivers: { key: string; displayName: string; legalName?: string; phone?: string }[];
  allDisposals: NdicWell[];
  cancelDispatch: (id: string) => void;
  onStatusChange: (id: string, status: 'active' | 'paused' | 'completed') => void;
  onAddDriver: (hash: string) => void;
  onUpdateProject?: (id: string, data: Partial<Project>) => void;
  onBatchDispatch?: (shift: 'day' | 'night') => void;
}) {
  const [detailTab, setDetailTab] = useState<'activity' | 'history' | 'drivers'>('activity');
  const [addDriverHash, setAddDriverHash] = useState('');
  const [addDriverShift, setAddDriverShift] = useState<'day' | 'night'>('day');
  const [editNotes, setEditNotes] = useState(project.notes || '');
  const [showNotesEdit, setShowNotesEdit] = useState(false);
  const [newUpdate, setNewUpdate] = useState('');
  const [updateShift, setUpdateShift] = useState<'day' | 'night'>('day');
  const [copied, setCopied] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const todayDriverHashes = project.driverSchedule?.[today] || [];
  const daysActive = Math.max(1, Math.ceil((Date.now() - new Date(project.startDate).getTime()) / 86400000));

  function getDriverName(hash: string) {
    const d = drivers.find(dr => dr.key === hash);
    return d?.legalName || d?.displayName || hash.slice(0, 6);
  }

  const totalBbls = projectInvoices.reduce((sum, inv) => sum + (inv.totalBarrels || 0), 0);
  const totalLoads = projectInvoices.length;
  const bblsByDriver = useMemo(() => {
    const map = new Map<string, number>();
    projectInvoices.forEach(inv => {
      const name = inv.driverName || 'Unknown';
      map.set(name, (map.get(name) || 0) + (inv.totalBarrels || 0));
    });
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [projectInvoices]);

  const activeJobs = projectDispatches.filter(j => ['pending', 'accepted', 'in_progress', 'paused'].includes(j.status));
  const completedJobs = projectDispatches.filter(j => j.status === 'completed' || j.status === 'cancelled');

  function generateSummary(shift?: 'day' | 'night') {
    const dayNames = (project.dayDriverHashes || []).map(h => getDriverName(h));
    const nightNames = (project.nightDriverHashes || []).map(h => getDriverName(h));
    const lines = [
      `${project.name} — ${project.operatorName}`,
      `Wells: ${project.wellNames.join(', ')}`,
      `Date: ${new Date().toLocaleDateString()}`,
    ];
    if (shift === 'day') {
      lines.push(`Day Shift: ${dayNames.join(', ') || 'None assigned'}`);
    } else if (shift === 'night') {
      lines.push(`Night Shift: ${nightNames.join(', ') || 'None assigned'}`);
    } else {
      if (dayNames.length > 0) lines.push(`Day: ${dayNames.join(', ')}`);
      if (nightNames.length > 0) lines.push(`Night: ${nightNames.join(', ')}`);
    }
    if (totalBbls > 0) lines.push(`Total: ${totalBbls.toLocaleString()} BBL (${totalLoads} loads)`);
    if (project.notes) lines.push(`Notes: ${project.notes}`);
    return lines.join('\n');
  }

  function copySummary(shift?: 'day' | 'night') {
    navigator.clipboard.writeText(generateSummary(shift));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-3">
      {/* Project header */}
      <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-white font-semibold text-base">{project.name}</h3>
          <div className="flex items-center gap-1.5">
            {project.status === 'active' && (
              <>
                <button onClick={() => onStatusChange(project.id!, 'paused')} className="px-2 py-1 bg-amber-600/20 text-amber-400 text-[10px] font-bold rounded hover:bg-amber-600/30">PAUSE</button>
                <button onClick={() => onStatusChange(project.id!, 'completed')} className="px-2 py-1 bg-gray-700 text-gray-300 text-[10px] font-bold rounded hover:bg-gray-600">COMPLETE</button>
              </>
            )}
            {project.status === 'paused' && (
              <>
                <button onClick={() => onStatusChange(project.id!, 'active')} className="px-2 py-1 bg-emerald-600/20 text-emerald-400 text-[10px] font-bold rounded hover:bg-emerald-600/30">RESUME</button>
                <button onClick={() => onStatusChange(project.id!, 'completed')} className="px-2 py-1 bg-gray-700 text-gray-300 text-[10px] font-bold rounded hover:bg-gray-600">COMPLETE</button>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span>{project.operatorName}</span>
            <span>·</span>
            <span>{project.wellNames.join(', ')}</span>
          </div>
          <div className="flex items-center gap-1">
            {(project.dayDriverHashes || []).length > 0 && (
              <button
                onClick={() => copySummary('day')}
                className="px-2 py-1 bg-amber-600/20 text-amber-400 text-[10px] font-medium rounded hover:bg-amber-600/30 transition-colors"
                title="Copy summary with day shift roster"
              >
                {copied ? '✓' : 'Copy Day'}
              </button>
            )}
            {(project.nightDriverHashes || []).length > 0 && (
              <button
                onClick={() => copySummary('night')}
                className="px-2 py-1 bg-blue-600/20 text-blue-400 text-[10px] font-medium rounded hover:bg-blue-600/30 transition-colors"
                title="Copy summary with night shift roster"
              >
                {copied ? '✓' : 'Copy Night'}
              </button>
            )}
            <button
              onClick={() => copySummary()}
              className="px-2 py-1 bg-gray-700 text-gray-300 text-[10px] font-medium rounded hover:bg-gray-600 transition-colors"
              title="Copy full project summary"
            >
              {copied ? '✓ Copied' : 'Copy All'}
            </button>
          </div>
        </div>

        {/* Editable job description */}
        {showNotesEdit ? (
          <div className="mb-3">
            <textarea
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white text-xs resize-y focus:outline-none focus:border-emerald-500 mb-1"
              placeholder="Job description, scope, equipment needed..."
            />
            <div className="flex gap-1 justify-end">
              <button onClick={() => { setShowNotesEdit(false); setEditNotes(project.notes || ''); }}
                className="px-2 py-1 text-gray-400 text-[10px] hover:text-white">Cancel</button>
              <button onClick={() => {
                onUpdateProject?.(project.id!, { notes: editNotes });
                setShowNotesEdit(false);
              }} className="px-2 py-1 bg-emerald-600 text-white text-[10px] rounded hover:bg-emerald-500">Save</button>
            </div>
          </div>
        ) : (
          <div
            className="text-xs text-gray-500 mb-3 italic cursor-pointer hover:text-gray-300 transition-colors"
            onClick={() => setShowNotesEdit(true)}
            title="Click to edit job description"
          >
            {project.notes || 'No description — click to add'}
          </div>
        )}

        <div className="grid grid-cols-4 gap-2">
          <div className="bg-gray-800 rounded px-3 py-2 text-center">
            <div className="text-emerald-400 font-bold text-lg">{totalBbls.toLocaleString()}</div>
            <div className="text-gray-500 text-[10px]">BBLs</div>
          </div>
          <div className="bg-gray-800 rounded px-3 py-2 text-center">
            <div className="text-blue-400 font-bold text-lg">{totalLoads}</div>
            <div className="text-gray-500 text-[10px]">Loads</div>
          </div>
          <div className="bg-gray-800 rounded px-3 py-2 text-center">
            <div className="text-white font-bold text-lg">{daysActive}</div>
            <div className="text-gray-500 text-[10px]">Days</div>
          </div>
          <div className="bg-gray-800 rounded px-3 py-2 text-center">
            <div className="text-amber-400 font-bold text-lg">{todayDriverHashes.length}</div>
            <div className="text-gray-500 text-[10px]">Drivers Today</div>
          </div>
        </div>
      </div>

      {/* Detail tabs */}
      <div className="flex items-center gap-1 border-b border-gray-700 pb-1">
        {(['activity', 'history', 'drivers'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setDetailTab(tab)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
              detailTab === tab ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab === 'activity' ? `Activity (${activeJobs.length})` :
             tab === 'history' ? `Pull History (${projectInvoices.length})` :
             `Drivers (${(project.dayDriverHashes || []).length + (project.nightDriverHashes || []).length})`}
          </button>
        ))}
      </div>

      {/* Activity tab */}
      {detailTab === 'activity' && (
        <div className="space-y-2">
          {/* Render a shift section */}
          {(['day', 'night'] as const).map(shift => {
            const shiftHashes = shift === 'day' ? (project.dayDriverHashes || []) : (project.nightDriverHashes || []);
            const isDay = shift === 'day';
            const shiftJobs = activeJobs.filter(j => shiftHashes.includes(j.driverHash));
            const shiftCompleted = completedJobs.filter(j => shiftHashes.includes(j.driverHash));
            const activeStatuses = ['pending', 'accepted', 'in_progress', 'paused'];
            const activeCombos = new Set(projectDispatches.filter(d => activeStatuses.includes(d.status)).map(d => `${d.driverHash}::${d.wellName}`));
            const newCount = shiftHashes.filter(h => project.wellNames.some(w => !activeCombos.has(`${h}::${w}`))).length;
            return (
              <div key={shift}>
                <div className={`flex items-center justify-between mb-1.5 ${shift === 'night' ? 'mt-3 pt-3 border-t border-gray-700' : ''}`}>
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold uppercase tracking-wider ${isDay ? 'text-amber-400' : 'text-blue-400'}`}>{shift} Shift</span>
                    <span className="text-gray-600 text-[10px]">({shiftHashes.length} driver{shiftHashes.length !== 1 ? 's' : ''})</span>
                  </div>
                  {project.status === 'active' && shiftHashes.length > 0 && (
                    <button
                      onClick={() => onBatchDispatch?.(shift)}
                      disabled={newCount === 0}
                      className={`px-2 py-0.5 text-[10px] font-bold rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors ${isDay ? 'bg-amber-600/20 text-amber-400 hover:bg-amber-600/30' : 'bg-blue-600/20 text-blue-400 hover:bg-blue-600/30'}`}
                    >
                      {newCount > 0 ? `Dispatch (${newCount} new)` : 'All dispatched'}
                    </button>
                  )}
                </div>
                {shiftHashes.length === 0 && (
                  <div className="text-gray-600 text-[10px] py-2">No {shift} drivers assigned</div>
                )}
                {shiftJobs.map(job => (
                  <div key={job.id} className={`bg-gray-900 border rounded-lg px-4 py-2.5 mb-1.5 ${isDay ? 'border-amber-600/20' : 'border-blue-600/20'}`}>
                    <div className="flex items-center gap-2">
                      <JobTypeBadge type={job.jobType} serviceType={job.serviceType} />
                      <span className="text-white font-medium text-sm truncate">{job.ndicWellName || job.wellName}</span>
                      {(() => {
                        const remaining = (job.loadCount || 1) - (job.loadsCompleted || 0);
                        return remaining > 1 ? (
                          <span className="px-1.5 py-0.5 bg-yellow-600/30 text-yellow-300 text-[10px] rounded font-bold flex-shrink-0">x{remaining}</span>
                        ) : null;
                      })()}
                      <span className="flex-1" />
                      <StageBadge job={job} />
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-gray-400">
                      <span>{getDriverName(job.driverHash)}</span>
                      {job.driverDest && <><span>→</span><span className="text-gray-300">{job.driverDest}</span></>}
                      {job.invoiceNumber && <span className="text-gray-600">#{job.invoiceNumber}</span>}
                      {job.hauledTo && <span className="text-cyan-400/60">→ {job.hauledTo}</span>}
                      <span className="flex-1" />
                      <button onClick={() => {
                        if (!job.id) return;
                        cancelDispatch(job.id);
                        // Also remove from shift roster
                        const field = shift === 'day' ? 'dayDriverHashes' : 'nightDriverHashes';
                        const updated = shiftHashes.filter(h => h !== job.driverHash);
                        onUpdateProject?.(project.id!, { [field]: updated });
                      }} className="text-red-400/50 hover:text-red-400 text-[10px]">Remove</button>
                    </div>
                  </div>
                ))}
                {/* Drivers assigned to shift but no active dispatch */}
                {shiftHashes.filter(h => !shiftJobs.some(j => j.driverHash === h) && !shiftCompleted.some(j => j.driverHash === h)).map(hash => (
                  <div key={hash} className={`bg-gray-900/50 border border-gray-800 rounded-lg px-4 py-2 mb-1.5`}>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-gray-400">{getDriverName(hash)}</span>
                      <span className="text-gray-600 text-[10px]">No dispatch</span>
                      <span className="flex-1" />
                      <button onClick={() => {
                        const field = shift === 'day' ? 'dayDriverHashes' : 'nightDriverHashes';
                        const updated = shiftHashes.filter(h => h !== hash);
                        onUpdateProject?.(project.id!, { [field]: updated });
                      }} className="text-red-400/50 hover:text-red-400 text-[10px]">Remove</button>
                    </div>
                  </div>
                ))}
                {shiftCompleted.length > 0 && shiftCompleted.map(job => (
                  <div key={job.id} className="bg-gray-900/50 border border-gray-800 rounded-lg px-4 py-1.5 mb-1 opacity-50">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-gray-400">{getDriverName(job.driverHash)}</span>
                      <span className="text-gray-600">·</span>
                      <span className="text-gray-500">{job.ndicWellName || job.wellName}</span>
                      <span className="flex-1" />
                      <span className="text-emerald-400/50 text-[10px]">Done</span>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}

          {/* Unassigned dispatches (legacy projects without shift assignment) */}
          {(() => {
            const allShiftHashes = new Set([...(project.dayDriverHashes || []), ...(project.nightDriverHashes || [])]);
            const unassigned = activeJobs.filter(j => !allShiftHashes.has(j.driverHash));
            if (unassigned.length === 0) return null;
            return (
              <div className="mt-2 pt-2 border-t border-gray-700/50">
                <div className="text-gray-500 text-[10px] font-bold uppercase tracking-wider mb-1.5">Unassigned Shift</div>
                {unassigned.map(job => (
                  <div key={job.id} className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 mb-1.5">
                    <div className="flex items-center gap-2">
                      <JobTypeBadge type={job.jobType} serviceType={job.serviceType} />
                      <span className="text-white font-medium text-sm truncate">{job.ndicWellName || job.wellName}</span>
                      <span className="flex-1" />
                      <StageBadge job={job} />
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-gray-400">
                      <span>{getDriverName(job.driverHash)}</span>
                      <span className="flex-1" />
                      <button onClick={() => job.id && cancelDispatch(job.id)} className="text-red-400/50 hover:text-red-400 text-[10px]">Cancel</button>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Shift Updates */}
          <div className="mt-4 pt-3 border-t border-gray-700 flex flex-col">
            <div className="text-gray-400 text-[10px] font-bold uppercase tracking-wider mb-2">Shift Updates</div>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto space-y-1.5 mb-3" style={{ maxHeight: '200px' }}>
              {(project.updates || []).length === 0 && (
                <div className="text-gray-600 text-[10px] py-4 text-center">No updates yet — post one for the next shift</div>
              )}
              {[...(project.updates || [])].reverse().map((u, i) => (
                <div key={i} className="text-xs px-3 py-2 bg-gray-900/60 rounded-lg">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded ${u.shift === 'day' ? 'bg-amber-600/20 text-amber-400' : 'bg-blue-600/20 text-blue-400'}`}>
                      {u.shift === 'day' ? 'DAY' : 'NIGHT'}
                    </span>
                    <span className="text-gray-400">{u.author}</span>
                    <span className="text-gray-600 text-[10px]">{new Date(u.timestamp).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                  </div>
                  <div className="text-gray-300 whitespace-pre-wrap leading-relaxed">{u.text}</div>
                </div>
              ))}
            </div>
            {/* Input at bottom */}
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-2">
              <div className="flex items-center gap-1.5 mb-1.5">
                <select value={updateShift} onChange={(e) => setUpdateShift(e.target.value as 'day' | 'night')}
                  className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-[10px] font-medium">
                  <option value="day">Day</option>
                  <option value="night">Night</option>
                </select>
                <span className="flex-1" />
                <button
                  onClick={() => {
                    if (!newUpdate.trim()) return;
                    const update: ProjectUpdate = {
                      text: newUpdate.trim(),
                      author: 'Dispatch',
                      shift: updateShift,
                      timestamp: new Date().toISOString(),
                    };
                    onUpdateProject?.(project.id!, { updates: [...(project.updates || []), update] });
                    setNewUpdate('');
                  }}
                  disabled={!newUpdate.trim()}
                  className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-[10px] font-medium rounded transition-colors"
                >
                  Post
                </button>
              </div>
              <textarea
                value={newUpdate}
                onChange={(e) => setNewUpdate(e.target.value)}
                placeholder="Update for next shift..."
                rows={4}
                className="w-full px-2 py-1.5 bg-gray-800 border border-gray-600 rounded text-white text-xs focus:outline-none focus:border-emerald-500 resize-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && newUpdate.trim()) {
                    e.preventDefault();
                    const update: ProjectUpdate = {
                      text: newUpdate.trim(),
                      author: 'Dispatch',
                      shift: updateShift,
                      timestamp: new Date().toISOString(),
                    };
                    onUpdateProject?.(project.id!, { updates: [...(project.updates || []), update] });
                    setNewUpdate('');
                  }
                }}
              ></textarea>
              <div className="text-gray-600 text-[9px] mt-1">Shift+Enter for new line</div>
            </div>
          </div>
        </div>
      )}

      {/* Pull History tab */}
      {detailTab === 'history' && (
        <div className="space-y-1">
          {bblsByDriver.length > 0 && (
            <div className="bg-gray-900 rounded-lg p-3 border border-gray-700 mb-3">
              <div className="text-gray-400 text-[10px] font-bold uppercase tracking-wider mb-2">BBLs by Driver</div>
              <div className="space-y-1">
                {bblsByDriver.map(([name, bbls]) => (
                  <div key={name} className="flex items-center justify-between text-xs">
                    <span className="text-gray-300">{name}</span>
                    <span className="text-emerald-400 font-medium">{bbls.toLocaleString()} BBL</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {projectInvoices.length === 0 && (
            <div className="text-gray-500 text-sm text-center py-4">No tickets yet</div>
          )}
          {projectInvoices.map(inv => {
            const date = inv.createdAt?.toDate?.() || new Date();
            return (
              <div key={inv.id} className="bg-gray-900 border border-gray-700 rounded px-4 py-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-white font-medium">{inv.invoiceNumber || '—'}</span>
                  <span className="text-gray-500">·</span>
                  <span className="text-gray-400">{inv.driverName}</span>
                  <span className="text-gray-500">·</span>
                  <span className="text-gray-400">{inv.wellName}</span>
                  <span className="flex-1" />
                  <span className="text-emerald-400 font-medium">{inv.totalBarrels?.toLocaleString() || '—'} BBL</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-gray-500 mt-0.5">
                  <span>{date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  {inv.ticketCount ? <span>· {inv.ticketCount} ticket{inv.ticketCount !== 1 ? 's' : ''}</span> : null}
                  {inv.status && <span>· {inv.status}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Schedule tab */}
      {/* Drivers tab */}
      {detailTab === 'drivers' && (
        <div className="space-y-3">
          {/* Day / Night roster side by side */}
          <div className="grid grid-cols-2 gap-3">
            {/* Day shift */}
            <div>
              <div className="text-amber-400 text-[10px] font-bold uppercase tracking-wider mb-1.5">Day Shift ({(project.dayDriverHashes || []).length})</div>
              <div className="space-y-1">
                {(project.dayDriverHashes || []).map(hash => (
                  <DriverDisposalRow
                    key={hash}
                    hash={hash}
                    name={getDriverName(hash)}
                    disposal={project.driverDisposals?.[hash]}
                    borderColor="border-amber-600/20"
                    allDisposals={allDisposals}
                    onRemove={() => {
                      const updated = (project.dayDriverHashes || []).filter(h => h !== hash);
                      onUpdateProject?.(project.id!, { dayDriverHashes: updated });
                    }}
                    onSetDisposal={(disp) => {
                      onUpdateProject?.(project.id!, { [`driverDisposals.${hash}`]: disp || null });
                    }}
                  />
                ))}
                {(project.dayDriverHashes || []).length === 0 && <div className="text-gray-600 text-[10px] py-2">No day drivers</div>}
              </div>
            </div>
            {/* Night shift */}
            <div>
              <div className="text-blue-400 text-[10px] font-bold uppercase tracking-wider mb-1.5">Night Shift ({(project.nightDriverHashes || []).length})</div>
              <div className="space-y-1">
                {(project.nightDriverHashes || []).map(hash => (
                  <DriverDisposalRow
                    key={hash}
                    hash={hash}
                    name={getDriverName(hash)}
                    disposal={project.driverDisposals?.[hash]}
                    borderColor="border-blue-600/20"
                    allDisposals={allDisposals}
                    onRemove={() => {
                      const updated = (project.nightDriverHashes || []).filter(h => h !== hash);
                      onUpdateProject?.(project.id!, { nightDriverHashes: updated });
                    }}
                    onSetDisposal={(disp) => {
                      onUpdateProject?.(project.id!, { [`driverDisposals.${hash}`]: disp || null });
                    }}
                  />
                ))}
                {(project.nightDriverHashes || []).length === 0 && <div className="text-gray-600 text-[10px] py-2">No night drivers</div>}
              </div>
            </div>
          </div>

          {/* Add / move driver */}
          <div className="flex items-center gap-2 pt-2 border-t border-gray-700/50">
            <select value={addDriverShift} onChange={(e) => setAddDriverShift(e.target.value as 'day' | 'night')}
              className="px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-xs w-20">
              <option value="day">Day</option>
              <option value="night">Night</option>
            </select>
            <select
              value={addDriverHash}
              onChange={(e) => setAddDriverHash(e.target.value)}
              className="flex-1 px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-xs focus:outline-none focus:border-emerald-500"
            >
              <option value="">Add / move driver...</option>
              {drivers
                .filter(d => {
                  const targetList = addDriverShift === 'day' ? (project.dayDriverHashes || []) : (project.nightDriverHashes || []);
                  return !targetList.includes(d.key);
                })
                .map(d => {
                  const inDay = (project.dayDriverHashes || []).includes(d.key);
                  const inNight = (project.nightDriverHashes || []).includes(d.key);
                  const label = d.legalName || d.displayName;
                  return (
                    <option key={d.key} value={d.key}>
                      {label}{inDay ? ' (day → move)' : inNight ? ' (night → move)' : ''}
                    </option>
                  );
                })}
            </select>
            <button
              onClick={() => {
                if (!addDriverHash) return;
                const targetField = addDriverShift === 'day' ? 'dayDriverHashes' : 'nightDriverHashes';
                const otherField = addDriverShift === 'day' ? 'nightDriverHashes' : 'dayDriverHashes';
                const targetList = (addDriverShift === 'day' ? project.dayDriverHashes : project.nightDriverHashes) || [];
                const otherList = (addDriverShift === 'day' ? project.nightDriverHashes : project.dayDriverHashes) || [];
                const updates: Record<string, any> = {};
                if (otherList.includes(addDriverHash)) {
                  updates[otherField] = otherList.filter(h => h !== addDriverHash);
                }
                if (!targetList.includes(addDriverHash)) {
                  updates[targetField] = [...targetList, addDriverHash];
                }
                if (Object.keys(updates).length > 0) {
                  onUpdateProject?.(project.id!, updates);
                }
                const isNew = !(project.dayDriverHashes || []).includes(addDriverHash) && !(project.nightDriverHashes || []).includes(addDriverHash);
                if (isNew) onAddDriver(addDriverHash);
                setAddDriverHash('');
              }}
              disabled={!addDriverHash}
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs font-medium rounded transition-colors"
            >
              {addDriverHash && ((project.dayDriverHashes || []).includes(addDriverHash) || (project.nightDriverHashes || []).includes(addDriverHash)) ? 'Move' : 'Add'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Wrap in Suspense for useSearchParams
export default function DispatchPage() {
  return (
    <Suspense fallback={null}>
      <DispatchPageInner />
    </Suspense>
  );
}
