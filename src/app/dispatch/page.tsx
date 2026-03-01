'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { WellResponse, subscribeToWellStatusesUnified } from '@/lib/wells';
import { AppHeader } from '@/components/AppHeader';
import { ref, get } from 'firebase/database';
import { getFirebaseDatabase } from '@/lib/firebase';
import { getFirestoreDb } from '@/lib/firebase';
import { collection, addDoc, getDocs, query, where, orderBy, Timestamp, doc, updateDoc, onSnapshot } from 'firebase/firestore';

// ─── Types ───────────────────────────────────────────────────────────────────

type SubTab = 'pw' | 'service';

interface ApprovedDriver {
  key: string;           // passcodeHash
  displayName: string;
  active?: boolean;
  companyId?: string;
  companyName?: string;
  assignedRoutes?: string[];
}

interface DispatchJob {
  id?: string;
  driverHash: string;
  driverName: string;
  wellName: string;
  operator?: string;
  route?: string;
  jobType: 'pw' | 'service';
  serviceType?: string;
  status: 'pending' | 'accepted' | 'in_progress' | 'paused' | 'completed' | 'cancelled';
  notes?: string;
  priority: number;
  assignedAt: any;  // Firestore Timestamp
  assignedBy: string;
  completedAt?: any;
  estimatedPullTime?: string;
  currentLevel?: string;
  flowRate?: string;
  disposal?: string;  // Pre-assigned SWD disposal location
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
  const [subTab, setSubTab] = useState<SubTab>('pw');
  const [search, setSearch] = useState('');
  const [routeFilter, setRouteFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<PriorityLevel | 'all'>('all');
  const [message, setMessage] = useState('');

  // Assign modal state
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignTarget, setAssignTarget] = useState<WellResponse | null>(null);
  const [assignDriverHash, setAssignDriverHash] = useState('');
  const [assignNotes, setAssignNotes] = useState('');
  const [assignDisposal, setAssignDisposal] = useState('');
  const [assigning, setAssigning] = useState(false);

  // Service work form state
  const [swWellName, setSwWellName] = useState('');
  const [swServiceType, setSwServiceType] = useState('');
  const [swNotes, setSwNotes] = useState('');
  const [swDriverHash, setSwDriverHash] = useState('');
  const [swSubmitting, setSwSubmitting] = useState(false);

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

  // Load drivers
  useEffect(() => {
    loadDrivers();
  }, []);

