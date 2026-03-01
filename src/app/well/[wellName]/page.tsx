'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { canEditPull, canDeletePull } from '@/lib/auth';
import {
  PullPacket,
  WellResponse,
  WellNavItem,
  fetchWellHistoryUnified,
  deletePull,
  editPull,
  subscribeToWellNavList,
} from '@/lib/wells';
import { getDatabase, ref, onValue } from 'firebase/database';
import { getFirebaseApp } from '@/lib/firebase';
import Link from 'next/link';
import { AppHeader } from '@/components/AppHeader';

// Format inches to feet'inches" display
function formatLevelFtIn(inches: number | undefined): string {
  if (inches === undefined || isNaN(inches)) return '--';
  const totalInches = Math.round(inches);
  const feet = Math.floor(totalInches / 12);
  const remainingInches = totalInches % 12;
  return `${feet}'${remainingInches}"`;
}

// Calculate 1" flow rate from 1' flow rate (divide by 12)
// Input: flowRateMinutes = minutes per foot
// Output: M:SS format for minutes per inch
function formatOneInchFlowRate(flowRateMinutes: number | undefined): string {
  if (!flowRateMinutes || flowRateMinutes <= 0) return '--';
  const minutesPerInch = flowRateMinutes / 12;
  const mins = Math.floor(minutesPerInch);
  const secs = Math.round((minutesPerInch - mins) * 60);
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

export default function WellDetailPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const params = useParams();
  const wellName = decodeURIComponent(params.wellName as string);

  const [pulls, setPulls] = useState<PullPacket[]>([]);
  const [wellStatus, setWellStatus] = useState<WellResponse | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState('');

  // Edit modal state
  const [editingPull, setEditingPull] = useState<PullPacket | null>(null);
  const [editLevel, setEditLevel] = useState('');
  const [editBbls, setEditBbls] = useState('');
  const [editDateTime, setEditDateTime] = useState('');
  const [editSubmitting, setEditSubmitting] = useState(false);

  // Delete confirmation state
  const [deletingPull, setDeletingPull] = useState<PullPacket | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  // Well navigation list (all wells for prev/next + picker)
  const [allWells, setAllWells] = useState<WellNavItem[]>([]);
  const [showWellPicker, setShowWellPicker] = useState(false);
  const [wellSearchQuery, setWellSearchQuery] = useState('');

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

  const handleEdit = (pull: PullPacket) => {
    setEditingPull(pull);
    setEditLevel(String(pull.tankTopLevel));
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
        Number(editLevel),
        Number(editBbls),
        dateTimeChanged ? newDt.toISOString() : undefined
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
    setDeletingPull(pull);
  };

  const confirmDelete = async () => {
    if (!deletingPull) return;

    setDeleteSubmitting(true);
    try {
      await deletePull(deletingPull.packetId, deletingPull.wellName);
      // Refresh data
      const history = await fetchWellHistoryUnified(wellName);
      setPulls(history);
      setDeletingPull(null);
    } catch (err) {
      console.error('Error deleting pull:', err);
      setError('Failed to delete pull');
    } finally {
      setDeleteSubmitting(false);
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
                  href={`/well/${encodeURIComponent(prevWell.wellName)}`}
                  className="text-gray-400 hover:text-white transition-colors text-xl px-2 shrink-0"
                  title={prevWell.wellName}
                >
                  ‹
                </Link>
              ) : (
                <span className="text-gray-700 text-xl px-2 shrink-0">‹</span>
              )}

              <button
                onClick={() => { setShowWellPicker(true); setWellSearchQuery(''); }}
                className="text-lg font-semibold text-white hover:text-blue-400 transition-colors cursor-pointer truncate"
                title="Click to browse all wells"
              >
                {wellName}
              </button>

              {nextWell ? (
                <Link
                  href={`/well/${encodeURIComponent(nextWell.wellName)}`}
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
          <h2 className="text-lg font-semibold text-white">Well History</h2>
          <div className="flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 bg-orange-900/60 rounded"></span>
              <span className="text-gray-400">Anomaly (excluded from AFR)</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 bg-yellow-900/50 rounded"></span>
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
                    <div>(M:S)</div>
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-300">
                    <div>1&apos; Flow Rate</div>
                    <div>(H:M:S)</div>
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-300">
                    <div>BBLs</div>
                    <div>/ Day</div>
                  </th>
                  {(userCanDelete || user.role === 'driver') && (
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-300">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {pulls.map((pull) => {
                  const pullTime = new Date(pull.timestamp).getTime();
                  const userCanEdit = canEditPull(user, pull.driverId || '', pullTime, 30);

                  // Anomaly level coloring (matches VBA: 2 = peach, 1 = yellow)
                  // Level 2 (Anomaly): excluded from AFR - peach/orange
                  // Level 1 (IT Review): flagged but included - yellow
                  // Level 0 (Normal): no color
                  let rowBgClass = 'hover:bg-gray-750';
                  if (pull.anomalyLevel === 2) {
                    rowBgClass = 'bg-orange-900/40 hover:bg-orange-900/60'; // Anomaly - excluded
                  } else if (pull.anomalyLevel === 1) {
                    rowBgClass = 'bg-yellow-900/30 hover:bg-yellow-900/50'; // IT Review - flagged
                  }

                  return (
                    <tr key={pull.packetId} className={rowBgClass}>
                      {/* Entered Data */}
                      <td className="px-3 py-2 text-white font-mono text-sm whitespace-nowrap">
                        {formatDateTime(pull.timestamp)}
                      </td>
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {formatLevelFtIn(pull.tankTopLevel)}
                      </td>
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {pull.bblsTaken}
                      </td>
                      <td className="px-3 py-2 text-gray-400 text-sm">
                        {pull.driverName || '--'}
                        {pull.editedAt && (
                          <span className="ml-2 px-1.5 py-0.5 bg-orange-600/70 text-orange-100 text-xs rounded" title={`Edited ${pull.editedAt} by ${pull.editedBy || 'unknown'}`}>
                            Edited
                          </span>
                        )}
                      </td>
                      {/* Calculated - Historical data */}
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {formatLevelFtIn(pull.tankAfter)}
                      </td>
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {pull.timeDif || '--'}
                      </td>
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {pull.recoveryInches !== undefined ? Math.round(pull.recoveryInches) : '--'}
                      </td>
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {formatOneInchFlowRate(pull.flowRateDays ? pull.flowRateDays * 24 * 60 : parseFlowRateToMinutes(pull.flowRate))}
                      </td>
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {pull.flowRate || '--'}
                      </td>
                      <td className="px-3 py-2 text-white font-mono text-sm text-center">
                        {pull.flowRateDays && pull.flowRateDays > 0
                          ? Math.round((1 / pull.flowRateDays) * (wellStatus?.tanks || 1) * 20)
                          : '--'}
                      </td>
                      {(userCanDelete || user.role === 'driver') && (
                        <td className="px-3 py-2 text-right space-x-2 whitespace-nowrap">
                          {userCanEdit && (
                            <button
                              onClick={() => handleEdit(pull)}
                              className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded transition-colors"
                            >
                              Edit
                            </button>
                          )}
                          {userCanDelete && (
                            <button
                              onClick={() => handleDelete(pull)}
                              className="px-2 py-1 bg-red-600 hover:bg-red-700 text-white text-xs rounded transition-colors"
                            >
                              Delete
                            </button>
                          )}
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
                  Tank Top Level (inches)
                </label>
                <input
                  type="number"
                  value={editLevel}
                  onChange={(e) => setEditLevel(e.target.value)}
                  className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded text-white"
                />
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-white mb-4">Delete Pull?</h2>
            <p className="text-gray-300 mb-2">
              Are you sure you want to delete this pull?
            </p>
            <p className="text-gray-400 text-sm mb-4">
              {formatDateTime(deletingPull.timestamp)} - {formatLevelFtIn(deletingPull.tankTopLevel)} - {deletingPull.bblsTaken} BBLs
            </p>
            <p className="text-red-400 text-sm mb-6">
              This action cannot be undone.
            </p>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeletingPull(null)}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleteSubmitting}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-800 text-white rounded transition-colors"
              >
                {deleteSubmitting ? 'Deleting...' : 'Delete'}
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
                            href={`/well/${encodeURIComponent(w.wellName)}`}
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
