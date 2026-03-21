'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { WellResponse, subscribeToWellStatusesUnified } from '@/lib/wells';
import { AppHeader } from '@/components/AppHeader';
import { ref, get, set } from 'firebase/database';
import { getFirebaseDatabase } from '@/lib/firebase';
import { getFirestoreDb } from '@/lib/firebase';
import { collection, addDoc, getDocs, query, where, orderBy, Timestamp, doc, updateDoc, onSnapshot } from 'firebase/firestore';
import { loadDisposals, searchDisposals, type NdicWell } from '@/lib/firestoreWells';
import { loadCompanyById } from '@/lib/companySettings';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ApprovedDriver {
  key: string;           // passcodeHash
  displayName: string;
  legalName?: string;    // Real name from registration (e.g. "Michael Burger")
  active?: boolean;
  companyId?: string;
  companyName?: string;
  assignedRoutes?: string[];
}

interface DispatchJob {
  id?: string;
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
  status: 'pending' | 'pending_approval' | 'accepted' | 'in_progress' | 'paused' | 'completed' | 'cancelled';
  notes?: string;
  priority: number;
  assignedAt: any;  // Firestore Timestamp
  assignedBy: string;
  completedAt?: any;
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
  // Driver stage — written by WB T at each state transition
  driverStage?: 'en_route_pickup' | 'on_site_pickup' | 'en_route_dropoff' | 'on_site_dropoff' | 'paused' | 'completed';
  driverDest?: string;  // Where driver is heading (well name or SWD name)
  stageUpdatedAt?: any;
  // Live job info — written by WB T as driver progresses
  invoiceNumber?: string;  // Invoice # for this dispatch
  hauledTo?: string;  // Current drop-off destination (driver may change mid-job)
  // Driver-initiated job tracking (liveDispatchSync)
  source?: 'driver';  // Present when driver started the job (not dispatched)
  invoiceDocId?: string;  // Firestore invoice doc ID
}

// Priority levels for PW queue
type PriorityLevel = 'overdue' | 'soon' | 'today' | 'later' | 'unknown';

interface PriorityInfo {
  level: PriorityLevel;
  label: string;
  color: string;        // badge bg
  textColor: string;    // badge text
  sortOrder: number;     // lower = more urgent
  hoursUntilPull: number | null;
}

// ─── Priority Calculation ────────────────────────────────────────────────────

function getPriority(well: WellResponse): PriorityInfo {
  const isDown = well.isDown || well.currentLevel === 'DOWN';
  if (isDown) {
    return { level: 'unknown', label: 'DOWN', color: 'bg-gray-600', textColor: 'text-gray-300', sortOrder: 999, hoursUntilPull: null };
  }

  // Try nextPullTimeUTC first (most accurate)
  if (well.nextPullTimeUTC) {
    const pullTime = new Date(well.nextPullTimeUTC).getTime();
    if (!isNaN(pullTime)) {
      const now = Date.now();
      const hoursUntil = (pullTime - now) / (1000 * 60 * 60);

      if (hoursUntil <= 0) {
        return { level: 'overdue', label: 'OVERDUE', color: 'bg-red-600', textColor: 'text-white', sortOrder: 1, hoursUntilPull: hoursUntil };
      }
      if (hoursUntil <= 6) {
        return { level: 'soon', label: `${Math.round(hoursUntil)}h`, color: 'bg-orange-600', textColor: 'text-white', sortOrder: 2, hoursUntilPull: hoursUntil };
      }
      if (hoursUntil <= 24) {
        return { level: 'today', label: `${Math.round(hoursUntil)}h`, color: 'bg-yellow-600', textColor: 'text-white', sortOrder: 3, hoursUntilPull: hoursUntil };
      }
      const days = Math.floor(hoursUntil / 24);
      return { level: 'later', label: `${days}d+`, color: 'bg-green-700', textColor: 'text-white', sortOrder: 4, hoursUntilPull: hoursUntil };
    }
  }

  // Fallback: parse timeTillPull string
  const ttp = well.timeTillPull || well.etaToMax || '';
  if (ttp === 'Ready') {
    return { level: 'overdue', label: 'READY', color: 'bg-red-600', textColor: 'text-white', sortOrder: 1, hoursUntilPull: 0 };
  }

  // Parse "Xd Yh Zm" or "Yh Zm" format
  const dayMatch = ttp.match(/(\d+)d/);
  const hourMatch = ttp.match(/(\d+)h/);
  const minMatch = ttp.match(/(\d+)m/);
  let totalHours = 0;
  if (dayMatch) totalHours += parseInt(dayMatch[1]) * 24;
  if (hourMatch) totalHours += parseInt(hourMatch[1]);
  if (minMatch) totalHours += parseInt(minMatch[1]) / 60;

  if (totalHours > 0) {
    if (totalHours <= 6) {
      return { level: 'soon', label: `${Math.round(totalHours)}h`, color: 'bg-orange-600', textColor: 'text-white', sortOrder: 2, hoursUntilPull: totalHours };
    }
    if (totalHours <= 24) {
      return { level: 'today', label: `${Math.round(totalHours)}h`, color: 'bg-yellow-600', textColor: 'text-white', sortOrder: 3, hoursUntilPull: totalHours };
    }
    const days = Math.floor(totalHours / 24);
    return { level: 'later', label: `${days}d+`, color: 'bg-green-700', textColor: 'text-white', sortOrder: 4, hoursUntilPull: totalHours };
  }

  return { level: 'unknown', label: '--', color: 'bg-gray-600', textColor: 'text-gray-300', sortOrder: 5, hoursUntilPull: null };
}

// ─── Prediction Model ────────────────────────────────────────────────────────

interface WellPrediction {
  pullsPerDay: number | null;     // how many pulls needed per day
  hoursPerPull: number | null;    // hours between pulls at current flow rate
  driverLoad: 'low' | 'normal' | 'high' | 'critical' | null;
  warning: string | null;         // overflow risk warning text
}

