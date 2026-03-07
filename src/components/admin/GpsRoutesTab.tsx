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
  const [addWellSelected, setAddWellSelected] = useState('');
  const [nearbyWells, setNearbyWells] = useState<Array<{ name: string; distance: number }>>([]);
  const [detectingNearby, setDetectingNearby] = useState(false);
  const [addMessage, setAddMessage] = useState('');

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

      // First pass: grouped wells — one card per pad group
      for (const [groupId, members] of padGroups) {
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
          routeGroupWell: groupId,
          groupMembers: otherMembers.length > 0 ? otherMembers : undefined,
        });
      }

      // Second pass: standalone wells with routeRecording enabled
      for (const [name, config] of Object.entries(configs)) {
        if (seen.has(name)) continue;
        if (!config.routeRecording) continue;

        routeWells.push({
          wellName: name,
          route: config.route,
          tripCount: 0,
          approvedCount: 0,
          loading: true,
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

  // Detect nearby wells when a well is selected in the Add modal
  const detectNearby = useCallback(async (wellName: string) => {
    const config = allConfigs[wellName];
    if (!config?.ndicName) {
      setNearbyWells([]);
      return;
    }

    setDetectingNearby(true);
    try {
      const selectedNdic = await findWellByName(config.ndicName);
      if (!selectedNdic?.latitude || !selectedNdic?.longitude) {
        setNearbyWells([]);
        setDetectingNearby(false);
        return;
      }

      const nearby: Array<{ name: string; distance: number }> = [];
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
              if (dist <= PAD_RADIUS_METERS) {
                nearby.push({ name, distance: Math.round(dist) });
              }
            }
          } catch { /* skip */ }
        });

      await Promise.all(promises);
      nearby.sort((a, b) => a.distance - b.distance);
      setNearbyWells(nearby);
    } catch (err) {
      console.error('[GpsRoutesTab] Nearby detection failed:', err);
      setNearbyWells([]);
    }
    setDetectingNearby(false);
  }, [allConfigs]);

  // Enable recording on a single well
  const handleAddWell = async (wellName: string) => {
    const db = getFirebaseDatabase();
    await update(ref(db, `well_config/${wellName}`), { routeRecording: true });
    setAddMessage(`Recording enabled for ${wellName}`);
    setAddWellSelected('');
    setNearbyWells([]);
  };

  // Enable recording + group all nearby wells
  const handleAddWithGroup = async (wellName: string, nearby: string[]) => {
    const db = getFirebaseDatabase();
    const updates: Record<string, any> = {};
    const allWells = [wellName, ...nearby];
    for (const w of allWells) {
      updates[`well_config/${w}/routeRecording`] = true;
      updates[`well_config/${w}/routeGroupWell`] = wellName;
    }
    await update(ref(db), updates);
    setAddMessage(`Grouped ${allWells.length} wells — all recording`);
    setAddWellSelected('');
    setNearbyWells([]);
  };

  // Wells available to add (not already recording or grouped)
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
          onClick={() => { setShowAddModal(true); setAddMessage(''); setAddWellSearch(''); setAddWellSelected(''); setNearbyWells([]); }}
          className="px-3 py-1.5 rounded-full text-sm font-medium bg-orange-600 hover:bg-orange-500 text-white transition"
        >
          + Add Well
        </button>

        <div className="ml-auto text-xs text-gray-500">
          {wells.length} wells recording &middot; {totalTrips} trips &middot; {totalApproved} approved routes
        </div>
      </div>

      {/* Add Well Modal */}
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

            {/* Search */}
            <input
              type="text"
              placeholder="Search wells..."
              value={addWellSearch}
              onChange={(e) => { setAddWellSearch(e.target.value); setAddWellSelected(''); setNearbyWells([]); }}
              className="w-full px-3 py-2 bg-gray-700 text-white rounded mb-3 text-sm"
              autoFocus
            />

            {/* Well list or selected well detail */}
            {addWellSelected ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between bg-gray-700 rounded p-3">
                  <div>
                    <div className="text-white font-medium">{addWellSelected}</div>
                    {allConfigs[addWellSelected]?.route && (
                      <div className="text-gray-400 text-xs">Route: {allConfigs[addWellSelected].route}</div>
                    )}
                  </div>
                  <button
                    onClick={() => { setAddWellSelected(''); setNearbyWells([]); }}
                    className="text-gray-400 hover:text-white text-sm"
                  >
                    Change
                  </button>
                </div>

                {/* Nearby wells detection */}
                {detectingNearby ? (
                  <div className="text-gray-400 text-xs">Checking for nearby wells on the same pad...</div>
                ) : nearbyWells.length > 0 ? (
                  <div className="bg-gray-700 rounded p-3 border border-orange-900/50">
                    <div className="text-orange-400 text-xs font-medium mb-2">
                      Nearby wells detected — same pad
                    </div>
                    <div className="space-y-1 mb-3">
                      {nearbyWells.map(nw => (
                        <div key={nw.name} className="flex items-center justify-between text-xs">
                          <span className="text-gray-300">{nw.name}</span>
                          <span className="text-gray-500">{nw.distance}m</span>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleAddWithGroup(addWellSelected, nearbyWells.map(nw => nw.name))}
                        className="flex-1 px-3 py-2 bg-orange-600 hover:bg-orange-500 text-white text-sm rounded font-medium"
                      >
                        Group All ({nearbyWells.length + 1})
                      </button>
                      <button
                        onClick={() => handleAddWell(addWellSelected)}
                        className="px-3 py-2 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded"
                      >
                        Just This Well
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => handleAddWell(addWellSelected)}
                    className="w-full px-3 py-2 bg-orange-600 hover:bg-orange-500 text-white text-sm rounded font-medium"
                  >
                    Enable Recording
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-y-auto flex-1 min-h-0">
                {filteredAvailable.length === 0 ? (
                  <div className="text-gray-500 text-sm text-center py-4">
                    {availableWells.length === 0
                      ? 'All wells are already recording or grouped'
                      : 'No wells match your search'}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {filteredAvailable.slice(0, 50).map(name => (
                      <button
                        key={name}
                        onClick={() => {
                          setAddWellSelected(name);
                          detectNearby(name);
                        }}
                        className="w-full text-left px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded flex justify-between items-center"
                      >
                        <span>{name}</span>
                        {allConfigs[name]?.route && (
                          <span className="text-gray-500 text-xs">{allConfigs[name].route}</span>
                        )}
                      </button>
                    ))}
                    {filteredAvailable.length > 50 && (
                      <div className="text-gray-500 text-xs text-center py-2">
                        {filteredAvailable.length - 50} more — type to search
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Well list */}
      {filtered.length === 0 ? (
        <div className="text-gray-500 text-sm bg-gray-800 rounded-lg p-6 text-center">
          {filter === 'all'
            ? 'No wells have GPS route recording enabled yet. Click "+ Add Well" above to get started.'
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
