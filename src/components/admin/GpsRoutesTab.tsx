// GpsRoutesTab.tsx — Dedicated admin tab for GPS route recording management.
// Shows all wells with routeRecording enabled, their recorded trips, and approved routes.
// Wells grouped by pad (via routeGroupWell field) share a single RouteManager.
// "+ Add Well" button enables recording directly from this tab (with pad auto-detect).

'use client';

import { useState, useEffect, useCallback } from 'react';
import { getFirestoreDb } from '@/lib/firebase';
import { getFirebaseDatabase } from '@/lib/firebase';
import { ref, onValue, update } from 'firebase/database';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  orderBy,
  Timestamp,
} from 'firebase/firestore';
import RouteManager from './RouteManager';
import { haversineMeters, PAD_RADIUS_METERS } from '@/lib/routeUtils';
import { findWellByName } from '@/lib/firestoreWells';

interface WellRouteStatus {
  wellName: string;
  route?: string;
  tripCount: number;
  approvedCount: number;
  lastTripDate?: Date;
  loading: boolean;
  isRecording: boolean;
  // Pad grouping — all wells equal, groupId = shared Firestore slug
  routeGroupWell?: string;
  groupMembers?: string[];
}

export default function GpsRoutesTab() {
  const [wells, setWells] = useState<WellRouteStatus[]>([]);
  const [allConfigs, setAllConfigs] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [expandedWell, setExpandedWell] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved'>('all');

  // Add Well modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [addWellSearch, setAddWellSearch] = useState('');
  const [addMessage, setAddMessage] = useState('');
  const [addingWell, setAddingWell] = useState(false);

  // Find Pad Wells on existing wells
  const [padSearchingWell, setPadSearchingWell] = useState<string | null>(null);
  const [padMessage, setPadMessage] = useState<{ well: string; text: string } | null>(null);

  // Load wells from RTDB, then fetch trip/override counts from Firestore
  useEffect(() => {
    const db = getFirebaseDatabase();
    const wellConfigRef = ref(db, 'well_config');

    const unsub = onValue(wellConfigRef, async (snapshot) => {
      const data = snapshot.val();
      if (!data) {
        setWells([]);
        setAllConfigs({});
        setLoading(false);
        return;
      }

      const configs = data as Record<string, any>;
      setAllConfigs(configs);

      // Build pad groups: groupId -> [all member wells]
      const padGroups = new Map<string, string[]>();
      for (const [name, config] of Object.entries(configs)) {
        if (config.routeGroupWell) {
          const groupId = config.routeGroupWell;
          if (!padGroups.has(groupId)) padGroups.set(groupId, []);
          padGroups.get(groupId)!.push(name);
        }
      }

      // Build display list: one entry per standalone well or pad group
      const routeWells: WellRouteStatus[] = [];
      const seen = new Set<string>();

      // First pass: grouped wells — one card per pad group (show ALL groups, even released ones)
      for (const [groupId, members] of padGroups) {
        const anyRecording = members.some(m => configs[m]?.routeRecording);
        members.sort();
        members.forEach(m => seen.add(m));

        const groupConfig = configs[groupId] || configs[members[0]];
        const otherMembers = members.filter(m => m !== groupId);

        routeWells.push({
          wellName: groupId,
          route: groupConfig?.route,
          tripCount: 0,
          approvedCount: 0,
          loading: true,
          isRecording: anyRecording,
          routeGroupWell: groupId,
          groupMembers: otherMembers.length > 0 ? otherMembers : undefined,
        });
      }

      // Second pass: standalone wells with routeRecording enabled (legacy — no routeGroupWell set)
      for (const [name, config] of Object.entries(configs)) {
        if (seen.has(name)) continue;
        if (!config.routeRecording) continue;

        routeWells.push({
          wellName: name,
          route: config.route,
          tripCount: 0,
          approvedCount: 0,
          loading: true,
          isRecording: true,
        });
      }

      // Sort alphabetically
      routeWells.sort((a, b) => a.wellName.localeCompare(b.wellName));
      setWells(routeWells);
      setLoading(false);

      // Now fetch Firestore data for each well (trips + overrides)
      const fsDb = getFirestoreDb();
      const updated = [...routeWells];

      await Promise.all(updated.map(async (well, idx) => {
        const slug = well.wellName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 120);

        try {
          // Count trips
          const tripsRef = collection(fsDb, 'route_recordings', slug, 'trips');
          const tripsSnap = await getDocs(query(tripsRef, orderBy('recordedAt', 'desc')));
          updated[idx].tripCount = tripsSnap.size;
          if (tripsSnap.size > 0) {
            const firstDoc = tripsSnap.docs[0].data();
            if (firstDoc.recordedAt) {
              updated[idx].lastTripDate = firstDoc.recordedAt.toDate();
            }
          }

          // Count approved routes
          const overrideRef = doc(fsDb, 'route_overrides', slug);
          const overrideSnap = await getDoc(overrideRef);
          if (overrideSnap.exists()) {
            const overrideData = overrideSnap.data();
            if (overrideData.approvedRoutes) {
              updated[idx].approvedCount = overrideData.approvedRoutes.length;
            } else if (overrideData.active && overrideData.waypoints) {
              updated[idx].approvedCount = 1; // Legacy single route
            }
          }
        } catch (err) {
          console.error(`[GpsRoutesTab] Error fetching data for ${well.wellName}:`, err);
        }
        updated[idx].loading = false;
      }));

      setWells([...updated]);
    });

    return () => unsub();
  }, []);

  // Auto-detect nearby wells and group them when adding a well to recording.
  // If the well already belongs to a pad group, re-activates ALL members.
  const handleAutoAdd = useCallback(async (wellName: string) => {
    setAddingWell(true);
    setAddMessage('');

    const config = allConfigs[wellName];
    const db = getFirebaseDatabase();

    // Check if this well already belongs to a pad group (from a previous session)
    if (config?.routeGroupWell) {
      const groupId = config.routeGroupWell;
      const groupMembers = Object.entries(allConfigs)
        .filter(([, cfg]) => cfg.routeGroupWell === groupId)
        .map(([name]) => name);

      const updates: Record<string, any> = {};
      for (const w of groupMembers) {
        updates[`well_config/${w}/routeRecording`] = true;
      }
      await update(ref(db), updates);
      setAddMessage(`Pad group reactivated! ${groupMembers.length} wells: ${groupMembers.join(', ')}`);
      setAddingWell(false);
      return;
    }

    // New well — auto-detect nearby wells on the same pad
    let nearby: string[] = [];
    if (config?.ndicName) {
      try {
        const selectedNdic = await findWellByName(config.ndicName);
        if (selectedNdic?.latitude && selectedNdic?.longitude) {
          const promises = Object.entries(allConfigs)
            .filter(([name, cfg]) => name !== wellName && cfg.ndicName && !cfg.routeRecording && !cfg.routeGroupWell)
            .map(async ([name, cfg]) => {
              try {
                const ndic = await findWellByName(cfg.ndicName);
                if (ndic?.latitude && ndic?.longitude) {
                  const dist = haversineMeters(
                    selectedNdic.latitude!, selectedNdic.longitude!,
                    ndic.latitude!, ndic.longitude!,
                  );
                  if (dist <= PAD_RADIUS_METERS) return name;
                }
              } catch { /* skip */ }
              return null;
            });

          const results = await Promise.all(promises);
          nearby = results.filter((n): n is string => n !== null);
        }
      } catch (err) {
        console.error('[GpsRoutesTab] Nearby detection failed:', err);
      }
    }

    // Auto-add and group
    if (nearby.length > 0) {
      const updates: Record<string, any> = {};
      const padWells = [wellName, ...nearby];
      for (const w of padWells) {
        updates[`well_config/${w}/routeRecording`] = true;
        updates[`well_config/${w}/routeGroupWell`] = wellName;
      }
      await update(ref(db), updates);
      setAddMessage(`Pad detected! Added ${padWells.length} wells: ${padWells.join(', ')}`);
    } else {
      await update(ref(db, `well_config/${wellName}`), { routeRecording: true, routeGroupWell: wellName });
      setAddMessage(`Recording enabled for ${wellName}`);
    }
    setAddingWell(false);
  }, [allConfigs]);

  // Find and group nearby pad wells for an EXISTING well already in the list
  const handleFindPadWells = useCallback(async (wellName: string) => {
    setPadSearchingWell(wellName);
    setPadMessage(null);

    const config = allConfigs[wellName];
    if (!config?.ndicName) {
      setPadMessage({ well: wellName, text: 'No NDIC link — cannot detect pad' });
      setPadSearchingWell(null);
      setTimeout(() => setPadMessage(null), 3000);
      return;
    }

    try {
      const selectedNdic = await findWellByName(config.ndicName);
      if (!selectedNdic?.latitude || !selectedNdic?.longitude) {
        setPadMessage({ well: wellName, text: 'No GPS coords for this well' });
        setPadSearchingWell(null);
        setTimeout(() => setPadMessage(null), 3000);
        return;
      }

      const nearby: string[] = [];
      const promises = Object.entries(allConfigs)
        .filter(([name, cfg]) => name !== wellName && cfg.ndicName && !cfg.routeGroupWell)
        .map(async ([name, cfg]) => {
          try {
            const ndic = await findWellByName(cfg.ndicName);
            if (ndic?.latitude && ndic?.longitude) {
              const dist = haversineMeters(
                selectedNdic.latitude!, selectedNdic.longitude!,
                ndic.latitude!, ndic.longitude!,
              );
              if (dist <= PAD_RADIUS_METERS) return name;
            }
          } catch { /* skip */ }
          return null;
        });

      const results = await Promise.all(promises);
      const found = results.filter((n): n is string => n !== null);

      if (found.length === 0) {
        // Mark as "group of one" — searched, nothing found. Hides the Find Pad Wells button.
        const db2 = getFirebaseDatabase();
        await update(ref(db2, `well_config/${wellName}`), { routeGroupWell: wellName });
        setPadMessage({ well: wellName, text: 'No nearby wells found — marked as standalone' });
        setTimeout(() => setPadMessage(null), 3000);
      } else {
        const db = getFirebaseDatabase();
        const updates: Record<string, any> = {};
        const padWells = [wellName, ...found];
        for (const w of padWells) {
          updates[`well_config/${w}/routeRecording`] = true;
          updates[`well_config/${w}/routeGroupWell`] = wellName;
        }
        await update(ref(db), updates);
        setPadMessage({ well: wellName, text: `Grouped ${padWells.length} wells: ${found.join(', ')}` });
        setTimeout(() => setPadMessage(null), 5000);
      }
    } catch (err) {
      console.error('[GpsRoutesTab] Pad detection failed:', err);
      setPadMessage({ well: wellName, text: 'Detection failed' });
      setTimeout(() => setPadMessage(null), 3000);
    }
    setPadSearchingWell(null);
  }, [allConfigs]);

  // Toggle recording on/off for a well (or whole pad group) — keeps grouping + approved routes
  const handleToggleRecording = useCallback(async (well: WellRouteStatus) => {
    const db = getFirebaseDatabase();
    const updates: Record<string, any> = {};
    const allMembers = [well.wellName, ...(well.groupMembers || [])];
    const newState = !well.isRecording;
    for (const w of allMembers) {
      updates[`well_config/${w}/routeRecording`] = newState ? true : null;
      // routeGroupWell persists — pad geometry is permanent
    }
    await update(ref(db), updates);
  }, []);

  // Wells available to add (not already in GPS Routes — no recording AND no group membership)
  const availableWells = Object.entries(allConfigs)
    .filter(([, cfg]) => !cfg.routeRecording && !cfg.routeGroupWell)
    .map(([name]) => name)
    .sort();

  const filteredAvailable = addWellSearch
    ? availableWells.filter(name => name.toLowerCase().includes(addWellSearch.toLowerCase()))
    : availableWells;

  const filtered = wells.filter(w => {
    if (filter === 'pending') return w.tripCount > 0 && w.approvedCount === 0;
    if (filter === 'approved') return w.approvedCount > 0;
    return true;
  });

  const totalTrips = wells.reduce((sum, w) => sum + w.tripCount, 0);
  const totalApproved = wells.reduce((sum, w) => sum + w.approvedCount, 0);
  const pendingCount = wells.filter(w => w.tripCount > 0 && w.approvedCount === 0).length;

  if (loading) {
    return <div className="text-gray-400 p-4">Loading GPS route data...</div>;
  }

  return (
    <div>
      {/* Summary badges + Add Well button */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button
          onClick={() => setFilter('all')}
          className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${
            filter === 'all'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          All ({wells.length})
        </button>
        <button
          onClick={() => setFilter('pending')}
          className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${
            filter === 'pending'
              ? 'bg-orange-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Needs Review ({pendingCount})
        </button>
        <button
          onClick={() => setFilter('approved')}
          className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${
            filter === 'approved'
              ? 'bg-green-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Has Routes ({totalApproved})
        </button>

        <button
          onClick={() => { setShowAddModal(true); setAddMessage(''); setAddWellSearch(''); }}
          className="px-3 py-1.5 rounded-full text-sm font-medium bg-orange-600 hover:bg-orange-500 text-white transition"
        >
          + Add Well
        </button>

        <div className="ml-auto text-xs text-gray-500">
          {wells.length} wells &middot; {wells.filter(w => w.isRecording).length} recording &middot; {totalTrips} trips &middot; {totalApproved} approved routes
        </div>
      </div>

      {/* Add Well Modal — auto-detects + groups nearby pad wells */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-5 max-w-md w-full mx-4 max-h-[80vh] flex flex-col">
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-white font-medium">Add Well to Route Recording</h3>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-gray-400 hover:text-white text-xl leading-none"
              >
                ×
              </button>
            </div>

            {addMessage && (
              <div className="mb-3 px-3 py-2 bg-green-900/50 border border-green-700 rounded text-green-300 text-sm">
                {addMessage}
              </div>
            )}

            {addingWell && (
              <div className="mb-3 px-3 py-2 bg-blue-900/50 border border-blue-700 rounded text-blue-300 text-sm">
                Adding well and checking for nearby pad wells...
              </div>
            )}

            {/* Search */}
            <input
              type="text"
              placeholder="Search wells..."
              value={addWellSearch}
              onChange={(e) => setAddWellSearch(e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 text-white rounded mb-3 text-sm"
              autoFocus
              disabled={addingWell}
            />

            {/* Well list — click to auto-add + auto-group */}
            <div className="overflow-y-auto flex-1 min-h-0">
              {filteredAvailable.length === 0 ? (
                <div className="text-gray-500 text-sm text-center py-4">
                  {availableWells.length === 0
                    ? 'All wells are already recording or grouped'
                    : 'No wells match your search'}
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredAvailable.slice(0, 50).map(name => {
                    const cfg = allConfigs[name];
                    const hasGroup = cfg?.routeGroupWell;
                    const groupCount = hasGroup
                      ? Object.values(allConfigs).filter((c: any) => c.routeGroupWell === cfg.routeGroupWell).length
                      : 0;
                    return (
                      <button
                        key={name}
                        onClick={() => handleAutoAdd(name)}
                        disabled={addingWell}
                        className="w-full text-left px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded flex justify-between items-center disabled:opacity-50"
                      >
                        <span>{name}</span>
                        <div className="flex items-center gap-2">
                          {hasGroup && (
                            <span className="text-xs text-orange-400">Pad: {groupCount} wells</span>
                          )}
                          {cfg?.route && !hasGroup && (
                            <span className="text-gray-500 text-xs">{cfg.route}</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                  {filteredAvailable.length > 50 && (
                    <div className="text-gray-500 text-xs text-center py-2">
                      {filteredAvailable.length - 50} more — type to search
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Well list */}
      {filtered.length === 0 ? (
        <div className="text-gray-500 text-sm bg-gray-800 rounded-lg p-6 text-center">
          {filter === 'all'
            ? 'No wells in GPS Routes yet. Click "+ Add Well" above to get started.'
            : filter === 'pending'
              ? 'No wells with unreviewed trips.'
              : 'No wells with approved routes yet.'}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((well) => (
            <div key={well.wellName} className="bg-gray-800 rounded-lg overflow-hidden">
              {/* Well header row — click to expand */}
              <div
                onClick={() => setExpandedWell(expandedWell === well.wellName ? null : well.wellName)}
                className={`flex items-center justify-between p-3 cursor-pointer hover:bg-gray-750 transition ${
                  expandedWell === well.wellName ? 'bg-gray-750 border-b border-gray-700' : ''
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className={`text-lg ${expandedWell === well.wellName ? 'rotate-90' : ''} transition-transform text-gray-500`}>
                    ▶
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${well.isRecording ? 'bg-red-500 animate-pulse' : 'bg-gray-600'}`} />
                      <span className="text-white font-medium">{well.wellName}</span>
                      {well.groupMembers && well.groupMembers.length > 0 && (
                        <span className="text-xs bg-orange-900/50 text-orange-300 border border-orange-800 px-1.5 py-0.5 rounded">
                          Pad: {well.groupMembers.length + 1} wells
                        </span>
                      )}
                    </div>
                    {well.route && (
                      <div className="text-gray-500 text-xs">Route: {well.route}</div>
                    )}
                    {well.groupMembers && well.groupMembers.length > 0 && (
                      <div className="text-gray-500 text-xs">
                        + {well.groupMembers.join(', ')}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Record toggle — red when recording, grey when not */}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggleRecording(well); }}
                    className={`text-xs px-2 py-0.5 rounded border transition whitespace-nowrap ${
                      well.isRecording
                        ? 'bg-red-900/50 text-red-300 border-red-800 hover:bg-red-800/50'
                        : 'bg-gray-700 text-gray-400 border-gray-600 hover:bg-gray-600'
                    }`}
                    title={well.isRecording ? 'Stop recording new trips' : 'Start recording trips'}
                  >
                    {well.isRecording ? '● Recording' : '○ Record'}
                  </button>
                  {/* Find Pad Wells button — only for standalone wells (not already grouped) */}
                  {!well.routeGroupWell && !well.groupMembers && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleFindPadWells(well.wellName); }}
                      disabled={padSearchingWell === well.wellName}
                      className="text-xs px-2 py-0.5 rounded bg-orange-900/50 text-orange-300 border border-orange-800 hover:bg-orange-800/50 transition whitespace-nowrap"
                      title="Auto-detect and group nearby wells on the same pad"
                    >
                      {padSearchingWell === well.wellName ? 'Scanning...' : 'Find Pad Wells'}
                    </button>
                  )}
                  {/* Trip count badge */}
                  {well.loading ? (
                    <span className="text-xs text-gray-500">loading...</span>
                  ) : (
                    <>
                      {well.tripCount > 0 && (
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          well.approvedCount === 0
                            ? 'bg-orange-900/50 text-orange-300 border border-orange-700'
                            : 'bg-gray-700 text-gray-400'
                        }`}>
                          {well.tripCount} trip{well.tripCount !== 1 ? 's' : ''}
                        </span>
                      )}
                      {well.approvedCount > 0 && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-green-900/50 text-green-300 border border-green-700">
                          {well.approvedCount} route{well.approvedCount !== 1 ? 's' : ''} approved
                        </span>
                      )}
                      {well.tripCount === 0 && well.approvedCount === 0 && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-500">
                          Waiting for trips
                        </span>
                      )}
                      {well.lastTripDate && (
                        <span className="text-xs text-gray-600">
                          Last: {well.lastTripDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Pad detection message */}
              {padMessage?.well === well.wellName && (
                <div className="mx-3 mb-1 px-3 py-1.5 bg-cyan-900/30 border border-cyan-800/50 rounded text-xs text-cyan-300">
                  {padMessage.text}
                </div>
              )}

              {/* Expanded: RouteManager */}
              {expandedWell === well.wellName && (
                <div className="p-3 pt-0">
                  <RouteManager wellName={well.wellName} groupMembers={well.groupMembers} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
