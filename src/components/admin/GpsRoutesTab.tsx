// GpsRoutesTab.tsx — Dedicated admin tab for GPS route recording management.
// Shows all wells with routeRecording enabled, their recorded trips, and approved routes.
// Wells grouped by pad (via routeGroupWell field) share a single RouteManager.

'use client';

import { useState, useEffect, useCallback } from 'react';
import { getFirestoreDb } from '@/lib/firebase';
import { getFirebaseDatabase } from '@/lib/firebase';
import { ref, onValue } from 'firebase/database';
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
  const [loading, setLoading] = useState(true);
  const [expandedWell, setExpandedWell] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved'>('all');

  // Load wells with routeRecording=true from RTDB, then fetch trip/override counts from Firestore
  useEffect(() => {
    const db = getFirebaseDatabase();
    const wellConfigRef = ref(db, 'well_config');

    const unsub = onValue(wellConfigRef, async (snapshot) => {
      const data = snapshot.val();
      if (!data) {
        setWells([]);
        setLoading(false);
        return;
      }

      // Build a map of all configs for grouping
      const allConfigs = data as Record<string, any>;

      // Build pad groups: groupId -> [all member wells]
      // All wells in a group are equal — groupId is just a shared Firestore slug
      const padGroups = new Map<string, string[]>();
      for (const [name, config] of Object.entries(allConfigs)) {
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

        // Use the group ID well's config for route display
        const groupConfig = allConfigs[groupId] || allConfigs[members[0]];
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
      for (const [name, config] of Object.entries(allConfigs)) {
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
      {/* Summary badges */}
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

        <div className="ml-auto text-xs text-gray-500">
          {wells.length} wells recording &middot; {totalTrips} trips &middot; {totalApproved} approved routes
        </div>
      </div>

      {/* Well list */}
      {filtered.length === 0 ? (
        <div className="text-gray-500 text-sm bg-gray-800 rounded-lg p-6 text-center">
          {filter === 'all'
            ? 'No wells have GPS route recording enabled. Enable it in Wells tab → Edit Well → Route Recording toggle.'
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
