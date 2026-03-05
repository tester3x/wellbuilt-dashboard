// RouteManager.tsx — Admin tool for reviewing recorded GPS trips and selecting golden routes.
// Renders inside Admin > Wells > Edit Well when routeRecording is enabled.
// Shows recorded trips, lets admin pick the best route, and saves simplified override.

'use client';

import { useState, useEffect, useCallback } from 'react';
import { getFirestoreDb } from '@/lib/firebase';
import {
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  orderBy,
  query,
  Timestamp,
} from 'firebase/firestore';
import { simplifyRoute, metersToMiles } from '@/lib/routeUtils';

interface RouteWaypoint {
  lat: number;
  lng: number;
  timestamp: string;
  speed: number;
  heading: number;
}

interface RouteTripDoc {
  id: string;
  driverName: string;
  recordedAt: Timestamp;
  arrivedAt: Timestamp;
  waypoints: RouteWaypoint[];
  totalDistanceMeters: number;
  durationMinutes: number;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
}

interface RouteOverrideDoc {
  wellName: string;
  waypoints: Array<{ lat: number; lng: number }>;
  fullWaypoints: Array<{ lat: number; lng: number }>;
  sourceTripId: string;
  sourceDriverName: string;
  tripCount: number;
  selectedAt: Timestamp;
  selectedBy: string;
  active: boolean;
}

interface RouteManagerProps {
  wellName: string;
}

function wellSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 120);
}

function formatDate(ts: Timestamp | null): string {
  if (!ts) return '—';
  const d = ts.toDate();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function RouteManager({ wellName }: RouteManagerProps) {
  const [trips, setTrips] = useState<RouteTripDoc[]>([]);
  const [override, setOverride] = useState<RouteOverrideDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const slug = wellSlug(wellName);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const db = getFirestoreDb();

      // Load trips
      const tripsRef = collection(db, 'route_recordings', slug, 'trips');
      const q = query(tripsRef, orderBy('recordedAt', 'desc'));
      const snap = await getDocs(q);
      const tripDocs: RouteTripDoc[] = snap.docs.map(d => ({
        id: d.id,
        ...d.data(),
      })) as RouteTripDoc[];
      setTrips(tripDocs);

      // Load override
      const overrideRef = doc(db, 'route_overrides', slug);
      const overrideSnap = await getDoc(overrideRef);
      if (overrideSnap.exists()) {
        setOverride(overrideSnap.data() as RouteOverrideDoc);
      } else {
        setOverride(null);
      }
    } catch (err: any) {
      console.error('[RouteManager] Failed to load:', err);
      setMessage('Failed to load route data');
    }
    setLoading(false);
  }, [slug]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleUseRoute = async (trip: RouteTripDoc) => {
    setSaving(true);
    setMessage('');
    try {
      const db = getFirestoreDb();

      // Simplify waypoints for Google Maps URL (≤23 points)
      const rawPoints = trip.waypoints.map(w => ({ lat: w.lat, lng: w.lng }));
      const simplified = simplifyRoute(rawPoints, 23);

      const overrideDoc: RouteOverrideDoc = {
        wellName,
        waypoints: simplified,
        fullWaypoints: rawPoints,
        sourceTripId: trip.id,
        sourceDriverName: trip.driverName,
        tripCount: trips.length,
        selectedAt: Timestamp.now(),
        selectedBy: 'admin', // TODO: use actual admin name when auth is live
        active: true,
      };

      await setDoc(doc(db, 'route_overrides', slug), overrideDoc);
      setOverride(overrideDoc);
      setMessage(`Route set! ${rawPoints.length} points → ${simplified.length} waypoints for Google Maps`);
    } catch (err: any) {
      console.error('[RouteManager] Failed to save override:', err);
      setMessage('Failed to save route override');
    }
    setSaving(false);
  };

  const handleClearRoute = async () => {
    setSaving(true);
    try {
      const db = getFirestoreDb();
      if (override) {
        await setDoc(doc(db, 'route_overrides', slug), {
          ...override,
          active: false,
        });
      }
      setOverride(null);
      setMessage('Route override cleared');
    } catch (err: any) {
      console.error('[RouteManager] Failed to clear override:', err);
      setMessage('Failed to clear route');
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="bg-gray-900 rounded p-3 mt-2">
        <div className="text-gray-400 text-sm">Loading route data...</div>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 rounded p-3 mt-2">
      <div className="flex justify-between items-center mb-2">
        <div className="flex items-center gap-2">
          <span className="text-gray-300 text-sm font-medium">Route Management</span>
          {override?.active ? (
            <span className="text-xs bg-green-800 text-green-300 px-2 py-0.5 rounded-full">
              Route Set
            </span>
          ) : trips.length > 0 ? (
            <span className="text-xs bg-orange-800 text-orange-300 px-2 py-0.5 rounded-full">
              {trips.length} trip{trips.length !== 1 ? 's' : ''} recorded
            </span>
          ) : (
            <span className="text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded-full">
              No trips yet
            </span>
          )}
        </div>
        {override?.active && (
          <button
            onClick={handleClearRoute}
            disabled={saving}
            className="text-xs text-red-400 hover:text-red-300"
          >
            Clear Route
          </button>
        )}
      </div>

      {/* Active override info */}
      {override?.active && (
        <div className="bg-green-900/30 border border-green-800 rounded p-2 mb-2 text-xs">
          <div className="text-green-300">
            Using {override.sourceDriverName}'s route ({override.waypoints.length} waypoints)
          </div>
          <div className="text-green-500/70">
            Selected from {override.tripCount} recorded trip{override.tripCount !== 1 ? 's' : ''}
          </div>
        </div>
      )}

      {/* Trip list */}
      {trips.length > 0 && (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {trips.map((trip) => (
            <div
              key={trip.id}
              className={`flex items-center justify-between p-2 rounded text-xs ${
                override?.sourceTripId === trip.id
                  ? 'bg-green-900/20 border border-green-800'
                  : 'bg-gray-800'
              }`}
            >
              <div className="flex-1">
                <div className="text-white">
                  {trip.driverName}
                  {override?.sourceTripId === trip.id && (
                    <span className="ml-1 text-green-400">✓ active</span>
                  )}
                </div>
                <div className="text-gray-500">
                  {formatDate(trip.recordedAt)} · {trip.waypoints.length} pts ·{' '}
                  {metersToMiles(trip.totalDistanceMeters)} mi · {trip.durationMinutes} min
                </div>
              </div>
              {override?.sourceTripId !== trip.id && (
                <button
                  onClick={() => handleUseRoute(trip)}
                  disabled={saving}
                  className="px-2 py-1 bg-blue-700 hover:bg-blue-600 text-white text-xs rounded ml-2 whitespace-nowrap"
                >
                  Use This Route
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {trips.length === 0 && (
        <div className="text-gray-500 text-xs">
          No recorded trips yet. Drivers will automatically record GPS breadcrumbs when driving to this well.
        </div>
      )}

      {message && (
        <div className="text-xs text-cyan-400 mt-2">{message}</div>
      )}
    </div>
  );
}