function getWellPrediction(well: WellResponse): WellPrediction {
  const isDown = well.isDown || well.currentLevel === 'DOWN';
  if (isDown) return { pullsPerDay: null, hoursPerPull: null, driverLoad: null, warning: null };

  // Get bbls/day — prefer window average, fall back to 24hr
  const bblsDayStr = well.windowBblsDay || well.bbls24hrs || '';
  const bblsDay = parseFloat(bblsDayStr);
  if (!bblsDay || bblsDay <= 0) return { pullsPerDay: null, hoursPerPull: null, driverLoad: null, warning: null };

  // Get pull capacity
  const pullBbls = well.pullBbls || 140;

  // Pulls needed per day to keep up with production
  const pullsPerDay = bblsDay / pullBbls;

  // Hours between pulls (how often a truck needs to show up)
  const hoursPerPull = 24 / pullsPerDay;

  // Driver load classification
  let driverLoad: WellPrediction['driverLoad'] = 'low';
  let warning: string | null = null;

  if (pullsPerDay >= 3) {
    driverLoad = 'critical';
    warning = `${pullsPerDay.toFixed(1)} pulls/day — dedicated driver needed`;
  } else if (pullsPerDay >= 2) {
    driverLoad = 'high';
    warning = `${pullsPerDay.toFixed(1)} pulls/day — multiple visits required`;
  } else if (pullsPerDay >= 1.2) {
    driverLoad = 'normal';
    warning = null;  // normal single-pull-per-day range, no warning
  } else {
    driverLoad = 'low';
    warning = null;
  }

  return { pullsPerDay, hoursPerPull, driverLoad, warning };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatNextPull(well: WellResponse): string {
  if (!well.nextPullTime && !well.nextPullTimeUTC) return '--';
  try {
    const dateStr = well.nextPullTimeUTC || well.nextPullTime || '';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return well.nextPullTime || '--';
    return date.toLocaleString('en-US', {
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return well.nextPullTime || '--';
  }
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

// ─── Main Component ──────────────────────────────────────────────────────────

export default function DispatchPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Data state
  const [wells, setWells] = useState<WellResponse[]>([]);
  const [routes, setRoutes] = useState<string[]>([]);
  const [drivers, setDrivers] = useState<ApprovedDriver[]>([]);
  const [dispatches, setDispatches] = useState<DispatchJob[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [driversLoading, setDriversLoading] = useState(true);

  // UI state
  const [search, setSearch] = useState('');
  const [routeFilter, setRouteFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<PriorityLevel | 'all'>('all');
  const [message, setMessage] = useState('');

  // Assign modal state (single-well PW)
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignTarget, setAssignTarget] = useState<WellResponse | null>(null);
  const [assignDriverHash, setAssignDriverHash] = useState('');
  const [assignNotes, setAssignNotes] = useState('');
  const [assignDisposal, setAssignDisposal] = useState('');
  const [assignDisposalWell, setAssignDisposalWell] = useState<NdicWell | null>(null);
  const [assignLoadCount, setAssignLoadCount] = useState(1);
  const [disposalSearch, setDisposalSearch] = useState('');
  const [disposalResults, setDisposalResults] = useState<NdicWell[]>([]);
  const [allDisposals, setAllDisposals] = useState<NdicWell[]>([]);
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
  const [swServiceType, setSwServiceType] = useState('');
  const [swNotes, setSwNotes] = useState('');
  const [swDriverHashes, setSwDriverHashes] = useState<Set<string>>(new Set());
  const [swSubmitting, setSwSubmitting] = useState(false);

  // Add Pull form state
  const [pullWell, setPullWell] = useState('');
  const [pullLevel, setPullLevel] = useState('');
  const [pullWellSearch, setPullWellSearch] = useState('');
  const [showWellDropdown, setShowWellDropdown] = useState(false);
  const [pullBbls, setPullBbls] = useState('140');
  const [pullDateTime, setPullDateTime] = useState('');
  const [addingPull, setAddingPull] = useState(false);

  // Edit Service Work modal state
  const [editSwJob, setEditSwJob] = useState<DispatchJob | null>(null);
  const [editSwNotes, setEditSwNotes] = useState('');
  const [editSwAddDriverHashes, setEditSwAddDriverHashes] = useState<Set<string>>(new Set());
  const [editSwSaving, setEditSwSaving] = useState(false);

  // Dynamic service types from job packages (falls back to hardcoded)
  const FALLBACK_SERVICE_TYPES = ['Hot Shot', 'Equipment Delivery', 'Tank Cleanout', 'Flowback', 'Frac Water', 'Rig Move', 'Other'];
  const [dynamicServiceTypes, setDynamicServiceTypes] = useState<string[]>(FALLBACK_SERVICE_TYPES);
  // Map job type label → packageId (for stamping dispatch docs)
  const [jobTypeToPackageId, setJobTypeToPackageId] = useState<Record<string, string>>({});

  // Auth redirect
  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  // Subscribe to well data
  useEffect(() => {
    const unsubscribe = subscribeToWellStatusesUnified((wellData, routeList) => {
      setWells(wellData);
      setRoutes(routeList.filter(r => r !== 'Unrouted'));
      setDataLoading(false);
    });
    return unsubscribe;
  }, []);

  // Load drivers + disposals
  useEffect(() => {
    loadDriversData();
    loadDisposals().then(setAllDisposals).catch(() => {});
  }, []);

  // Load dynamic service types from company's active job packages
  useEffect(() => {
    if (!user) return;
    const loadPackageJobTypes = async () => {
      try {
        const companyId = user.companyId;
        if (!companyId) return; // WB admin — keep fallback list
        const company = await loadCompanyById(companyId);
        if (!company?.activePackages?.length) return; // no packages — keep fallback

        const firestore = getFirestoreDb();
        const snap = await getDocs(collection(firestore, 'job_packages'));
        const allJobTypes: string[] = [];
        const pkgMap: Record<string, string> = {};
        snap.forEach(d => {
          if (company.activePackages!.includes(d.id)) {
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
          }
        });

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
  }, [user]);

  // Subscribe to active dispatches in real-time
  useEffect(() => {
    const firestore = getFirestoreDb();
    const q = query(
      collection(firestore, 'dispatches'),
      where('status', 'in', ['pending', 'pending_approval', 'accepted', 'in_progress', 'paused']),
      orderBy('assignedAt', 'desc')
    );
    const unsub = onSnapshot(q, (snap) => {
      const jobs: DispatchJob[] = [];
      snap.forEach((d) => {
        jobs.push({ id: d.id, ...d.data() } as DispatchJob);
      });
      setDispatches(jobs);
    }, (err) => {
      console.error('Dispatch listener error:', err);
      // Fallback to one-time fetch
      loadDispatchesData();
    });
    return () => unsub();
  }, []);

  async function loadDriversData() {
    setDriversLoading(true);
    try {
      const db = getFirebaseDatabase();
      const approvedSnap = await get(ref(db, 'drivers/approved'));
      const approved: ApprovedDriver[] = [];

      if (approvedSnap.exists()) {
        const data = approvedSnap.val();
        Object.entries(data).forEach(([hash, val]: [string, any]) => {
          // Handle both flat and legacy nested formats
          if (val.displayName) {
            // Flat format
            if (val.active !== false) {
              approved.push({
                key: hash,
                displayName: val.displayName,
                legalName: val.legalName || val.profile?.legalName || '',
                active: val.active,
                companyId: val.companyId,
                companyName: val.companyName,
                assignedRoutes: val.assignedRoutes || [],
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
                  displayName: first.displayName,
                  legalName: first.legalName || first.profile?.legalName || '',
                  active: first.active,
                  companyId: first.companyId,
                  companyName: first.companyName,
                  assignedRoutes: first.assignedRoutes || [],
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
    } finally {
      setDriversLoading(false);
    }
  }

  async function loadDispatchesData() {
    try {
      const firestore = getFirestoreDb();
      const q = query(
        collection(firestore, 'dispatches'),
        where('status', 'in', ['pending', 'pending_approval', 'accepted', 'in_progress', 'paused']),
        orderBy('assignedAt', 'desc')
      );
      const snap = await getDocs(q);
      const jobs: DispatchJob[] = [];
      snap.forEach((d) => {
        jobs.push({ id: d.id, ...d.data() } as DispatchJob);
      });
      setDispatches(jobs);
    } catch (err) {
      console.error('Failed to load dispatches:', err);
      // Collection might not exist yet — that's fine
    }
  }

  // Set default datetime for Add Pull form
  useEffect(() => {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    setPullDateTime(local.toISOString().slice(0, 16));
  }, []);

  // ── Level parsing (same logic as WB T TicketForm) ──
  function parseLevelInput(input: string): number | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const apostropheMatch = trimmed.match(/^(\d+)'(\d+(?:\.\d+)?)"?$/);
    if (apostropheMatch) return parseInt(apostropheMatch[1], 10) + parseFloat(apostropheMatch[2]) / 12;
    const spaceMatch = trimmed.match(/^(\d+)\s+(\d+(?:\.\d+)?)$/);
    if (spaceMatch) return parseInt(spaceMatch[1], 10) + parseFloat(spaceMatch[2]) / 12;
    if (trimmed.includes('.') && !trimmed.includes(' ')) {
      const val = parseFloat(trimmed);
      return isNaN(val) ? null : val;
    }
    const val = parseInt(trimmed, 10);
    return isNaN(val) ? null : val;
  }

  function formatLevelDisplay(feet: number): string {
    const totalInches = Math.floor(feet * 12 + 0.0001);
    const ft = Math.floor(totalInches / 12);
    const inches = totalInches % 12;
    return `${ft}'${inches}"`;
  }

  const levelTimerRef = useRef<NodeJS.Timeout | null>(null);

  function handleLevelChange(value: string) {
    setPullLevel(value);
    if (levelTimerRef.current) clearTimeout(levelTimerRef.current);
    const trimmed = value.trim();

    // Space-separated: "13 7"
    const spaceMatch = trimmed.match(/^(\d+)\s+(\d+(?:\.\d+)?)$/);
    if (spaceMatch) {
      const inchStr = spaceMatch[2];
      const inchVal = parseFloat(inchStr);
      if (inchStr.length >= 2 || inchVal >= 2) {
        const parsed = parseLevelInput(trimmed);
        if (parsed !== null) setPullLevel(formatLevelDisplay(parsed));
        return;
      }
      levelTimerRef.current = setTimeout(() => {
        const parsed = parseLevelInput(trimmed);
        if (parsed !== null) setPullLevel(formatLevelDisplay(parsed));
      }, 600);
      return;
    }

    // Decimal: "12.4"
    const decimalMatch = trimmed.match(/^(\d+)\.(\d+)$/);
    if (decimalMatch) {
      levelTimerRef.current = setTimeout(() => {
        const parsed = parseLevelInput(trimmed);
        if (parsed !== null) setPullLevel(formatLevelDisplay(parsed));
      }, 600);
      return;
    }

    // Plain integer: "10"
    const intMatch = trimmed.match(/^(\d+)$/);
    if (intMatch) {
      levelTimerRef.current = setTimeout(() => {
        const parsed = parseLevelInput(trimmed);
        if (parsed !== null) setPullLevel(formatLevelDisplay(parsed));
      }, 600);
    }
  }

  // ─── Add Pull Handler ──────────────────────────────────────────────────────

  async function handleAddPull() {
    if (!pullWell) {
      setMessage('Select a well');
      setTimeout(() => setMessage(''), 3000);
      return;
    }
    if (!pullLevel.trim()) {
      setMessage('Enter tank level');
      setTimeout(() => setMessage(''), 3000);
      return;
    }
    if (addingPull) return;
    setAddingPull(true);

    try {
      const db = getFirebaseDatabase();
      const parsed = parseLevelInput(pullLevel);
      const levelFeet = parsed ?? 0;
      const dt = new Date(pullDateTime);
      const packetId = `${dt.toISOString().replace(/[-:T.]/g, '').slice(0, 14)}_${pullWell.replace(/\s/g, '')}_dashboard`;

      const packet = {
        packetId,
        wellName: pullWell,
        tankLevelFeet: levelFeet,
        bblsTaken: parseInt(pullBbls) || 0,
        dateTime: dt.toLocaleString(),
        dateTimeUTC: dt.toISOString(),
        driverName: user?.displayName || user?.email || 'Dashboard',
        driverId: user?.uid || 'dashboard',
        requestType: 'pull',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        wellDown: false,
      };

      await set(ref(db, `packets/incoming/${packetId}`), packet);
      setMessage(`Pull added for ${pullWell}`);

      // Reset form
      setPullLevel('');
      setPullBbls('140');
      const now = new Date();
      const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
      setPullDateTime(local.toISOString().slice(0, 16));
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      console.error('Error adding pull:', error);
      setMessage('Failed to add pull. Check connection and try again.');
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setAddingPull(false);
    }
  }

  // ─── PW Queue (sorted by priority) ──────────────────────────────────────────

  const pwQueue = useMemo(() => {
    // Filter out DOWN wells and wells with no data
    let filtered = wells.filter(w => {
      const isDown = w.isDown || w.currentLevel === 'DOWN';
      if (isDown) return false;
      if (w.currentLevel === '--' && !w.nextPullTimeUTC) return false;
      return true;
    });

    // Already-dispatched wells → list of assigned driver first names
    const dispatchedWellDrivers = new Map<string, string[]>();
    dispatches
      .filter(d => d.jobType === 'pw' && ['pending', 'accepted', 'in_progress', 'paused'].includes(d.status))
      .forEach(d => {
        const driversList = dispatchedWellDrivers.get(d.wellName) || [];
        driversList.push(d.driverFirstName || d.driverName || '?');
        dispatchedWellDrivers.set(d.wellName, driversList);
      });

    // Apply search filter
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(w =>
        w.wellName.toLowerCase().includes(q) ||
        (w.route || '').toLowerCase().includes(q)
      );
    }

    // Apply route filter
    if (routeFilter !== 'all') {
      filtered = filtered.filter(w => w.route === routeFilter);
    }

    // Apply priority filter
    if (priorityFilter !== 'all') {
      filtered = filtered.filter(w => getPriority(w).level === priorityFilter);
    }

    // Sort by priority: overdue first (sorted by most overdue), then soonest pull time
    return filtered
      .map(w => ({ well: w, priority: getPriority(w), dispatched: dispatchedWellDrivers.has(w.wellName), assignedDrivers: dispatchedWellDrivers.get(w.wellName) || [] }))
      .sort((a, b) => {
        // Already-dispatched go to bottom
        if (a.dispatched !== b.dispatched) return a.dispatched ? 1 : -1;
        // Then by priority level
        if (a.priority.sortOrder !== b.priority.sortOrder) return a.priority.sortOrder - b.priority.sortOrder;
        // Within same priority, sort by hours until pull (null = last)
        const aH = a.priority.hoursUntilPull ?? 99999;
        const bH = b.priority.hoursUntilPull ?? 99999;
        return aH - bH;
      });
  }, [wells, dispatches, search, routeFilter, priorityFilter]);

  // Priority summary counts
  const priorityCounts = useMemo(() => {
    const counts = { overdue: 0, soon: 0, today: 0, later: 0, unknown: 0 };
    wells.forEach(w => {
      if (w.isDown || w.currentLevel === 'DOWN') return;
      if (w.currentLevel === '--' && !w.nextPullTimeUTC) return;
      const p = getPriority(w);
      counts[p.level]++;
    });
    return counts;
  }, [wells]);

  // ─── Assign PW Job ─────────────────────────────────────────────────────────

  function openAssignModal(well: WellResponse) {
    setAssignTarget(well);
    setAssignDriverHash('');
    setAssignNotes('');
    setAssignLoadCount(1);
    setAssignDisposal('');
    setAssignDisposalWell(null);
    setDisposalSearch('');
    setDisposalResults([]);
    setShowAssignModal(true);
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

      const job: Omit<DispatchJob, 'id'> = {
        driverHash: assignDriverHash,
        driverName: driver.displayName,
        driverFirstName,
        wellName: assignTarget.wellName,
        ndicWellName: assignTarget.ndicName || assignTarget.wellName,
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

      await addDoc(collection(firestore, 'dispatches'), job);
      setMessage(`Dispatched ${assignTarget.wellName} to ${driver.legalName || driver.displayName}`);
      setShowAssignModal(false);
      setAssignTarget(null);
      setTimeout(() => setMessage(''), 4000);
    } catch (err: any) {
      setShowAssignModal(false);
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

      const promises = selectedDrivers.map(driver => {
        const job: Omit<DispatchJob, 'id'> = {
          driverHash: driver.key,
          driverName: driver.displayName,
          ...(driver.legalName ? { driverFirstName: getFirstName(driver) } : {}),
          wellName: matchedWell?.wellName || swWellName.trim(),
          ndicWellName: swNdicName,
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
        };
        return addDoc(collection(firestore, 'dispatches'), job);
      });

      await Promise.all(promises);
      const names = selectedDrivers.map(d => d.legalName || d.displayName).join(', ');
      setMessage(`Service work dispatched to ${names}`);
      setSwWellName('');
      setSwServiceType('');
      setSwNotes('');
      setSwDriverHashes(new Set());
      setTimeout(() => setMessage(''), 4000);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setSwSubmitting(false);
    }
  }

  // ─── Cancel Dispatch ───────────────────────────────────────────────────────

  async function cancelDispatch(jobId: string) {
    try {
      const firestore = getFirestoreDb();
      await updateDoc(doc(firestore, 'dispatches', jobId), {
        status: 'cancelled',
        cancelledAt: Timestamp.now(),
      });
      setMessage('Dispatch cancelled');
      setTimeout(() => setMessage(''), 3000);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    }
  }

  async function assignTransfer(jobId: string, driverHash: string, driverName: string) {
    try {
      const firestore = getFirestoreDb();
      const driver = drivers.find(d => d.key === driverHash);
      const driverFirstName = driver?.legalName ? driver.legalName.split(' ')[0] : driverName;
      await updateDoc(doc(firestore, 'dispatches', jobId), {
        driverHash,
        driverName,
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
    const selectableWells = pwQueue.map(q => q.well.wellName);

    if (selectableWells.every(w => selectedWells.has(w))) {
      // All selected → deselect all
      setSelectedWells(new Map());
    } else {
      // Select all
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
    if (selectedWells.size === 0 || !bulkDriverHash) return;
    setBulkDispatching(true);
    try {
      const driver = drivers.find(d => d.key === bulkDriverHash);
      if (!driver) throw new Error('Driver not found');
      const firestore = getFirestoreDb();

      // Create one dispatch doc per well with loadCount
      const promises: Promise<any>[] = [];
      selectedWells.forEach((loadCount, wellName) => {
        const well = wells.find(w => w.wellName === wellName);
        const priority = well ? getPriority(well) : { sortOrder: 5 };

        const driverFirstName = driver.legalName ? driver.legalName.split(' ')[0] : driver.displayName;
        const job: Omit<DispatchJob, 'id'> = {
          driverHash: bulkDriverHash,
          driverName: driver.displayName,
          driverFirstName,
          wellName,
          ndicWellName: well?.ndicName || wellName,
          route: well?.route || '',
          jobType: 'pw',
          status: 'pending',
          notes: bulkNotes || '',
          priority: priority.sortOrder,
          assignedAt: Timestamp.now(),
          assignedBy: user?.email || 'dashboard',
          estimatedPullTime: well?.nextPullTimeUTC || '',
          currentLevel: well?.currentLevel || '',
          flowRate: well?.flowRate || '',
          ...(loadCount > 1 ? { loadCount } : {}),
          ...(bulkDisposal ? {
            disposal: bulkDisposal,
            ...(bulkDisposalWell?.latitude ? { disposalLat: bulkDisposalWell.latitude } : {}),
            ...(bulkDisposalWell?.longitude ? { disposalLng: bulkDisposalWell.longitude } : {}),
            ...(bulkDisposalWell?.api_no ? { disposalApiNo: bulkDisposalWell.api_no } : {}),
            ...(bulkDisposalWell?.legal_desc ? { disposalLegalDesc: bulkDisposalWell.legal_desc } : {}),
            ...(bulkDisposalWell?.county ? { disposalCounty: bulkDisposalWell.county } : {}),
          } : {}),
        };
        promises.push(addDoc(collection(firestore, 'dispatches'), job));
      });

      await Promise.all(promises);
      setMessage(`Dispatched ${totalSelectedLoads} load${totalSelectedLoads !== 1 ? 's' : ''} across ${selectedWells.size} well${selectedWells.size !== 1 ? 's' : ''} to ${driver.legalName || driver.displayName}`);

      // Reset
      setSelectedWells(new Map());
      setBulkDriverHash('');
      setBulkNotes('');
      setBulkDisposal('');
      setBulkDisposalWell(null);
      setBulkDisposalSearch('');
      setBulkDisposalResults([]);
      setTimeout(() => setMessage(''), 5000);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setBulkDispatching(false);
    }
  }

  // ─── Edit Service Work Handlers ─────────────────────────────────────────────

  function openEditSwModal(job: DispatchJob) {
    setEditSwJob(job);
    setEditSwNotes(job.notes || '');
    setEditSwAddDriverHashes(new Set());
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

      // 1. Update notes on all group jobs
      if (editSwNotes !== (editSwJob.notes || '')) {
        const updatePromises = editSwGroupJobs.map(j => {
          if (!j.id) return Promise.resolve();
          return updateDoc(doc(firestore, 'dispatches', j.id), { notes: editSwNotes });
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
            await updateDoc(doc(firestore, 'dispatches', editSwJob.id), { serviceGroupId });
          }
        }

        // Build full crew list
        const allDrivers = [...editSwGroupJobs.map(j => j.driverFirstName || j.driverName), ...newDrivers.map(getFirstName)];

        // Create new dispatch docs for added drivers
        const addPromises = newDrivers.map(driver => {
          const job: Omit<DispatchJob, 'id'> = {
            driverHash: driver.key,
            driverName: driver.displayName,
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
          return addDoc(collection(firestore, 'dispatches'), job);
        });
        await Promise.all(addPromises);

        // Update assignedDrivers on all existing group jobs
        const updateCrewPromises = editSwGroupJobs.map(j => {
          if (!j.id) return Promise.resolve();
          return updateDoc(doc(firestore, 'dispatches', j.id), {
            assignedDrivers: allDrivers,
            ...(serviceGroupId && !j.serviceGroupId ? { serviceGroupId } : {}),
          });
        });
        await Promise.all(updateCrewPromises);
      }

      setMessage('Service work updated');
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
      const firestore = getFirestoreDb();
      await updateDoc(doc(firestore, 'dispatches', jobId), {
        status: 'cancelled',
        cancelledAt: Timestamp.now(),
      });
      setMessage('Driver assignment cancelled');
      setTimeout(() => setMessage(''), 3000);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
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
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <AppHeader />

      <main className="flex-1 flex flex-col px-4 py-4 overflow-hidden">

        {/* ═══════════════════════════════════════════════════════════════════════
            DISPATCH TOOLBAR — Always visible at top. Quick actions + inline forms.
            ═══════════════════════════════════════════════════════════════════════ */}
        <div className="flex-shrink-0 mb-4">
          {/* Top bar: title + priority badges + action buttons */}
          <div className="flex items-center gap-4 mb-3">
            <h2 className="text-lg font-semibold text-white flex-shrink-0">Dispatch</h2>

            {/* Priority badges */}
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {(['overdue', 'soon', 'today', 'later'] as const).map(level => {
                const cfg = {
                  overdue: { bg: 'bg-red-600', label: 'Overdue' },
                  soon:    { bg: 'bg-orange-600', label: 'Soon' },
                  today:   { bg: 'bg-yellow-600', label: 'Today' },
                  later:   { bg: 'bg-green-700', label: 'Later' },
                }[level];
                return (
                  <button
                    key={level}
                    onClick={() => setPriorityFilter(priorityFilter === level ? 'all' : level)}
                    className={`px-2 py-0.5 text-xs font-bold rounded ${cfg.bg} text-white ${priorityFilter === level ? 'ring-2 ring-white' : ''}`}
                  >
                    {priorityCounts[level]} {cfg.label}
                  </button>
                );
              })}
              {priorityFilter !== 'all' && (
                <button onClick={() => setPriorityFilter('all')} className="text-gray-400 hover:text-white text-xs">✕</button>
              )}
            </div>

            <span className="flex-1" />

            {/* Action buttons */}
            <button
              onClick={() => setToolbarMode(toolbarMode === 'sw' ? 'none' : 'sw')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5 ${
                toolbarMode === 'sw' ? 'bg-purple-600 text-white' : 'bg-gray-800 text-purple-400 hover:bg-gray-700 border border-gray-700'
              }`}
            >
              <span className="text-sm">+</span> Service Work
            </button>
            <button
              onClick={() => setToolbarMode(toolbarMode === 'pull' ? 'none' : 'pull')}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5 ${
                toolbarMode === 'pull' ? 'bg-green-600 text-white' : 'bg-gray-800 text-green-400 hover:bg-gray-700 border border-gray-700'
              }`}
            >
              <span className="text-sm">+</span> Add Pull
            </button>
          </div>

          {/* Expandable toolbar forms */}
          {toolbarMode === 'sw' && (
            <div className="bg-gray-800 border border-purple-600/40 rounded-lg p-4 mb-3">
              <div className="flex items-start gap-4">
                {/* Well search */}
                <div className="w-64 relative flex-shrink-0">
                  <label className="block text-xs text-gray-400 mb-1">Well / Location</label>
                  <input
                    type="text"
                    value={swWellName}
                    onChange={(e) => setSwWellName(e.target.value)}
                    placeholder="Type to search..."
                    className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-purple-500"
                  />
                  {swWellName.trim().length >= 2 && !wells.some(w => (w.ndicName || w.wellName) === swWellName.trim()) && wells.filter(w => (w.ndicName || w.wellName).toLowerCase().includes(swWellName.trim().toLowerCase())).length > 0 && (
                    <div className="absolute z-50 w-full mt-1 bg-gray-800 border border-gray-600 rounded max-h-48 overflow-y-auto shadow-lg">
                      {wells
                        .filter(w => (w.ndicName || w.wellName).toLowerCase().includes(swWellName.trim().toLowerCase()))
                        .slice(0, 12)
                        .map(w => (
                          <button key={w.wellName} type="button" onClick={() => setSwWellName(w.ndicName || w.wellName)}
                            className="w-full text-left px-3 py-1.5 hover:bg-gray-700 border-b border-gray-700/50 last:border-0 text-white text-sm">
                            {w.ndicName || w.wellName}
                            {w.route && <span className="text-gray-500 text-xs ml-2">{w.route}</span>}
                          </button>
                        ))
                      }
                    </div>
                  )}
                </div>

                {/* Service type */}
                <div className="w-44 flex-shrink-0">
                  <label className="block text-xs text-gray-400 mb-1">Service Type</label>
                  <select value={swServiceType} onChange={(e) => setSwServiceType(e.target.value)}
                    className="w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500">
                    <option value="">Select type...</option>
                    {dynamicServiceTypes.map(st => (
                      <option key={st} value={st}>{st}</option>
                    ))}
                  </select>
                </div>

                {/* Driver picker */}
                <div className="w-52 flex-shrink-0">
                  <label className="block text-xs text-gray-400 mb-1">
                    Driver{swDriverHashes.size > 1 ? 's' : ''}
                    {swDriverHashes.size > 0 && <span className="ml-1 px-1.5 py-0.5 bg-purple-600 text-white text-[10px] rounded-full">{swDriverHashes.size}</span>}
                  </label>
                  <div className="bg-gray-900 border border-gray-700 rounded max-h-24 overflow-y-auto">
                    {drivers.map(d => {
                      const checked = swDriverHashes.has(d.key);
                      return (
                        <button key={d.key} type="button" onClick={() => { setSwDriverHashes(prev => { const next = new Set(prev); if (next.has(d.key)) next.delete(d.key); else next.add(d.key); return next; }); }}
                          className={`w-full flex items-center gap-2 px-2 py-1 text-xs text-left border-b border-gray-800 last:border-0 transition-colors ${checked ? 'bg-purple-900/30 text-white' : 'text-gray-300 hover:bg-gray-800'}`}>
                          <input type="checkbox" checked={checked} readOnly className="w-3 h-3 rounded border-gray-600 bg-gray-800 text-purple-600 pointer-events-none" />
                          <span>{d.legalName || d.displayName}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Notes + dispatch button */}
                <div className="flex-1 min-w-0">
                  <label className="block text-xs text-gray-400 mb-1">Notes</label>
                  <div className="flex gap-2">
                    <input type="text" value={swNotes} onChange={(e) => setSwNotes(e.target.value)} placeholder="Instructions..."
                      className="flex-1 px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-purple-500" />
                    <button onClick={submitServiceWork}
                      disabled={!swWellName.trim() || !swServiceType || swDriverHashes.size === 0 || swSubmitting}
                      className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-xs font-medium rounded transition-colors whitespace-nowrap">
                      {swSubmitting ? 'Sending...' : 'Dispatch'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {toolbarMode === 'pull' && (
            <div className="bg-gray-800 border border-green-600/40 rounded-lg p-4 mb-3">
              <div className="flex items-end gap-4">
                <div className="w-48 flex-shrink-0 relative">
                  <label className="block text-xs text-gray-400 mb-1">Well</label>
                  <input
                    type="text"
                    value={pullWellSearch}
                    onChange={(e) => {
                      setPullWellSearch(e.target.value);
                      setPullWell('');
                      setShowWellDropdown(true);
                    }}
                    onFocus={() => setShowWellDropdown(true)}
                    placeholder="Search wells..."
                    className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-green-500"
                  />
                  {showWellDropdown && pullWellSearch && (
                    <div className="absolute z-50 top-full left-0 w-72 mt-1 bg-gray-900 border border-gray-600 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                      {[...new Set(wells.map(w => w.wellName))].sort()
                        .filter(w => w.toLowerCase().includes(pullWellSearch.toLowerCase()))
                        .slice(0, 10)
                        .map(w => (
                          <button key={w} onClick={() => { setPullWell(w); setPullWellSearch(w); setShowWellDropdown(false); }}
                            className="w-full text-left px-3 py-1.5 text-sm text-white hover:bg-gray-700 transition-colors">
                            {w}
                          </button>
                        ))
                      }
                    </div>
                  )}
                </div>
                <div className="w-32 flex-shrink-0">
                  <label className="block text-xs text-gray-400 mb-1">Level</label>
                  <input
                    type="text"
                    value={pullLevel}
                    onChange={(e) => handleLevelChange(e.target.value)}
                    onBlur={() => {
                      const raw = pullLevel.trim();
                      if (!raw || raw.includes("'") || raw.includes('"')) return;
                      const parsed = parseLevelInput(raw);
                      if (parsed !== null) setPullLevel(formatLevelDisplay(parsed));
                    }}
                    placeholder={`10'3"`}
                    className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-green-500"
                  />
                </div>
                <div className="w-24 flex-shrink-0">
                  <label className="block text-xs text-gray-400 mb-1">BBLs</label>
                  <input type="number" value={pullBbls} onChange={(e) => setPullBbls(e.target.value)} className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-green-500" />
                </div>
                <div className="w-52 flex-shrink-0">
                  <label className="block text-xs text-gray-400 mb-1">Date/Time</label>
                  <input type="datetime-local" value={pullDateTime} onChange={(e) => setPullDateTime(e.target.value)} className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-green-500" />
                </div>
                <button onClick={handleAddPull} disabled={addingPull}
                  className={`px-4 py-1.5 text-white rounded font-medium text-sm transition-colors whitespace-nowrap ${addingPull ? 'bg-green-800 cursor-wait' : 'bg-green-600 hover:bg-green-500'}`}>
                  {addingPull ? 'Adding...' : 'Add Pull'}
                </button>
              </div>
            </div>
          )}

          {/* Status message */}
          {message && (
            <div className={`p-2.5 rounded text-sm ${message.startsWith('Error') ? 'bg-red-900/50 text-red-200' : 'bg-blue-900/60 text-blue-200'}`}>
              {message}
            </div>
          )}
        </div>

        {/* ═══════════════════════════════════════════════════════════════════════
            MAIN WORKSPACE — 40/60 split. PW Queue left, Active Jobs right.
            Both panels scroll independently, flush tops.
            ═══════════════════════════════════════════════════════════════════════ */}
        <div className="flex-1 flex gap-4 min-h-0">

          {/* ═══════ LEFT PANEL (40%): PW Well Queue ═══════ */}
          <div className="w-[40%] flex-shrink-0 flex flex-col min-h-0">
            <div className="bg-gray-800 rounded-lg border border-gray-700 flex-1 flex flex-col overflow-hidden">
              {/* Panel header with filters */}
              <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-700 flex-shrink-0">
                <h3 className="text-sm font-semibold text-white flex-shrink-0">Well Queue</h3>
                <input
                  type="text"
                  placeholder="Search wells..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="px-2.5 py-1 bg-gray-900 border border-gray-700 rounded text-white text-xs placeholder-gray-500 focus:outline-none focus:border-blue-500 w-40"
                />
                <select value={routeFilter} onChange={(e) => setRouteFilter(e.target.value)}
                  className="px-2 py-1 bg-gray-900 border border-gray-700 rounded text-white text-xs focus:outline-none focus:border-blue-500">
                  <option value="all">All Routes</option>
                  {routes.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <span className="flex-1" />
                <span className="text-gray-500 text-xs">{pwQueue.length} wells</span>
              </div>

              {/* Bulk dispatch bar */}
              {selectedWells.size > 0 && (
                <div className="bg-blue-900/30 border-b border-blue-600/30 px-4 py-3 flex-shrink-0">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-white text-xs font-medium">
                      {selectedWells.size} well{selectedWells.size !== 1 ? 's' : ''} selected
                      {totalSelectedLoads !== selectedWells.size && <span className="text-blue-300 ml-1">({totalSelectedLoads} loads)</span>}
                    </span>
                    <span className="flex-1" />
                    <button onClick={() => setSelectedWells(new Map())} className="text-gray-400 hover:text-white text-xs">Clear</button>
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <select value={bulkDriverHash} onChange={(e) => setBulkDriverHash(e.target.value)}
                        className="w-full px-2 py-1 bg-gray-900 border border-gray-700 rounded text-white text-xs focus:outline-none focus:border-blue-500">
                        <option value="">Select driver...</option>
                        {drivers.map(d => <option key={d.key} value={d.key}>{d.legalName || d.displayName}</option>)}
                      </select>
                    </div>
                    <div className="relative flex-1">
                      {bulkDisposalWell ? (
                        <div className="flex items-center gap-1 px-2 py-1 bg-gray-900 border border-cyan-700 rounded">
                          <span className="text-cyan-400 text-xs flex-1 truncate">{bulkDisposal}</span>
                          <button onClick={() => { setBulkDisposal(''); setBulkDisposalWell(null); setBulkDisposalSearch(''); }} className="text-gray-400 hover:text-white text-[10px]">✕</button>
                        </div>
                      ) : (
                        <input type="text" value={bulkDisposalSearch}
                          onChange={(e) => { const val = e.target.value; setBulkDisposalSearch(val); setBulkDisposalResults(val.length >= 2 ? searchDisposals(val, allDisposals) : []); }}
                          placeholder="SWD (optional)..."
                          className="w-full px-2 py-1 bg-gray-900 border border-gray-700 rounded text-white text-xs placeholder-gray-500 focus:outline-none focus:border-blue-500" />
                      )}
                      {bulkDisposalResults.length > 0 && !bulkDisposalWell && (
                        <div className="absolute z-50 w-full mt-1 bg-gray-800 border border-gray-600 rounded max-h-32 overflow-y-auto shadow-lg">
                          {bulkDisposalResults.map((d, i) => (
                            <button key={d.api_no || i} onClick={() => { setBulkDisposal(d.well_name); setBulkDisposalWell(d); setBulkDisposalSearch(''); setBulkDisposalResults([]); }}
                              className="w-full text-left px-2 py-1.5 hover:bg-gray-700 border-b border-gray-700/50 last:border-0 text-white text-xs">
                              {d.well_name} <span className="text-gray-400">{d.operator}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button onClick={submitBulkDispatch} disabled={!bulkDriverHash || bulkDispatching}
                      className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-xs font-medium rounded transition-colors whitespace-nowrap">
                      {bulkDispatching ? '...' : `Dispatch ${totalSelectedLoads}`}
                    </button>
                  </div>
                </div>
              )}

              {/* Scrollable well table */}
              <div className="flex-1 overflow-y-auto overflow-x-auto">
                {dataLoading ? (
                  <div className="text-gray-400 py-8 text-center">Loading well data...</div>
                ) : pwQueue.length === 0 ? (
                  <div className="text-gray-400 py-8 text-center">No wells match filters</div>
                ) : (
                  <table className="w-full">
                    <thead className="bg-gray-700 sticky top-0 z-10">
                      <tr>
                        <th className="px-2 py-2 text-left text-[11px] font-medium text-gray-300 w-14">Priority</th>
                        <th className="px-2 py-2 text-left text-[11px] font-medium text-gray-300">Well</th>
                        <th className="px-2 py-2 text-left text-[11px] font-medium text-gray-300">Level</th>
                        <th className="px-2 py-2 text-left text-[11px] font-medium text-gray-300">Flow</th>
                        <th className="px-2 py-2 text-left text-[11px] font-medium text-gray-300">TTP</th>
                        <th className="px-2 py-2 text-left text-[11px] font-medium text-gray-300">Pulls/Day</th>
                        <th className="px-2 py-2 text-right text-[11px] font-medium text-gray-300 w-28">
                          <div className="flex items-center justify-end gap-1.5">
                            <span>Action</span>
                            <input type="checkbox" checked={pwQueue.length > 0 && pwQueue.every(q => selectedWells.has(q.well.wellName))} onChange={toggleSelectAll} className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer" />
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-700/50">
                      {pwQueue.map(({ well, priority, dispatched, assignedDrivers: wellAssignedDrivers }) => {
                        const isSelected = selectedWells.has(well.wellName);
                        const loadCount = selectedWells.get(well.wellName) || 1;
                        return (
                          <tr key={well.responseId || well.wellName} className={`hover:bg-gray-750 transition-colors ${priority.level === 'overdue' ? 'bg-red-900/10' : ''} ${isSelected ? 'bg-blue-900/20' : ''}`}>
                            <td className="px-2 py-1.5">
                              <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded ${priority.color} ${priority.textColor}`}>{priority.label}</span>
                            </td>
                            <td className="px-2 py-1.5">
                              <div className="text-white font-medium text-xs">{well.wellName}</div>
                              <div className="text-gray-500 text-[10px]">{well.route || 'Unrouted'}</div>
                              {wellAssignedDrivers.length > 0 && (
                                <div className="flex gap-1 mt-0.5">
                                  {wellAssignedDrivers.map((name, i) => (
                                    <span key={i} className="px-1 py-0 bg-blue-900/50 text-blue-300 text-[9px] font-medium rounded">{name}</span>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td className="px-2 py-1.5 text-white font-mono text-xs">{well.currentLevel || '--'}</td>
                            <td className="px-2 py-1.5 text-white font-mono text-[10px]">{well.flowRate || '--'}</td>
                            <td className="px-2 py-1.5 text-white font-mono text-[10px]">{well.timeTillPull || well.etaToMax || '--'}</td>
                            <td className="px-2 py-1.5"><PullsPredictionCell well={well} /></td>
                            <td className="px-2 py-1.5 text-right">
                              <div className="flex items-center justify-end gap-2">
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
                                  <button onClick={() => openAssignModal(well)} className="px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-medium rounded transition-colors">Assign</button>
                                )}
                                <input type="checkbox" checked={isSelected} onChange={() => toggleWellSelection(well.wellName)} className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer" />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>

          {/* ═══════ RIGHT PANEL (60%): Active Jobs ═══════ */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="bg-gray-800 rounded-lg border border-gray-700 flex-1 flex flex-col overflow-hidden">
              {/* Panel header */}
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 flex-shrink-0">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-white">Active Jobs</h3>
                  <span className="text-gray-500 text-xs">{activeDriverCount} driver{activeDriverCount !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {dispatches.filter(d => d.jobType === 'pw').length > 0 && (
                    <span className="px-1.5 py-0.5 bg-blue-600/20 text-blue-400 text-[10px] rounded font-bold">
                      {dispatches.filter(d => d.jobType === 'pw').length} PW
                    </span>
                  )}
                  {dispatches.filter(d => d.jobType === 'service').length > 0 && (
                    <span className="px-1.5 py-0.5 bg-purple-600/20 text-purple-400 text-[10px] rounded font-bold">
                      {dispatches.filter(d => d.jobType === 'service').length} SW
                    </span>
                  )}
                </div>
              </div>
              {/* Scrollable job list */}
              <div className="flex-1 overflow-y-auto p-3">
                <ActiveDispatchPanel
                  dispatches={dispatches}
                  cancelDispatch={cancelDispatch}
                  drivers={drivers}
                  assignTransfer={assignTransfer}
                  onEditServiceWork={openEditSwModal}
                />
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ═══════════════════════════════════════════════════════════════════════════
          ASSIGN MODAL (PW — unchanged)
          ═══════════════════════════════════════════════════════════════════════════ */}
      {showAssignModal && assignTarget && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 border border-gray-700">
            <h3 className="text-lg font-semibold text-white mb-1">Assign Job</h3>
            <p className="text-gray-400 text-sm mb-4">
              Dispatch <span className="text-white font-medium">{assignTarget.ndicName || assignTarget.wellName}</span> to a driver
            </p>

            {/* Well Info Summary */}
            <div className="bg-gray-900 rounded-lg p-3 mb-4 grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-gray-500">Level:</span>
                <span className="text-white ml-2 font-mono">{assignTarget.currentLevel || '--'}</span>
              </div>
              <div>
                <span className="text-gray-500">Flow Rate:</span>
                <span className="text-white ml-2 font-mono">{assignTarget.flowRate || '--'}</span>
              </div>
              <div>
                <span className="text-gray-500">Time Till Pull:</span>
                <span className="text-white ml-2 font-mono">{assignTarget.timeTillPull || assignTarget.etaToMax || '--'}</span>
              </div>
              <div>
                <span className="text-gray-500">Route:</span>
                <span className="text-white ml-2">{assignTarget.route || 'Unrouted'}</span>
              </div>
            </div>

            {/* Prediction Warning */}
            <ModalPredictionBanner well={assignTarget} />

            {/* Driver Select */}
            <div className="mb-4">
              <label className="block text-sm text-gray-400 mb-1">Assign to Driver</label>
              <select
                value={assignDriverHash}
                onChange={(e) => setAssignDriverHash(e.target.value)}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="">Select driver...</option>
                {/* Show drivers assigned to this route first */}
                {assignTarget.route && drivers.filter(d => d.assignedRoutes?.includes(assignTarget.route!)).length > 0 && (
                  <optgroup label={`Route: ${assignTarget.route}`}>
                    {drivers
                      .filter(d => d.assignedRoutes?.includes(assignTarget.route!))
                      .map(d => (
                        <option key={d.key} value={d.key}>{d.legalName || d.displayName}</option>
                      ))
                    }
                  </optgroup>
                )}
                <optgroup label="All Drivers">
                  {drivers.map(d => (
                    <option key={d.key} value={d.key}>{d.legalName || d.displayName}</option>
                  ))}
                </optgroup>
              </select>
            </div>

            {/* Disposal */}
            <div className="mb-4 relative">
              <label className="block text-sm text-gray-400 mb-1">Disposal Location (optional)</label>
              {assignDisposalWell ? (
                <div className="flex items-center gap-2 px-3 py-2 bg-gray-900 border border-cyan-700 rounded-lg">
                  <span className="text-cyan-400 text-sm flex-1 truncate">{assignDisposal}</span>
                  <span className="text-gray-500 text-xs">{assignDisposalWell.county || ''}</span>
                  <button
                    onClick={() => { setAssignDisposal(''); setAssignDisposalWell(null); setDisposalSearch(''); }}
                    className="text-gray-400 hover:text-white text-xs ml-1"
                  >&#10005;</button>
                </div>
              ) : (
                <input
                  type="text"
                  value={disposalSearch}
                  onChange={(e) => {
                    const val = e.target.value;
                    setDisposalSearch(val);
                    if (val.length >= 2) {
                      setDisposalResults(searchDisposals(val, allDisposals));
                    } else {
                      setDisposalResults([]);
                    }
                  }}
                  placeholder="Search SWD / disposal facilities..."
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              )}
              {disposalResults.length > 0 && !assignDisposalWell && (
                <div className="absolute z-50 w-full mt-1 bg-gray-800 border border-gray-600 rounded-lg max-h-48 overflow-y-auto shadow-lg">
                  {disposalResults.map((d, i) => (
                    <button
                      key={d.api_no || i}
                      onClick={() => {
                        setAssignDisposal(d.well_name);
                        setAssignDisposalWell(d);
                        setDisposalSearch('');
                        setDisposalResults([]);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-gray-700 border-b border-gray-700/50 last:border-0"
                    >
                      <span className="text-white text-sm">{d.well_name}</span>
                      <span className="text-gray-400 text-xs ml-2">{d.operator}</span>
                      {d.county && <span className="text-gray-500 text-xs ml-2">{d.county} Co.</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Loads + Notes side by side */}
            <div className="flex gap-3 mb-4">
              <div className="w-20">
                <label className="block text-sm text-gray-400 mb-1">Loads</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={assignLoadCount}
                  onChange={(e) => setAssignLoadCount(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm text-center focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex-1">
                <label className="block text-sm text-gray-400 mb-1">Notes (optional)</label>
                <input
                  type="text"
                  value={assignNotes}
                  onChange={(e) => setAssignNotes(e.target.value)}
                  placeholder="Special instructions..."
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            {/* Buttons */}
            <div className="flex gap-3">
              <button
                onClick={() => { setShowAssignModal(false); setAssignTarget(null); }}
                className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submitPWDispatch}
                disabled={!assignDriverHash || assigning}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
              >
                {assigning ? 'Dispatching...' : assignLoadCount > 1 ? `Dispatch ${assignLoadCount} Loads` : 'Dispatch'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════════
          EDIT SERVICE WORK MODAL
          ═══════════════════════════════════════════════════════════════════════════ */}
      {editSwJob && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-lg w-full mx-4 border border-gray-700 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Edit Service Work</h3>
              <button
                onClick={() => setEditSwJob(null)}
                className="text-gray-400 hover:text-white"
              >&#10005;</button>
            </div>

            {/* Job Info Header */}
            <div className="bg-gray-900 rounded-lg p-3 mb-4">
              <div className="flex items-center gap-2 mb-1">
                <span className="px-1.5 py-0.5 bg-purple-600/30 text-purple-300 text-[10px] font-bold rounded uppercase">
                  SW{editSwJob.serviceType ? ` · ${editSwJob.serviceType}` : ''}
                </span>
                <span className="text-white font-medium text-sm">{editSwJob.ndicWellName || editSwJob.wellName}</span>
              </div>
              <div className="text-gray-500 text-xs">
                Assigned {formatDispatchTime(editSwJob.assignedAt)} by {editSwJob.assignedBy}
              </div>
            </div>

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
                onClick={() => setEditSwJob(null)}
                className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveEditServiceWork}
                disabled={editSwSaving}
                className="flex-1 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
              >
                {editSwSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
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

function StageBadge({ job }: { job: DispatchJob }) {
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
    in_progress:       { bg: 'bg-purple-600/30',  text: 'text-purple-300', label: 'In Progress' },
    paused:            { bg: 'bg-amber-600/30',   text: 'text-amber-300',  label: 'Paused' },
  };

  // Use driver stage if available, otherwise fall back to dispatch status
  if (job.driverStage && stageConfig[job.driverStage]) {
    const cfg = stageConfig[job.driverStage];
    const dest = job.driverDest;
    return (
      <div className="flex items-center gap-1.5">
        <span className={`px-2 py-0.5 text-xs font-medium rounded ${cfg.bg} ${cfg.text}`}>
          {cfg.label}
        </span>
        {dest && (job.driverStage === 'en_route_pickup' || job.driverStage === 'en_route_dropoff') && (
          <span className="text-gray-500 text-xs truncate max-w-[140px]" title={dest}>{dest}</span>
        )}
      </div>
    );
  }

  const fb = statusFallback[job.status] || statusFallback.pending;
  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded ${fb.bg} ${fb.text} ${job.status === 'pending_approval' ? 'animate-pulse' : ''}`}>
      {fb.label}
    </span>
  );
}

// Job type badge — small colored tag
function JobTypeBadge({ type, serviceType }: { type: 'pw' | 'service'; serviceType?: string }) {
  if (type === 'service') {
    return (
      <span className="px-1.5 py-0.5 bg-purple-600/30 text-purple-300 text-[10px] font-bold rounded uppercase tracking-wider flex-shrink-0">
        SW{serviceType ? ` · ${serviceType}` : ''}
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 bg-blue-600/30 text-blue-300 text-[10px] font-bold rounded uppercase tracking-wider flex-shrink-0">
      PW
    </span>
  );
}

// Single job row — shows all info a dispatcher needs
function DispatchJobRow({ job, cancelDispatch, compact, onClickServiceWork }: {
  job: DispatchJob;
  cancelDispatch: (id: string) => void;
  compact?: boolean;
  onClickServiceWork?: (job: DispatchJob) => void;
}) {
  const dropoff = job.hauledTo || job.disposal;
  const isClickable = job.jobType === 'service' && !!onClickServiceWork;
  const ago = timeAgo(job.assignedAt);

  return (
    <div
      className={`${compact ? 'py-2 px-3' : 'py-3 px-4'} bg-gray-900/50 rounded-lg hover:bg-gray-900/80 transition-colors ${isClickable ? 'cursor-pointer' : ''}`}
      onClick={isClickable ? () => onClickServiceWork!(job) : undefined}
    >
      <div className="flex items-center gap-2">
        {/* Job type badge */}
        <JobTypeBadge type={job.jobType} serviceType={job.serviceType} />

        {/* Well name — primary info */}
        <span className="text-white font-medium text-sm truncate" style={{ minWidth: 100 }}>
          {job.ndicWellName || job.wellName}
        </span>

        {/* Load count — show remaining loads */}
        {(() => {
          const remaining = (job.loadCount || 1) - (job.loadsCompleted || 0);
          return remaining > 1 ? (
            <span className="px-1.5 py-0.5 bg-yellow-600/30 text-yellow-300 text-[10px] rounded font-bold flex-shrink-0">
              x{remaining}
            </span>
          ) : null;
        })()}

        {/* Transfer badge */}
        {job.type === 'transfer' && job.transferFromDriver && (
          <span className="px-1.5 py-0.5 bg-orange-600/30 text-orange-300 text-[10px] rounded font-medium flex-shrink-0">
            from {job.transferFromDriver}
          </span>
        )}

        {/* Driver-initiated badge (liveDispatchSync) */}
        {job.source === 'driver' && (
          <span className="px-1.5 py-0.5 bg-emerald-600/30 text-emerald-300 text-[10px] rounded font-medium flex-shrink-0">
            Driver Started
          </span>
        )}

        {/* Time since assigned */}
        {ago && (
          <span className="text-gray-600 text-[10px] flex-shrink-0">{ago}</span>
        )}

        <span className="flex-1" />

        {/* Stage badge */}
        <StageBadge job={job} />

        {/* Edit icon for service work */}
        {isClickable && (
          <span className="text-purple-400/60 hover:text-purple-300 text-xs flex-shrink-0" title="Edit service work">
            &#9998;
          </span>
        )}

        {/* Cancel button */}
        <button
          onClick={(e) => { e.stopPropagation(); job.id && cancelDispatch(job.id); }}
          className="text-red-400/60 hover:text-red-300 text-xs flex-shrink-0 transition-colors"
          title="Cancel dispatch"
        >&#10005;</button>
      </div>

      {/* Detail row — invoice #, drop-off, notes */}
      {(job.invoiceNumber || dropoff || job.notes) && (
        <div className="flex items-center gap-3 mt-1.5 ml-[42px] text-xs">
          {job.invoiceNumber && (
            <span className="text-gray-400">
              <span className="text-gray-600">#</span>{job.invoiceNumber}
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
function ActiveDispatchPanel({ dispatches, cancelDispatch, drivers, assignTransfer, onEditServiceWork }: {
  dispatches: DispatchJob[];
  cancelDispatch: (id: string) => void;
  drivers?: { key: string; displayName: string; legalName?: string }[];
  assignTransfer?: (jobId: string, driverHash: string, driverName: string) => void;
  onEditServiceWork?: (job: DispatchJob) => void;
}) {
  const [expandedDrivers, setExpandedDrivers] = useState<Set<string>>(new Set());

  // Unassigned transfers need driver assignment
  const unassigned = dispatches.filter(d => d.type === 'transfer' && (!d.driverHash || d.status === 'pending_approval'));
  const assigned = dispatches.filter(d => !(d.type === 'transfer' && (!d.driverHash || d.status === 'pending_approval')));

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

  // Group ALL jobs by driver — every dispatch shows in the driver's personal list
  // (multi-driver SW jobs also appear in Crew Jobs section for at-a-glance crew view)
  const grouped = useMemo(() => {
    const map = new Map<string, DispatchJob[]>();
    assigned.forEach(d => {
      const key = d.driverHash;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(d);
    });
    return new Map(
      Array.from(map.entries()).sort(([, a], [, b]) => {
        const aActive = a.filter(j => j.status !== 'pending').length;
        const bActive = b.filter(j => j.status !== 'pending').length;
        return bActive - aActive;
      })
    );
  }, [assigned]);

  function toggleDriver(hash: string) {
    setExpandedDrivers(prev => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }

  if (dispatches.length === 0) {
    return <div className="text-center text-gray-500 py-8">No active dispatches</div>;
  }

  return (
    <div className="space-y-3">
      {/* Unassigned transfers — urgent, pulsing */}
      {unassigned.map(job => (
        <UnassignedTransferRow key={job.id} job={job} drivers={drivers || []} assignTransfer={assignTransfer} cancelDispatch={cancelDispatch} />
      ))}

      {/* Driver cards (solo jobs + single-driver SW) */}
      {Array.from(grouped.entries()).map(([driverHash, jobs]) => {
        const autoExpand = jobs.length <= 2;
        const isExpanded = autoExpand || expandedDrivers.has(driverHash);
        const driverName = jobs[0].driverFirstName || jobs[0].driverName;
        const pwCount = jobs.filter(j => j.jobType === 'pw').length;
        const swCount = jobs.filter(j => j.jobType === 'service').length;

        const activeJob = jobs.find(j => j.driverStage && !['completed', 'paused'].includes(j.driverStage));
        const isPaused = jobs.some(j => j.driverStage === 'paused' || j.status === 'paused');
        const allPending = jobs.every(j => j.status === 'pending');

        const earliestAssigned = jobs.reduce((earliest, j) => {
          if (!j.assignedAt) return earliest;
          const ts = j.assignedAt.toDate ? j.assignedAt.toDate() : (j.assignedAt.seconds ? new Date(j.assignedAt.seconds * 1000) : new Date(j.assignedAt));
          if (!earliest || ts < earliest) return ts;
          return earliest;
        }, null as Date | null);
        const driverTimeAgo = earliestAssigned ? timeAgo({ toDate: () => earliestAssigned }) : '';

        return (
          <div key={driverHash} className="border border-gray-700/50 rounded-lg overflow-hidden">
            <button
              onClick={() => !autoExpand && toggleDriver(driverHash)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                allPending ? 'bg-gray-800/50' : 'bg-gray-800'
              } hover:bg-gray-750 ${autoExpand ? 'cursor-default' : 'cursor-pointer'}`}
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
                    <span className="px-1.5 py-0.5 bg-blue-600/20 text-blue-400 text-[10px] rounded font-bold">{pwCount} PW</span>
                  )}
                  {swCount > 0 && (
                    <span className="px-1.5 py-0.5 bg-purple-600/20 text-purple-400 text-[10px] rounded font-bold">{swCount} SW</span>
                  )}
                  {driverTimeAgo && <span className="text-gray-600 text-[10px]">{driverTimeAgo}</span>}
                </div>
                {!isExpanded && jobs.length > 2 && (
                  <div className="text-gray-500 text-xs mt-0.5 truncate">
                    {jobs.map(j => j.ndicWellName || j.wellName).join(' · ')}
                  </div>
                )}
              </div>

              {activeJob && <StageBadge job={activeJob} />}
              {!autoExpand && <span className="text-gray-500 text-xs flex-shrink-0">{isExpanded ? '▲' : '▼'}</span>}
            </button>

            {isExpanded && (
              <div className="space-y-1 p-2 bg-gray-900/30">
                {jobs.map(job => (
                  <DispatchJobRow
                    key={job.id}
                    job={job}
                    cancelDispatch={cancelDispatch}
                    compact={jobs.length > 2}
                    onClickServiceWork={job.jobType === 'service' ? onEditServiceWork : undefined}
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
    </div>
  );
}

// Row for unassigned transfer requests — pulsing orange, driver dropdown for dispatch to assign
function UnassignedTransferRow({ job, drivers, assignTransfer, cancelDispatch }: {
  job: DispatchJob;
  drivers: { key: string; displayName: string; legalName?: string }[];
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
        <button onClick={() => job.id && cancelDispatch(job.id)} className="text-red-400 hover:text-red-300 text-xs flex-shrink-0">&#10005;</button>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-orange-300 text-xs font-medium">{isPendingApproval ? 'Approve to:' : 'Assign to:'}</span>
        <select
          value={selectedHash}
          onChange={(e) => setSelectedHash(e.target.value)}
          className="flex-1 px-2 py-1 bg-gray-900 border border-gray-700 rounded text-white text-xs focus:outline-none focus:border-orange-500"
        >
          <option value="">Select driver...</option>
          {drivers.map(d => (
            <option key={d.key} value={d.key}>{d.legalName || d.displayName}</option>
          ))}
        </select>
        <button
          onClick={handleAssign}
          disabled={!selectedHash}
          className="px-3 py-1 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs font-medium rounded transition-colors"
        >
          {isPendingApproval ? 'Approve' : 'Assign'}
        </button>
      </div>
    </div>
  );
}