  // Subscribe to active dispatches in real-time
  useEffect(() => {
    const firestore = getFirestoreDb();
    const q = query(
      collection(firestore, 'dispatches'),
      where('status', 'in', ['pending', 'accepted', 'in_progress', 'paused']),
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
      loadDispatches();
    });
    return () => unsub();
  }, []);

  async function loadDrivers() {
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

  async function loadDispatches() {
    try {
      const firestore = getFirestoreDb();
      const q = query(
        collection(firestore, 'dispatches'),
        where('status', 'in', ['pending', 'accepted', 'in_progress', 'paused']),
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

  // ─── PW Queue (sorted by priority) ──────────────────────────────────────────

  const pwQueue = useMemo(() => {
    // Filter out DOWN wells and wells with no data
    let filtered = wells.filter(w => {
      const isDown = w.isDown || w.currentLevel === 'DOWN';
      if (isDown) return false;
      if (w.currentLevel === '--' && !w.nextPullTimeUTC) return false;
      return true;
    });

    // Already-dispatched well names (pending/active jobs)
    const dispatchedWells = new Set(
      dispatches.filter(d => d.jobType === 'pw' && ['pending', 'accepted', 'in_progress', 'paused'].includes(d.status))
        .map(d => d.wellName)
    );

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
      .map(w => ({ well: w, priority: getPriority(w), dispatched: dispatchedWells.has(w.wellName) }))
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
    setAssignDisposal('');
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

      const job: Omit<DispatchJob, 'id'> = {
        driverHash: assignDriverHash,
        driverName: driver.displayName,
        wellName: assignTarget.wellName,
        route: assignTarget.route || '',
        jobType: 'pw',
        status: 'pending',
        notes: assignNotes || '',
        priority: priority.sortOrder,
        assignedAt: Timestamp.now(),
        assignedBy: user?.email || 'dashboard',
        estimatedPullTime: assignTarget.nextPullTimeUTC || '',
        currentLevel: assignTarget.currentLevel || '',
        flowRate: assignTarget.flowRate || '',
        ...(assignDisposal ? { disposal: assignDisposal } : {}),
      };

      await addDoc(collection(firestore, 'dispatches'), job);
      setMessage(`Dispatched ${assignTarget.wellName} to ${driver.displayName}`);
      setShowAssignModal(false);
      setAssignTarget(null);
      await loadDispatches();
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
    if (!swWellName.trim() || !swServiceType.trim() || !swDriverHash) return;
    setSwSubmitting(true);
    try {
      const driver = drivers.find(d => d.key === swDriverHash);
      if (!driver) throw new Error('Driver not found');

      const firestore = getFirestoreDb();

      const job: Omit<DispatchJob, 'id'> = {
        driverHash: swDriverHash,
        driverName: driver.displayName,
        wellName: swWellName.trim(),
        jobType: 'service',
        serviceType: swServiceType.trim(),
        status: 'pending',
        notes: swNotes || '',
        priority: 5,
        assignedAt: Timestamp.now(),
        assignedBy: user?.email || 'dashboard',
      };

      await addDoc(collection(firestore, 'dispatches'), job);
      setMessage(`Service work dispatched to ${driver.displayName}`);
      setSwWellName('');
      setSwServiceType('');
      setSwNotes('');
      setSwDriverHash('');
      await loadDispatches();
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
      await loadDispatches();
      setTimeout(() => setMessage(''), 3000);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
      setTimeout(() => setMessage(''), 5000);
    }
  }

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
    <div className="min-h-screen bg-gray-900">
      <AppHeader />

      <main className="px-4 py-8">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <h2 className="text-xl font-semibold text-white">
            Dispatch
            <span className="text-gray-400 text-base font-normal ml-2">
              Job Assignment
            </span>
          </h2>

          {/* Priority Summary Badges */}
          <div className="flex items-center gap-2">
            <span className="text-gray-500 text-xs mr-1">Queue:</span>
            <button
              onClick={() => setPriorityFilter(priorityFilter === 'overdue' ? 'all' : 'overdue')}
              className={`px-2 py-0.5 text-xs font-bold rounded ${
                priorityFilter === 'overdue' ? 'ring-2 ring-white' : ''
              } bg-red-600 text-white`}
            >
              {priorityCounts.overdue} Overdue
            </button>
            <button
              onClick={() => setPriorityFilter(priorityFilter === 'soon' ? 'all' : 'soon')}
              className={`px-2 py-0.5 text-xs font-bold rounded ${
                priorityFilter === 'soon' ? 'ring-2 ring-white' : ''
              } bg-orange-600 text-white`}
            >
              {priorityCounts.soon} Soon
            </button>
            <button
              onClick={() => setPriorityFilter(priorityFilter === 'today' ? 'all' : 'today')}
              className={`px-2 py-0.5 text-xs font-bold rounded ${
                priorityFilter === 'today' ? 'ring-2 ring-white' : ''
              } bg-yellow-600 text-white`}
            >
              {priorityCounts.today} Today
            </button>
            <button
              onClick={() => setPriorityFilter(priorityFilter === 'later' ? 'all' : 'later')}
              className={`px-2 py-0.5 text-xs font-bold rounded ${
                priorityFilter === 'later' ? 'ring-2 ring-white' : ''
              } bg-green-700 text-white`}
            >
              {priorityCounts.later} Later
            </button>
            {priorityFilter !== 'all' && (
              <button
                onClick={() => setPriorityFilter('all')}
                className="text-gray-400 hover:text-white text-xs ml-1"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Status Message */}
        {message && (
          <div className={`mb-4 p-3 rounded text-sm ${
            message.startsWith('Error') ? 'bg-red-900/50 text-red-200' : 'bg-blue-900 text-blue-200'
          }`}>
            {message}
          </div>
        )}

        {/* Sub-Tab Toggle */}
        <div className="flex items-center gap-4 mb-6">
          <div className="flex bg-gray-800 rounded-lg p-1 border border-gray-700">
            <button
              onClick={() => setSubTab('pw')}
              className={`px-4 py-2 text-sm rounded-md font-medium transition-colors ${
                subTab === 'pw'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Production Water
            </button>
            <button
              onClick={() => setSubTab('service')}
              className={`px-4 py-2 text-sm rounded-md font-medium transition-colors ${
                subTab === 'service'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Service Work
            </button>
          </div>

          {/* Active Dispatches Count */}
          {dispatches.length > 0 && (
            <span className="text-gray-400 text-sm">
              {dispatches.length} active dispatch{dispatches.length !== 1 ? 'es' : ''}
            </span>
          )}
        </div>

        {/* ─── PW TAB ──────────────────────────────────────────────────────── */}
        {subTab === 'pw' && (
          <div>
            {/* Filters Row — full width above both columns */}
            <div className="flex flex-col sm:flex-row gap-3 mb-4">
              <input
                type="text"
                placeholder="Search wells..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 w-full sm:w-64"
              />
              <select
                value={routeFilter}
                onChange={(e) => setRouteFilter(e.target.value)}
                className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="all">All Routes</option>
                {routes.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>

            {/* Side-by-side: Queue + Active Dispatches */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Left: Well Queue */}
            <div className="min-w-0">
              {/* PW Queue Table */}
              {dataLoading ? (
                <div className="text-gray-400 py-8 text-center">Loading well data...</div>
              ) : pwQueue.length === 0 ? (
                <div className="text-gray-400 py-8 text-center">
                  No wells match current filters
                </div>
              ) : (
                <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-gray-700">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-300 w-16">Priority</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-300">Well</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-300">Route</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-300">Level</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-300">Flow Rate</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-300">Time Till Pull</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-300">Next Pull</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-300">BBLs/Day</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-300">Pulls/Day</th>
                          <th className="px-3 py-2 text-center text-xs font-medium text-gray-300 w-24">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-700">
                        {pwQueue.map(({ well, priority, dispatched }) => (
                          <tr
                            key={well.responseId || well.wellName}
                            className={`hover:bg-gray-750 transition-colors ${
                              dispatched ? 'opacity-50' : ''
                            } ${priority.level === 'overdue' ? 'bg-red-900/10' : ''}`}
                          >
                            <td className="px-3 py-2">
                              <span className={`px-2 py-0.5 text-xs font-bold rounded ${priority.color} ${priority.textColor}`}>
                                {priority.label}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-white font-medium text-sm">{well.wellName}</td>
                            <td className="px-3 py-2 text-gray-400 text-xs">{well.route || 'Unrouted'}</td>
                            <td className="px-3 py-2 text-white font-mono text-sm">{well.currentLevel || '--'}</td>
                            <td className="px-3 py-2 text-white font-mono text-xs">{well.flowRate || '--'}</td>
                            <td className="px-3 py-2 text-white font-mono text-xs">{well.timeTillPull || well.etaToMax || '--'}</td>
                            <td className="px-3 py-2 text-white font-mono text-xs">{formatNextPull(well)}</td>
                            <td className="px-3 py-2 text-white font-mono text-xs">{well.windowBblsDay || well.bbls24hrs || '--'}</td>
                            <td className="px-3 py-2"><PullsPredictionCell well={well} /></td>
                            <td className="px-3 py-2 text-center">
                              {dispatched ? (
                                <span className="text-blue-400 text-xs font-medium">Dispatched</span>
                              ) : (
                                <button
                                  onClick={() => openAssignModal(well)}
                                  className="px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded transition-colors"
                                >
                                  Assign
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Right: Active PW Dispatches — matching card like Service Work */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-6" style={{ minWidth: 340 }}>
              <h3 className="text-lg font-semibold text-white mb-4">
                Active Dispatches
                {dispatches.filter(d => d.jobType === 'pw').length > 0 && (
                  <span className="ml-2 px-2 py-0.5 bg-blue-600 text-white text-xs rounded-full">
                    {dispatches.filter(d => d.jobType === 'pw').length}
                  </span>
                )}
              </h3>
              {dispatches.filter(d => d.jobType === 'pw').length === 0 ? (
                <div className="text-center text-gray-500">No active dispatches</div>
              ) : (
                <ActiveDispatchTable dispatches={dispatches.filter(d => d.jobType === 'pw')} cancelDispatch={cancelDispatch} />
              )}
            </div>
            </div>
          </div>
        )}

        {/* ─── SERVICE WORK TAB ────────────────────────────────────────────── */}
        {subTab === 'service' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* New Service Work Form */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
              <h3 className="text-lg font-semibold text-white mb-4">New Service Work Job</h3>

              <div className="space-y-4">
                {/* Well/Location */}
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Well / Location</label>
                  <input
                    type="text"
                    value={swWellName}
                    onChange={(e) => setSwWellName(e.target.value)}
                    placeholder="Enter well name or location"
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                </div>

                {/* Service Type */}
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Service Type</label>
                  <select
                    value={swServiceType}
                    onChange={(e) => setSwServiceType(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
                  >
                    <option value="">Select service type...</option>
                    <option value="Hot Shot">Hot Shot</option>
                    <option value="Equipment Delivery">Equipment Delivery</option>
                    <option value="Tank Cleanout">Tank Cleanout</option>
                    <option value="Flowback">Flowback</option>
                    <option value="Frac Water">Frac Water</option>
                    <option value="Rig Move">Rig Move</option>
                    <option value="Other">Other</option>
                  </select>
                </div>

                {/* Assign to Driver */}
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Assign to Driver</label>
                  <select
                    value={swDriverHash}
                    onChange={(e) => setSwDriverHash(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
                  >
                    <option value="">Select driver...</option>
                    {drivers.map(d => (
                      <option key={d.key} value={d.key}>{d.displayName}</option>
                    ))}
                  </select>
                </div>

                {/* Notes */}
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Notes / Instructions</label>
                  <textarea
                    value={swNotes}
                    onChange={(e) => setSwNotes(e.target.value)}
                    placeholder="Special instructions, contact info, etc."
                    rows={3}
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
                  />
                </div>

                {/* Submit */}
                <button
                  onClick={submitServiceWork}
                  disabled={!swWellName.trim() || !swServiceType || !swDriverHash || swSubmitting}
                  className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
                >
                  {swSubmitting ? 'Dispatching...' : 'Dispatch Service Job'}
                </button>
              </div>
            </div>

            {/* Active Service Work Dispatches */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Active Service Jobs</h3>
              {dispatches.filter(d => d.jobType === 'service').length === 0 ? (
                <div className="text-center text-gray-500">
                  No active service jobs
                </div>
              ) : (
                <div className="space-y-3">
                  {dispatches.filter(d => d.jobType === 'service').map((job) => (
                    <div key={job.id} className="bg-gray-800 rounded-lg border border-gray-700 p-4">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <span className="text-white font-medium">{job.wellName}</span>
                          <span className="text-gray-500 text-sm ml-2">{job.serviceType}</span>
                        </div>
                        <StatusBadge status={job.status} />
                      </div>
                      <div className="text-sm text-gray-400 space-y-1">
                        <div>Driver: <span className="text-gray-300">{job.driverName}</span></div>
                        <div>Assigned: <span className="text-gray-300">{formatDispatchTime(job.assignedAt)}</span></div>
                        {job.notes && <div>Notes: <span className="text-gray-300">{job.notes}</span></div>}
                      </div>
                      {job.status === 'pending' && (
                        <button
                          onClick={() => job.id && cancelDispatch(job.id)}
                          className="mt-3 px-2 py-1 bg-red-600/30 hover:bg-red-600/50 text-red-300 text-xs rounded transition-colors"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* ─── ASSIGN MODAL ──────────────────────────────────────────────────── */}
      {showAssignModal && assignTarget && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 border border-gray-700">
            <h3 className="text-lg font-semibold text-white mb-1">Assign Job</h3>
            <p className="text-gray-400 text-sm mb-4">
              Dispatch <span className="text-white font-medium">{assignTarget.wellName}</span> to a driver
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
                        <option key={d.key} value={d.key}>{d.displayName}</option>
                      ))
                    }
                  </optgroup>
                )}
                <optgroup label="All Drivers">
                  {drivers.map(d => (
                    <option key={d.key} value={d.key}>{d.displayName}</option>
                  ))}
                </optgroup>
              </select>
            </div>

            {/* Disposal */}
            <div className="mb-4">
              <label className="block text-sm text-gray-400 mb-1">Disposal Location (optional)</label>
              <input
                type="text"
                value={assignDisposal}
                onChange={(e) => setAssignDisposal(e.target.value)}
                placeholder="e.g. Hydro Clear SWD, Nuverra..."
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
            </div>

            {/* Notes */}
            <div className="mb-4">
              <label className="block text-sm text-gray-400 mb-1">Notes (optional)</label>
              <textarea
                value={assignNotes}
                onChange={(e) => setAssignNotes(e.target.value)}
                placeholder="Special instructions..."
                rows={2}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
              />
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
                {assigning ? 'Dispatching...' : 'Dispatch'}
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

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-yellow-600/30 text-yellow-300',
    accepted: 'bg-blue-600/30 text-blue-300',
    in_progress: 'bg-purple-600/30 text-purple-300',
    paused: 'bg-amber-600/30 text-amber-300',
    completed: 'bg-green-600/30 text-green-300',
    cancelled: 'bg-gray-600/30 text-gray-400',
  };

  const labels: Record<string, string> = {
    pending: 'Pending',
    accepted: 'Accepted',
    in_progress: 'In Progress',
    paused: 'Paused',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };

  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded ${styles[status] || styles.pending}`}>
      {labels[status] || status}
    </span>
  );
}

// Active dispatch table with driver grouping — compact rows, driver badge + dropdown
function ActiveDispatchTable({ dispatches, cancelDispatch }: { dispatches: DispatchJob[]; cancelDispatch: (id: string) => void }) {
  const [expandedDriver, setExpandedDriver] = useState<string | null>(null);

  // Group dispatches by driver
  const grouped = useMemo(() => {
    const map = new Map<string, DispatchJob[]>();
    dispatches.forEach(d => {
      const key = d.driverHash;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(d);
    });
    return map;
  }, [dispatches]);

  return (
    <div className="space-y-1">
      {Array.from(grouped.entries()).map(([driverHash, jobs]) => {
        const isExpanded = expandedDriver === driverHash;
        const hasMultiple = jobs.length > 1;

        if (!hasMultiple) {
          // Single job — compact row
          const job = jobs[0];
          return (
            <div key={job.id} className="flex items-center gap-2 px-3 py-2 bg-gray-900/50 rounded hover:bg-gray-900/80 text-sm">
              <span className="text-white font-medium truncate flex-shrink-0" style={{ minWidth: 80 }}>{job.wellName}</span>
              <span className="text-gray-400 truncate flex-1">{job.driverName}</span>
              {job.disposal && <span className="text-cyan-400 text-xs truncate">&#8594; {job.disposal}</span>}
              <StatusBadge status={job.status} />
              {job.status === 'pending' && (
                <button onClick={() => job.id && cancelDispatch(job.id)} className="text-red-400 hover:text-red-300 text-xs flex-shrink-0">&#10005;</button>
              )}
            </div>
          );
        }

        // Multiple jobs for same driver — collapsible group
        return (
          <div key={driverHash}>
            <button
              onClick={() => setExpandedDriver(isExpanded ? null : driverHash)}
              className="w-full flex items-center gap-2 px-3 py-2 bg-gray-900/50 rounded hover:bg-gray-900/80 text-sm text-left"
            >
              <span className="text-white font-medium">{jobs[0].driverName}</span>
              <span className="px-1.5 py-0.5 bg-blue-600 text-white text-xs rounded-full font-bold">{jobs.length}</span>
              <span className="text-gray-500 text-xs flex-1 truncate">
                {jobs.map(j => j.wellName).join(', ')}
              </span>
              <span className="text-gray-500 text-xs">{isExpanded ? '▲' : '▼'}</span>
            </button>
            {isExpanded && (
              <div className="ml-4 mt-1 space-y-1">
                {jobs.map(job => (
                  <div key={job.id} className="flex items-center gap-2 px-3 py-1.5 bg-gray-800/50 rounded text-sm">
                    <span className="text-white truncate flex-shrink-0" style={{ minWidth: 80 }}>{job.wellName}</span>
                    {job.disposal && <span className="text-cyan-400 text-xs truncate">&#8594; {job.disposal}</span>}
                    <span className="flex-1" />
                    <StatusBadge status={job.status} />
                    {job.status === 'pending' && (
                      <button onClick={() => job.id && cancelDispatch(job.id)} className="text-red-400 hover:text-red-300 text-xs flex-shrink-0">&#10005;</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
