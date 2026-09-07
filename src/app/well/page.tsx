'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { canViewGlobalWellPool } from '@/lib/tenantScope';
import { WellPoolEmptyState } from '@/components/WellPoolEmptyState';
import { canEditPull, canDeletePull } from '@/lib/auth';
import {
  PullPacket,
  WellResponse,
  WellNavItem,
  fetchWellHistoryUnified,
  fetchEditHistory,
  editPull,
  subscribeToWellNavList,
} from '@/lib/wells';
import { deletePull, movePull, describeCorrectionError } from '@/lib/pullCorrection';
import {
  packetShowsEditBadge,
  formatEditSourceLabel,
  formatFieldLabel,
  formatChangeValue,
} from '@/lib/editMarkers';
import { getDatabase, ref, onValue, get } from 'firebase/database';
import { getFirebaseApp } from '@/lib/firebase';
import Link from 'next/link';
import { AppHeader } from '@/components/AppHeader';
import { AddPullModal, type ApprovedDriver } from '@/components/AddPullModal';
import { getFirebaseDatabase } from '@/lib/firebase';
import { loadDisposals, type NdicWell } from '@/lib/firestoreWells';

// Format inches to feet'inches" display
function formatLevelFtIn(inches: number | undefined): string {
  if (inches === undefined || isNaN(inches)) return '--';
  const totalInches = Math.floor(inches);
  const feet = Math.floor(totalInches / 12);
  const remainingInches = totalInches % 12;
  return `${feet}'${remainingInches}"`;
}

// Calculate 1" flow rate from 1' flow rate (divide by 12)
// Input: flowRateMinutes = minutes per foot
// Output: H:MM:SS when >= 60 min, M:SS when < 60 min
function formatOneInchFlowRate(flowRateMinutes: number | undefined): string {
  if (!flowRateMinutes || flowRateMinutes <= 0) return '--';
  const minutesPerInch = flowRateMinutes / 12;
  const totalSecs = Math.round(minutesPerInch * 60);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Parse H:M:S flow rate string to minutes per foot
function parseFlowRateToMinutes(flowRate: string | undefined): number {
  if (!flowRate || flowRate === '--' || flowRate === 'Unknown') return 0;
  const parts = flowRate.split(':');
  if (parts.length === 3) {
    // H:M:S format
    const hours = parseInt(parts[0]) || 0;
    const mins = parseInt(parts[1]) || 0;
    const secs = parseInt(parts[2]) || 0;
    return hours * 60 + mins + secs / 60;
  } else if (parts.length === 2) {
    // H:M format
    const hours = parseInt(parts[0]) || 0;
    const mins = parseInt(parts[1]) || 0;
    return hours * 60 + mins;
  }
  return 0;
}

export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-900 flex items-center justify-center"><div className="text-white text-xl">Loading...</div></div>}>
      <WellDetailPage />
    </Suspense>
  );
}

function WellDetailPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const wellName = searchParams.get('name') || '';

  const [pulls, setPulls] = useState<PullPacket[]>([]);
  const [wellStatus, setWellStatus] = useState<WellResponse | null>(null);
  const [wellTanks, setWellTanks] = useState<number>(1);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState('');

  // Edit modal state
  const [editingPull, setEditingPull] = useState<PullPacket | null>(null);
  const [editLevel, setEditLevel] = useState('');
  const [editBbls, setEditBbls] = useState('');
  const [editDateTime, setEditDateTime] = useState('');
  const [editWellDown, setEditWellDown] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);

  // Correction trail (badge expand) — packets/editHistory/{packetId}
  const [trailOpenId, setTrailOpenId] = useState<string | null>(null);
  const [trailLoading, setTrailLoading] = useState(false);
  const [trailEvents, setTrailEvents] = useState<
    Array<{
      eventId: string;
      sequence: number;
      editedAt: string;
      source: string;
      fields: Array<{ field: string; previous: unknown; next: unknown }>;
    }>
  >([]);

  const toggleEditTrail = async (packetId: string) => {
    if (trailOpenId === packetId) {
      setTrailOpenId(null);
      setTrailEvents([]);
      return;
    }
    setTrailOpenId(packetId);
    setTrailLoading(true);
    try {
      const events = await fetchEditHistory(packetId);
      setTrailEvents(events);
    } catch {
      setTrailEvents([]);
    } finally {
      setTrailLoading(false);
    }
  };

  // Delete confirmation state
  const [deletingPull, setDeletingPull] = useState<PullPacket | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  // Governed "move to correct well" correction
  const [movingPull, setMovingPull] = useState<PullPacket | null>(null);
  const [moveTargetWell, setMoveTargetWell] = useState<string | null>(null);
  const [moveSubmitting, setMoveSubmitting] = useState(false);
  const [showMoveTargetPicker, setShowMoveTargetPicker] = useState(false);
  const [moveSearchQuery, setMoveSearchQuery] = useState('');

  // Well navigation list (all wells for prev/next + picker)
  const [allWells, setAllWells] = useState<WellNavItem[]>([]);
  const [showWellPicker, setShowWellPicker] = useState(false);
  const [wellSearchQuery, setWellSearchQuery] = useState('');

  // Add Pull modal
  const [showAddPull, setShowAddPull] = useState(false);
  const [addPullDrivers, setAddPullDrivers] = useState<ApprovedDriver[]>([]);
  const [addPullDisposals, setAddPullDisposals] = useState<NdicWell[]>([]);

  // Service work toggle
  const [showServiceWork, setShowServiceWork] = useState(false);
  const swCount = pulls.filter(p => p.noLevel).length;
  const filteredPulls = showServiceWork ? pulls : pulls.filter(p => !p.noLevel);

  // Current time tick for live level estimation
  const [currentTime, setCurrentTime] = useState(Date.now());

  // Tick every 30 seconds for live level updates
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // Calculate estimated current level based on time elapsed + flow rate
  // Use lastPullDateTimeUTC (actual pull time), NOT timestampUTC (response generation time)
  const estimatedCurrentLevel = (() => {
    if (!wellStatus || wellStatus.isDown || wellStatus.wellDown) return null;

    // Parse timestamp — use last pull time, not response timestamp
    const lastPullTimeStr = wellStatus.lastPullDateTimeUTC || wellStatus.timestampUTC;
    const lastPullTime = lastPullTimeStr
      ? new Date(lastPullTimeStr).getTime()
      : null;

    if (!lastPullTime || isNaN(lastPullTime)) return null;

    // Parse flow rate from H:M:S format
    const flowRateMinutes = parseFlowRateToMinutes(wellStatus.flowRate);
    if (!flowRateMinutes || flowRateMinutes <= 0) return null;

    // Parse current level (which is bottom level after pull) from feet'inches" format
    const levelMatch = wellStatus.currentLevel?.match(/(\d+)'(\d+)"/);
    if (!levelMatch) return null;
    const bottomLevelInches = parseInt(levelMatch[1]) * 12 + parseInt(levelMatch[2]);

    // Calculate inches risen since last pull
    // flowRateMinutes is minutes per FOOT, so divide by 12 to get minutes per inch
    const minutesElapsed = (currentTime - lastPullTime) / (1000 * 60);
    const minutesPerInch = flowRateMinutes / 12;
    const inchesRisen = minutesElapsed / minutesPerInch;

    // Current estimated level (cap at 20 feet = 240 inches)
    const estimatedInches = Math.min(bottomLevelInches + inchesRisen, 240);

    return estimatedInches;
  })();

  // Subscribe to well nav list for prev/next navigation
  useEffect(() => {
    const unsubscribe = subscribeToWellNavList((wells) => {
      setAllWells(wells);
    });
    return unsubscribe;
  }, []);

  // Compute prev/next wells
  const currentIndex = allWells.findIndex((w) => w.wellName === wellName);
  const prevWell = currentIndex > 0 ? allWells[currentIndex - 1] : null;
  const nextWell = currentIndex < allWells.length - 1 ? allWells[currentIndex + 1] : null;

  // Subscribe to well status for real-time current level updates
  // Reads from packets/outgoing which is where Cloud Functions write responses
  useEffect(() => {
    if (!wellName) return;

    const app = getFirebaseApp();
    const db = getDatabase(app);
    const outgoingRef = ref(db, 'packets/outgoing');

    const unsubscribe = onValue(outgoingRef, (snapshot) => {
      if (snapshot.exists()) {
        // Find the response for this well (response keys include well name)
        const wellNameClean = wellName.replace(/\s/g, '');
        snapshot.forEach((child) => {
          const key = child.key || '';
          const data = child.val();
          // Match response_*_{wellName} pattern
          if (key.startsWith('response_') && data.wellName === wellName) {
            setWellStatus(data as WellResponse);
          }
        });
      }
    }, () => {
      import('@/lib/adminDashboardCatalog').then(({ adminGetWellPool }) =>
        adminGetWellPool().then((pool) => {
          const st = pool.wellStatus?.[wellName];
          if (st && typeof st === 'object') setWellStatus(st as WellResponse);
        })
      ).catch(() => {});
    });

    return () => unsubscribe();
  }, [wellName]);

  // Fetch well_config for tanks count
  useEffect(() => {
    if (!wellName) return;
    const app = getFirebaseApp();
    const db = getDatabase(app);
    const configRef = ref(db, `well_config/${wellName}`);
    const unsubscribe = onValue(configRef, (snapshot) => {
      if (snapshot.exists()) {
        const config = snapshot.val();
        setWellTanks(config.tanks || config.numTanks || 1);
      }
    }, () => {
      import('@/lib/adminDashboardCatalog').then(({ adminGetWellPool }) =>
        adminGetWellPool().then((pool) => {
          const config = pool.wellConfig?.[wellName] as { tanks?: number; numTanks?: number } | undefined;
          if (config) setWellTanks(config.tanks || config.numTanks || 1);
        })
      ).catch(() => {});
    });
    return () => unsubscribe();
  }, [wellName]);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  // Fetch well history (once on mount, manual refresh via button)
  useEffect(() => {
    if (!wellName) return;

    console.log('[WellDetail] useEffect fired - fetching history for:', wellName);

    let cancelled = false;

    const loadData = async () => {
      try {
        setDataLoading(true);
        const history = await fetchWellHistoryUnified(wellName);
        if (!cancelled) {
          setPulls(history);
          setError('');
        }
      } catch (err) {
        console.error('Error fetching well history:', err);
        if (!cancelled) {
          setError('Failed to load well history');
        }
      } finally {
        if (!cancelled) {
          setDataLoading(false);
        }
      }
    };

    loadData();

    // No auto-refresh - current level estimate updates via tick timer
    // User can manually refresh via button if needed
    return () => {
      cancelled = true;
    };
  }, [wellName]);

  // Manual refresh button handler
  const handleRefresh = async () => {
    try {
      setDataLoading(true);
      const history = await fetchWellHistoryUnified(wellName);
      setPulls(history);
      setError('');
    } catch (err) {
      console.error('Error fetching well history:', err);
      setError('Failed to load well history');
    } finally {
      setDataLoading(false);
    }
  };

  // Convert inches to "feet inches" input format (e.g. 75 → "6 3")
  const inchesToInput = (totalInches: number): string => {
    const rounded = Math.floor(totalInches + 0.0001);
    const ft = Math.floor(rounded / 12);
    const inches = rounded % 12;
    return `${ft} ${inches}`;
  };

  // Parse "feet inches" or "feet'inches" input back to total inches
  const parseEditLevel = (input: string): number => {
    const trimmed = input.trim();
    // "6 3" or "6'3" or "6'3\"" → 75 inches
    const match = trimmed.match(/^(\d+)[\s']+(\d+)"?$/);
    if (match) return parseInt(match[1]) * 12 + parseInt(match[2]);
    // Plain number — treat as feet: "6" → 72 inches
    const plain = parseInt(trimmed, 10);
    if (!isNaN(plain) && trimmed.length <= 2) return plain * 12;
    // Already inches (larger number)
    return Number(trimmed) || 0;
  };

  // Hint for level input
  const getEditLevelHint = (): string => {
    if (!editLevel.trim()) return '';
    const inches = parseEditLevel(editLevel);
    if (inches <= 0) return '';
    const ft = Math.floor(inches / 12);
    const rem = inches % 12;
    return `= ${ft}'${rem}"`;
  };

  const handleEdit = (pull: PullPacket) => {
    setEditingPull(pull);
    setEditLevel(inchesToInput(pull.tankTopLevel));
    setEditBbls(String(pull.bblsTaken));
    // Convert ISO timestamp to datetime-local format (YYYY-MM-DDTHH:MM)
    const dt = new Date(pull.timestamp);
    if (!isNaN(dt.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0');
      const local = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
      setEditDateTime(local);
    } else {
      setEditDateTime('');
    }
    setEditWellDown(pull.wellDown || false);
  };

  const submitEdit = async () => {
    if (!editingPull) return;

    setEditSubmitting(true);
    try {
      // Check if date/time was changed
      const origDt = new Date(editingPull.timestamp);
      const newDt = editDateTime ? new Date(editDateTime) : null;
      const dateTimeChanged = newDt && !isNaN(newDt.getTime()) && newDt.getTime() !== origDt.getTime();

      await editPull(
        editingPull.packetId,
        editingPull.wellName,
        parseEditLevel(editLevel),
        Number(editBbls),
        dateTimeChanged ? newDt.toISOString() : undefined,
        editWellDown
      );
      // Refresh data
      const history = await fetchWellHistoryUnified(wellName);
      setPulls(history);
      setEditingPull(null);
    } catch (err) {
      console.error('Error editing pull:', err);
      setError('Failed to edit pull');
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleDelete = (pull: PullPacket) => {
    setError('');
    setDeletingPull(pull);
  };

  const confirmDelete = async () => {
    if (!deletingPull) return;

    setDeleteSubmitting(true);
    try {
      // Governed correction — success only after the server acknowledges.
      await deletePull(deletingPull.packetId, deletingPull.wellName);
      // Refresh data
      const history = await fetchWellHistoryUnified(wellName);
      setPulls(history);
      setDeletingPull(null);
    } catch (err) {
      console.error('Error deleting pull:', err);
      setError(describeCorrectionError(err));
    } finally {
      setDeleteSubmitting(false);
    }
  };

  // Move a load entered on the wrong well to the correct well (governed).
  const handleMove = (pull: PullPacket) => {
    setError('');
    setMovingPull(pull);
    setMoveTargetWell(null);
    setMoveSearchQuery('');
    // A move supersedes an in-progress delete of the same row.
    setDeletingPull(null);
  };

  const confirmMove = async () => {
    if (!movingPull || !moveTargetWell) return;

    setMoveSubmitting(true);
    try {
      await movePull(movingPull.packetId, movingPull.wellName, moveTargetWell);
      const history = await fetchWellHistoryUnified(wellName);
      setPulls(history);
      setMovingPull(null);
      setMoveTargetWell(null);
    } catch (err) {
      console.error('Error moving pull:', err);
      setError(describeCorrectionError(err));
    } finally {
      setMoveSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  // Tenant containment (7/9): scoped non-Liquid-Gold companies must not see
  // the global well pool (it is Liquid Gold's operational data — see
  // lib/tenantScope.ts). Unscoped WB admins and liquid-gold keep the view.
  if (!canViewGlobalWellPool(user)) {
    return (
      <div className="min-h-screen bg-gray-900">
        <AppHeader />
        <main className="max-w-7xl mx-auto px-4 py-8">
          <WellPoolEmptyState />
        </main>
      </div>
    );
  }

  const userCanDelete = canDeletePull(user);

  return (
    <div className="min-h-screen bg-gray-900">
      <AppHeader />
      {/* Well Navigation Header */}
      <div className="bg-gray-800/50 border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            {/* Back button - separated from well nav */}
            <Link href="/mobile" className="text-gray-400 hover:text-white transition-colors text-sm mr-8 shrink-0">
              ← Routes
            </Link>

            {/* Well name with prev/next arrows */}
            <div className="flex items-center gap-3 flex-1 justify-center min-w-0">
              {prevWell ? (
                <Link
                  href={`/well?name=${encodeURIComponent(prevWell.wellName)}`}
                  className="text-gray-400 hover:text-white transition-colors text-xl px-2 shrink-0"
                  title={prevWell.wellName}
                >
                  ‹
                </Link>
              ) : (
                <span className="text-gray-700 text-xl px-2 shrink-0">‹</span>
              )}

              <div className="flex flex-col items-center min-w-0">
                <button
                  onClick={() => { setShowWellPicker(true); setWellSearchQuery(''); }}
                  className="text-lg font-semibold text-white hover:text-blue-400 transition-colors cursor-pointer truncate"
                  title="Click to browse all wells"
                >
                  {wellName}
                </button>
                {wellTanks > 1 && (
                  <span className="text-xs text-gray-400">{wellTanks} tanks</span>
                )}
              </div>

              {nextWell ? (
                <Link
                  href={`/well?name=${encodeURIComponent(nextWell.wellName)}`}
                  className="text-gray-400 hover:text-white transition-colors text-xl px-2 shrink-0"
                  title={nextWell.wellName}
                >
                  ›
                </Link>
              ) : (
                <span className="text-gray-700 text-xl px-2 shrink-0">›</span>
              )}
            </div>

            {/* Refresh button */}
            <button
              onClick={handleRefresh}
              disabled={dataLoading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded transition-colors flex items-center gap-2 shrink-0 ml-8"
            >
              <span className={dataLoading ? 'animate-spin' : ''}>⟳</span>
              Refresh
            </button>
            <button
              onClick={async () => {
                setShowAddPull(true);
                if (addPullDrivers.length === 0) {
                  try {
                    const { adminGetDashboardCatalog } = await import('@/lib/adminDashboardCatalog');
                    const catalog = await adminGetDashboardCatalog();
                    {
                      const approved: ApprovedDriver[] = [];
                      Object.entries((catalog.approved || {}) as Record<string, any>).forEach(([hash, val]: [string, any]) => {
                        if (val.displayName && val.active !== false) {
                          approved.push({ key: hash, displayName: val.displayName, legalName: val.legalName || '', companyId: val.companyId, companyName: val.companyName });
                        } else {
                          const devKeys = Object.keys(val);
                          if (devKeys.length > 0) {
                            const first = val[devKeys[0]];
                            if (first?.displayName && first.active !== false) {
                              approved.push({ key: hash, displayName: first.displayName, legalName: first.legalName || '', companyId: first.companyId, companyName: first.companyName });
                            }
                          }
                        }
                      });
                      approved.sort((a, b) => a.displayName.localeCompare(b.displayName));
                      setAddPullDrivers(approved);
                    }
                  } catch (err) {
                    console.error((await import('@/lib/adminDashboardCatalog')).classifiedReadFailure('well drivers', err));
                  }
                }
                if (addPullDisposals.length === 0) {
                  loadDisposals().then(setAddPullDisposals).catch(() => {});
                }
              }}
              className="px-3 py-2 text-sm font-medium rounded transition-colors flex items-center gap-1.5 bg-gray-800 text-green-400 hover:bg-gray-700 border border-gray-700 shrink-0 ml-4"
            >
              <span className="text-sm">+</span> Add Pull
            </button>
          </div>
        </div>
      </div>

      {/* Main Content - full width for table */}
      <main className="mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-white mb-6">Well History</h1>
        {error && (
          <div className="bg-red-900/50 border border-red-500 text-red-200 px-4 py-3 rounded mb-6">
            {error}
            <button onClick={() => setError('')} className="float-right">&times;</button>
          </div>
        )}

        {/* Current Status Card - Forward-looking predictions */}
        {wellStatus && (
          <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-6">
            <h2 className="text-lg font-semibold text-white mb-3">Current Status</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
              <div className="text-center">
                <div className="text-xs text-gray-400">Current Level (Est)</div>
                <div className="text-xl font-mono text-white">
                  {estimatedCurrentLevel !== null
                    ? formatLevelFtIn(estimatedCurrentLevel)
                    : wellStatus.currentLevel}
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-400">Last Pull</div>
                <div className="text-lg font-mono text-white">
                  {wellStatus.lastPullDateTimeUTC
                    ? formatDateTime(wellStatus.lastPullDateTimeUTC)
                    : wellStatus.lastPullDateTime || wellStatus.timestamp || '--'}
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-400">1&quot; Flow Rate</div>
                <div className="text-xl font-mono text-white">{formatOneInchFlowRate(parseFlowRateToMinutes(wellStatus.flowRate))}</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-400">1&apos; Flow Rate</div>
                <div className="text-xl font-mono text-white">{wellStatus.flowRate || '--'}</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-400">BBLs / 24hrs</div>
                <div className="text-xl font-mono text-white">{wellStatus.windowBblsDay || wellStatus.bbls24hrs || '--'}</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-400">Time Till Pull</div>
                <div className="text-xl font-mono text-white">{wellStatus.timeTillPull || wellStatus.etaToMax || '--'}</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-400">Next Pull Time</div>
                <div className="text-lg font-mono text-white">{wellStatus.nextPullTime || '--'}</div>
              </div>
            </div>
            {(wellStatus.isDown || wellStatus.wellDown) && (
              <div className="mt-3 text-red-400 font-medium">Well is currently down</div>
            )}
          </div>
        )}

        {/* Pull History Table */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-white">Well History</h2>
            <button
              onClick={() => swCount > 0 && setShowServiceWork(!showServiceWork)}
              className={`text-sm font-medium px-3 py-1 rounded transition-colors ${
                swCount === 0
                  ? 'text-gray-600 border border-gray-800 cursor-default'
                  : showServiceWork
                    ? 'bg-emerald-600 text-white border border-emerald-500 hover:bg-emerald-500'
                    : 'bg-red-600/80 text-white border border-red-500 hover:bg-red-500'
              }`}
            >
              {showServiceWork ? 'Showing SW' : 'Show SW'}
            </button>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 bg-red-900/60 rounded"></span>
              <span className="text-gray-400">Anomaly (excluded from AFR)</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 bg-purple-900/50 rounded"></span>
              <span className="text-gray-400">IT Review (1.5x off)</span>
            </span>
          </div>
        </div>
        {dataLoading ? (
          <div className="text-gray-400">Loading history...</div>
        ) : pulls.length === 0 ? (
          <div className="text-gray-400">No pull history available</div>
        ) : (
          <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-x-auto">
            <table className="w-full">
              <thead>
                {/* Category Headers */}
                <tr className="border-b border-gray-600">
                  <th colSpan={4} className="px-2 py-1 text-left text-xs font-medium bg-pink-900/40 text-pink-300">
                    Entered Data
                  </th>
                  <th colSpan={(userCanDelete || user.role === 'driver') ? 7 : 6} className="px-2 py-1 text-left text-xs font-medium bg-orange-900/40 text-orange-300">
                    Calculated
                  </th>
                </tr>
                {/* Column Headers */}
                <tr className="bg-gray-700">
                  {/* Entered Data */}
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-300 whitespace-nowrap">
                    <div>Date / Time</div>
                    <div>of Pull</div>
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-300">
                    <div>Tank Top</div>
                    <div>Level</div>
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-300">
                    <div>BBLS</div>
                    <div>Taken</div>
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-300">
                    <div>Driver</div>
                  </th>
                  {/* Calculated - Historical data only */}
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-300">
                    <div>Tank After</div>
                    <div>Feet</div>
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-300">
                    <div>Time Dif</div>
                    <div>(H:M)</div>
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-300">
                    <div>Recovery</div>
                    <div>Inches</div>
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-300">
                    <div>1&quot; Flow Rate</div>
                    <div>(H:M:S)</div>
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-300">
                    <div>1&apos; Flow Rate</div>
                    <div>(H:M:S)</div>
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-300">
                    <div>BBLs</div>
                    <div>/ Day</div>
                  </th>
                  {userCanDelete && (
                    <th className="px-3 py-2 text-center text-xs font-medium text-gray-300 w-10"></th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {filteredPulls.map((pull) => {
                  const pullTime = new Date(pull.timestamp).getTime();
                  const userCanEdit = canEditPull(user, pull.driverId || '', pullTime, 30);

                  // Anomaly level coloring
                  // Level 2 (Anomaly): excluded from AFR - red tint
                  // Level 1 (IT Review): flagged but included - purple tint
                  // Level 0 (Normal): no color
                  let rowBgClass = 'hover:bg-gray-750';
                  if (pull.noLevel) {
                    rowBgClass = 'bg-gray-800/60 hover:bg-gray-800/80'; // No gauge - dimmed
                  } else if (pull.anomalyLevel === 2) {
                    rowBgClass = 'bg-red-900/40 hover:bg-red-900/60'; // Anomaly - excluded
                  } else if (pull.anomalyLevel === 1) {
                    rowBgClass = 'bg-purple-900/30 hover:bg-purple-900/50'; // IT Review - flagged
                  }

                  return (
                    <tr key={pull.packetId} className={rowBgClass}>
                      {/* Entered Data */}
                      <td className="px-3 py-2 text-white font-mono text-sm whitespace-nowrap">
                        {formatDateTime(pull.timestamp)}
                      </td>
                      <td className="px-3 py-2 font-mono text-sm text-center">
                        {pull.noLevel ? (
                          <span className="text-gray-500 italic text-xs">No Gauge</span>
                        ) : (
                          <span className="text-white">{formatLevelFtIn(pull.tankTopLevel)}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {pull.bblsTaken}
                      </td>
                      <td className="px-3 py-2 text-gray-400 text-sm">
                        {pull.driverName || '--'}
                        {pull.noLevel && (
                          <span className="ml-2 px-1.5 py-0.5 bg-gray-600/70 text-gray-300 text-xs rounded" title={pull.jobType || 'No tank gauge'}>
                            {pull.jobType || 'No Level'}
                          </span>
                        )}
                        {packetShowsEditBadge(pull) && (
                          <button
                            type="button"
                            className="ml-2 px-1.5 py-0.5 bg-orange-600/70 text-orange-100 text-xs rounded hover:bg-orange-500/80"
                            title={`Edited ${pull.editedAt || ''} by ${formatEditSourceLabel(pull.editedBy)} — click for correction trail`}
                            onClick={() => pull.packetId && toggleEditTrail(pull.packetId)}
                          >
                            Edited{typeof pull.editCount === 'number' && pull.editCount > 1 ? ` ×${pull.editCount}` : ''}
                          </button>
                        )}
                        {trailOpenId === pull.packetId && (
                          <div className="mt-2 ml-0 text-xs text-left bg-gray-900/80 border border-orange-700/40 rounded p-2 max-w-md">
                            <div className="text-orange-200 font-medium mb-1">Correction history</div>
                            {trailLoading && <div className="text-gray-400">Loading…</div>}
                            {!trailLoading && trailEvents.length === 0 && (
                              <div className="text-gray-400">
                                {pull.editedAt
                                  ? `Recorded edit at ${pull.editedAt} (${formatEditSourceLabel(pull.editedBy)}). Detailed field trail available for edits after the audit system was enabled.`
                                  : 'No correction events on file.'}
                              </div>
                            )}
                            {!trailLoading &&
                              trailEvents.map((ev) => (
                                <div key={ev.eventId} className="mb-2 last:mb-0 border-t border-gray-700/60 pt-1">
                                  <div className="text-gray-300">
                                    #{ev.sequence} · {ev.editedAt ? new Date(ev.editedAt).toLocaleString() : '—'} ·{' '}
                                    {formatEditSourceLabel(ev.source)}
                                  </div>
                                  {(ev.fields || []).map((f, i) => (
                                    <div key={i} className="text-gray-400 pl-2">
                                      {formatFieldLabel(f.field)}:{' '}
                                      <span className="text-red-300/90">{formatChangeValue(f.previous as any)}</span>
                                      {' → '}
                                      <span className="text-green-300/90">{formatChangeValue(f.next as any)}</span>
                                    </div>
                                  ))}
                                </div>
                              ))}
                          </div>
                        )}
                      </td>
                      {/* Calculated - Historical data (all blank for noLevel) */}
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {pull.noLevel ? '' : formatLevelFtIn(pull.tankAfter)}
                      </td>
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {pull.noLevel ? '' : (pull.timeDif || '--')}
                      </td>
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {pull.noLevel ? '' : (pull.recoveryInches !== undefined ? Math.floor(pull.recoveryInches) : '--')}
                      </td>
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {pull.noLevel ? '' : formatOneInchFlowRate(pull.flowRateDays ? pull.flowRateDays * 24 * 60 : parseFlowRateToMinutes(pull.flowRate))}
                      </td>
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {pull.noLevel ? '' : (pull.flowRate || '--')}
                      </td>
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {pull.noLevel ? '' : (pull.flowRateDays && pull.flowRateDays > 0
                          ? Math.round((1 / pull.flowRateDays) * wellTanks * 20)
                          : '--')}
                      </td>
                      {userCanDelete && (
                        <td className="px-1 py-2 text-center whitespace-nowrap">
                          {userCanEdit && (
                            <button
                              onClick={() => handleEdit(pull)}
                              className="p-1 text-gray-600 hover:text-blue-400 transition-colors"
                              title="Edit pull"
                            >✏️</button>
                          )}
                          <button
                            onClick={() => handleMove(pull)}
                            className="p-1 text-gray-600 hover:text-amber-400 transition-colors"
                            title="Move to correct well"
                          >↪️</button>
                          <button
                            onClick={() => handleDelete(pull)}
                            className="p-1 text-gray-600 hover:text-red-400 transition-colors"
                            title="Delete pull"
                          >🗑</button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* Edit Modal */}
      {editingPull && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-white mb-4">Edit Pull</h2>
            <p className="text-gray-400 text-sm mb-4">
              {formatDateTime(editingPull.timestamp)}
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Date / Time of Pull
                </label>
                <input
                  type="datetime-local"
                  value={editDateTime}
                  onChange={(e) => setEditDateTime(e.target.value)}
                  className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded text-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Tank Level
                </label>
                <input
                  type="text"
                  value={editLevel}
                  onChange={(e) => setEditLevel(e.target.value)}
                  placeholder="6 3"
                  className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded text-white"
                />
                {getEditLevelHint() && (
                  <span className="text-emerald-400 text-xs mt-1 block">{getEditLevelHint()}</span>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  BBLs Taken
                </label>
                <input
                  type="number"
                  value={editBbls}
                  onChange={(e) => setEditBbls(e.target.value)}
                  className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded text-white"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 mt-4">
              <input
                type="checkbox"
                id="editWellDown"
                checked={editWellDown}
                onChange={(e) => setEditWellDown(e.target.checked)}
                className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-red-500 focus:ring-red-500"
              />
              <label htmlFor="editWellDown" className="text-sm font-medium text-red-400">Well DOWN</label>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setEditingPull(null)}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submitEdit}
                disabled={editSubmitting}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white rounded transition-colors"
              >
                {editSubmitting ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingPull && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-white mb-4">Delete Pull?</h2>
            <p className="text-gray-300 mb-2">
              Are you sure you want to delete this pull?
            </p>
            <div className="bg-gray-900/60 border border-gray-700 rounded p-3 mb-4 text-sm">
              <div className="text-white font-medium mb-1">{deletingPull.wellName}</div>
              <div className="text-gray-400">
                {formatDateTime(deletingPull.timestamp)} · {deletingPull.bblsTaken} BBLs · {formatLevelFtIn(deletingPull.tankTopLevel)}
              </div>
            </div>
            <p className="text-amber-300/90 text-sm mb-4">
              Entered on the wrong well?{' '}
              <button
                onClick={() => handleMove(deletingPull)}
                className="underline hover:text-amber-200"
              >
                Move it to the correct well
              </button>{' '}
              instead of deleting.
            </p>
            <p className="text-red-400 text-sm mb-6">
              This action cannot be undone.
            </p>

            {error && (
              <p className="text-red-300 text-sm mb-4 bg-red-950/40 border border-red-800 rounded px-3 py-2">{error}</p>
            )}

            <div className="flex flex-wrap justify-end gap-3">
              <button
                onClick={() => { setDeletingPull(null); setError(''); }}
                disabled={deleteSubmitting}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 disabled:opacity-60 text-white rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleteSubmitting}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-800 text-white rounded transition-colors"
              >
                {deleteSubmitting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move-to-correct-well Confirmation Modal */}
      {movingPull && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-white mb-4">Move to correct well</h2>
            <p className="text-gray-300 mb-3 text-sm">
              This keeps the load and its history — only the well changes.
            </p>
            <div className="bg-gray-900/60 border border-gray-700 rounded p-3 mb-4 text-sm">
              <div className="text-gray-400">
                {formatDateTime(movingPull.timestamp)} · {movingPull.bblsTaken} BBLs · {formatLevelFtIn(movingPull.tankTopLevel)}
              </div>
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <span className="px-2 py-1 rounded bg-red-950/50 border border-red-800 text-red-200 text-xs">
                  From: {movingPull.wellName}
                </span>
                <span className="text-gray-500">→</span>
                {moveTargetWell ? (
                  <span className="px-2 py-1 rounded bg-green-950/50 border border-green-800 text-green-200 text-xs">
                    To: {moveTargetWell}
                  </span>
                ) : (
                  <span className="text-gray-500 text-xs italic">choose a target well</span>
                )}
              </div>
            </div>

            <button
              onClick={() => { setShowMoveTargetPicker(true); setMoveSearchQuery(''); }}
              disabled={moveSubmitting}
              className="w-full mb-4 px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-60 text-white rounded transition-colors text-sm"
            >
              {moveTargetWell ? 'Change target well' : 'Choose target well'}
            </button>

            {error && (
              <p className="text-red-300 text-sm mb-4 bg-red-950/40 border border-red-800 rounded px-3 py-2">{error}</p>
            )}

            <div className="flex flex-wrap justify-end gap-3">
              <button
                onClick={() => { setMovingPull(null); setMoveTargetWell(null); setError(''); }}
                disabled={moveSubmitting}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 disabled:opacity-60 text-white rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmMove}
                disabled={moveSubmitting || !moveTargetWell}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-900 disabled:text-green-300/60 text-white rounded transition-colors"
              >
                {moveSubmitting ? 'Moving…' : 'Move load'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move Target Well Picker */}
      {showMoveTargetPicker && movingPull && (
        <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-[60] pt-16 p-4" onClick={() => setShowMoveTargetPicker(false)}>
          <div className="bg-gray-800 rounded-lg w-full max-w-lg max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-gray-700">
              <div className="text-sm text-gray-400 mb-2">Move to which well?</div>
              <input
                type="text"
                autoFocus
                placeholder="Search wells…"
                value={moveSearchQuery}
                onChange={(e) => setMoveSearchQuery(e.target.value)}
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 focus:outline-none focus:border-green-500"
              />
            </div>
            <div className="overflow-y-auto flex-1 p-2">
              {(() => {
                const q = moveSearchQuery.toLowerCase();
                const candidates = allWells.filter((w) => w.wellName !== movingPull.wellName);
                const filtered = q ? candidates.filter((w) => w.wellName.toLowerCase().includes(q)) : candidates;
                if (filtered.length === 0) {
                  return <p className="text-gray-400 text-center py-8">No wells found</p>;
                }
                const grouped: Record<string, WellNavItem[]> = {};
                filtered.forEach((w) => {
                  const r = w.route || 'Unrouted';
                  if (!grouped[r]) grouped[r] = [];
                  grouped[r].push(w);
                });
                return Object.keys(grouped)
                  .sort((a, b) => (a === 'Unrouted' ? 1 : b === 'Unrouted' ? -1 : a.localeCompare(b)))
                  .map((route) => (
                    <div key={route} className="mb-2">
                      <div className="text-xs font-medium text-gray-500 uppercase tracking-wider px-3 py-1">{route}</div>
                      {grouped[route].map((w) => (
                        <button
                          key={w.wellName}
                          onClick={() => { setMoveTargetWell(w.wellName); setShowMoveTargetPicker(false); }}
                          className="block w-full text-left px-3 py-2 rounded text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors"
                        >
                          {w.wellName}
                        </button>
                      ))}
                    </div>
                  ));
              })()}
            </div>
            <div className="p-3 border-t border-gray-700 flex justify-end">
              <button
                onClick={() => setShowMoveTargetPicker(false)}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Well Picker Modal */}
      {showWellPicker && (
        <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 pt-16" onClick={() => setShowWellPicker(false)}>
          <div className="bg-gray-800 rounded-lg w-full max-w-lg max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Search bar */}
            <div className="p-4 border-b border-gray-700">
              <input
                type="text"
                autoFocus
                placeholder="Search wells..."
                value={wellSearchQuery}
                onChange={(e) => setWellSearchQuery(e.target.value)}
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
              />
            </div>

            {/* Well list grouped by route */}
            <div className="overflow-y-auto flex-1 p-2">
              {(() => {
                const q = wellSearchQuery.toLowerCase();
                const filtered = q
                  ? allWells.filter((w) => w.wellName.toLowerCase().includes(q))
                  : allWells;

                // Group by route
                const grouped: Record<string, WellNavItem[]> = {};
                filtered.forEach((w) => {
                  if (!grouped[w.route]) grouped[w.route] = [];
                  grouped[w.route].push(w);
                });

                // Build route list: all routes from full well list + always include Unrouted
                const allRouteNames = new Set(allWells.map((w) => w.route));
                allRouteNames.add('Unrouted');
                // If searching, only show routes that have matches (except always show Unrouted)
                const routeNames = Array.from(allRouteNames)
                  .filter((r) => !q || grouped[r]?.length || r === 'Unrouted')
                  .sort((a, b) => {
                    if (a === 'Unrouted') return 1;
                    if (b === 'Unrouted') return -1;
                    return a.localeCompare(b);
                  });

                if (q && Object.keys(grouped).length === 0) {
                  return <p className="text-gray-400 text-center py-8">No wells found</p>;
                }

                return routeNames.map((route) => {
                  const routeWells = grouped[route] || [];
                  return (
                    <div key={route} className="mb-2">
                      <div className="text-xs font-medium text-gray-500 uppercase tracking-wider px-3 py-1">
                        {route} {routeWells.length === 0 && <span className="text-gray-600">(0 wells)</span>}
                      </div>
                      {routeWells.length === 0 ? (
                        <div className="px-3 py-1 text-xs text-gray-600 italic">No wells</div>
                      ) : (
                        routeWells.map((w) => (
                          <Link
                            key={w.wellName}
                            href={`/well?name=${encodeURIComponent(w.wellName)}`}
                            onClick={() => setShowWellPicker(false)}
                            className={`block px-3 py-2 rounded text-sm transition-colors ${
                              w.wellName === wellName
                                ? 'bg-blue-600 text-white'
                                : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                            }`}
                          >
                            {w.wellName}
                          </Link>
                        ))
                      )}
                    </div>
                  );
                });
              })()}
            </div>

            {/* Close */}
            <div className="p-3 border-t border-gray-700 flex justify-between items-center">
              <span className="text-xs text-gray-500">{allWells.length} wells</span>
              <button
                onClick={() => setShowWellPicker(false)}
                className="px-4 py-1.5 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddPull && (
        <AddPullModal
          preselectedWell={wellName}
          drivers={addPullDrivers}
          allDisposals={addPullDisposals}
          onClose={() => setShowAddPull(false)}
          onSuccess={(submittedWell) => {
            if (submittedWell === wellName) {
              setTimeout(async () => {
                const history = await fetchWellHistoryUnified(wellName);
                setPulls(history);
              }, 2000);
            }
          }}
        />
      )}
    </div>
  );
}

function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
