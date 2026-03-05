// RouteManager.tsx — Admin tool for reviewing recorded GPS trips and managing golden routes.
// Renders inside Admin > Wells > Edit Well when routeRecording is enabled.
// Supports multiple approved routes per well (different directions), shareable links, labels.

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
import { simplifyRoute, metersToMiles, generateRouteId, buildGoogleMapsUrl } from '@/lib/routeUtils';

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

interface ApprovedRoute {
  routeId: string;
  label?: string;
  waypoints: Array<{ lat: number; lng: number }>;
  fullWaypoints: Array<{ lat: number; lng: number }>;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  sourceTripId: string;
  sourceDriverName: string;
  totalDistanceMeters: number;
  durationMinutes: number;
  selectedAt: Timestamp;
  selectedBy: string;
}

interface RouteOverrideDoc {
  wellName: string;
  approvedRoutes: ApprovedRoute[];
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
  const [overrideDoc, setOverrideDoc] = useState<RouteOverrideDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [showLabelFor, setShowLabelFor] = useState<string | null>(null); // tripId being labeled
  const [labelInput, setLabelInput] = useState('');
  const [copiedRouteId, setCopiedRouteId] = useState<string | null>(null);

  const slug = wellSlug(wellName);
  const approvedRoutes = overrideDoc?.approvedRoutes || [];
  const approvedTripIds = new Set(approvedRoutes.map(r => r.sourceTripId));

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

      // Load override (backward compatible)
      const overrideRef = doc(db, 'route_overrides', slug);
      const overrideSnap = await getDoc(overrideRef);
      if (overrideSnap.exists()) {
        const data = overrideSnap.data();
        if (data.approvedRoutes && data.approvedRoutes.length > 0) {
          // New multi-route format
          setOverrideDoc(data as RouteOverrideDoc);
        } else if (data.active && data.waypoints) {
          // Legacy single-route format — wrap into approvedRoutes[0]
          setOverrideDoc({
            wellName: data.wellName,
            approvedRoutes: [{
              routeId: 'legacy',
              waypoints: data.waypoints,
              fullWaypoints: data.fullWaypoints || data.waypoints,
              startLat: data.waypoints[0]?.lat ?? 0,
              startLng: data.waypoints[0]?.lng ?? 0,
              endLat: data.waypoints[data.waypoints.length - 1]?.lat ?? 0,
              endLng: data.waypoints[data.waypoints.length - 1]?.lng ?? 0,
              sourceTripId: data.sourceTripId || 'unknown',
              sourceDriverName: data.sourceDriverName || 'unknown',
              totalDistanceMeters: 0,
              durationMinutes: 0,
              selectedAt: data.selectedAt || Timestamp.now(),
              selectedBy: data.selectedBy || 'admin',
            }],
          });
        } else {
          setOverrideDoc(null);
        }
      } else {
        setOverrideDoc(null);
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

  const handleApproveRoute = async (trip: RouteTripDoc, label?: string) => {
    setSaving(true);
    setMessage('');
    try {
      const db = getFirestoreDb();
      const rawPoints = trip.waypoints.map(w => ({ lat: w.lat, lng: w.lng }));
      const simplified = simplifyRoute(rawPoints, 23);

      const newRoute: ApprovedRoute = {
        routeId: generateRouteId(),
        label: label?.trim() || undefined,
        waypoints: simplified,
        fullWaypoints: rawPoints,
        startLat: trip.startLat,
        startLng: trip.startLng,
        endLat: trip.endLat,
        endLng: trip.endLng,
        sourceTripId: trip.id,
        sourceDriverName: trip.driverName,
        totalDistanceMeters: trip.totalDistanceMeters,
        durationMinutes: trip.durationMinutes,
        selectedAt: Timestamp.now(),
        selectedBy: 'admin',
      };

      const updated = [...approvedRoutes, newRoute];
      const newDoc: RouteOverrideDoc = { wellName, approvedRoutes: updated };

      await setDoc(doc(db, 'route_overrides', slug), newDoc);
      setOverrideDoc(newDoc);
      setShowLabelFor(null);
      setLabelInput('');
      setMessage(`Route approved! ${rawPoints.length} pts → ${simplified.length} waypoints. ${updated.length} route(s) total.`);
    } catch (err: any) {
      console.error('[RouteManager] Failed to save:', err);
      setMessage('Failed to save route');
    }
    setSaving(false);
  };

  const handleRemoveRoute = async (routeId: string) => {
    setSaving(true);
    try {
      const db = getFirestoreDb();
      const updated = approvedRoutes.filter(r => r.routeId !== routeId);
      const newDoc: RouteOverrideDoc = { wellName, approvedRoutes: updated };
      await setDoc(doc(db, 'route_overrides', slug), newDoc);
      setOverrideDoc(updated.length > 0 ? newDoc : null);
      setMessage(`Route removed. ${updated.length} route(s) remaining.`);
    } catch (err: any) {
      console.error('[RouteManager] Failed to remove:', err);
      setMessage('Failed to remove route');
    }
    setSaving(false);
  };

  const handleClearAll = async () => {
    setSaving(true);
    try {
      const db = getFirestoreDb();
      await setDoc(doc(db, 'route_overrides', slug), { wellName, approvedRoutes: [] });
      setOverrideDoc(null);
      setMessage('All routes cleared');
    } catch (err: any) {
      console.error('[RouteManager] Failed to clear:', err);
      setMessage('Failed to clear routes');
    }
    setSaving(false);
  };

  const handleCopyLink = async (route: ApprovedRoute) => {
    const url = buildGoogleMapsUrl(route.waypoints, route.endLat, route.endLng);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedRouteId(route.routeId);
    setTimeout(() => setCopiedRouteId(null), 2000);
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
      {/* Header */}
      <div className="flex justify-between items-center mb-2">
        <div className="flex items-center gap-2">
          <span className="text-gray-300 text-sm font-medium">Route Management</span>
          {approvedRoutes.length > 0 ? (
            <span className="text-xs bg-green-800 text-green-300 px-2 py-0.5 rounded-full">
              {approvedRoutes.length} Route{approvedRoutes.length !== 1 ? 's' : ''}
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
        {approvedRoutes.length > 0 && (
          <button
            onClick={handleClearAll}
            disabled={saving}
            className="text-xs text-red-400 hover:text-red-300"
          >
            Clear All
          </button>
        )}
      </div>

      {/* Approved Routes */}
      {approvedRoutes.length > 0 && (
        <div className="space-y-1 mb-3">
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Approved Routes</div>
          {approvedRoutes.map((route, idx) => (
            <div
              key={route.routeId}
              className="bg-green-900/20 border border-green-800/50 rounded p-2 text-xs"
            >
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="text-green-300 font-medium">
                    {route.label || `Route ${idx + 1}`}
                  </div>
                  <div className="text-gray-500">
                    {route.sourceDriverName} · {metersToMiles(route.totalDistanceMeters)} mi ·{' '}
                    {Math.round(route.durationMinutes)} min · {route.waypoints.length} waypoints
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-2">
                  <button
                    onClick={() => handleCopyLink(route)}
                    className="px-2 py-1 bg-cyan-800 hover:bg-cyan-700 text-cyan-200 text-xs rounded whitespace-nowrap"
                    title="Copy Google Maps link to clipboard"
                  >
                    {copiedRouteId === route.routeId ? '✓ Copied!' : '📋 Copy Link'}
                  </button>
                  <button
                    onClick={() => handleRemoveRoute(route.routeId)}
                    disabled={saving}
                    className="px-2 py-1 bg-red-900 hover:bg-red-800 text-red-300 text-xs rounded"
                    title="Remove this route"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Recorded Trips */}
      {trips.length > 0 && (
        <>
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Recorded Trips</div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {trips.map((trip) => {
              const isApproved = approvedTripIds.has(trip.id);
              return (
                <div
                  key={trip.id}
                  className={`p-2 rounded text-xs ${
                    isApproved
                      ? 'bg-green-900/10 border border-green-800/30'
                      : 'bg-gray-800'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="text-white">
                        {trip.driverName}
                        {isApproved && (
                          <span className="ml-1 text-green-400">✓ approved</span>
                        )}
                      </div>
                      <div className="text-gray-500">
                        {formatDate(trip.recordedAt)} · {trip.waypoints.length} pts ·{' '}
                        {metersToMiles(trip.totalDistanceMeters)} mi · {Math.round(trip.durationMinutes)} min
                      </div>
                    </div>
                    {!isApproved && showLabelFor !== trip.id && (
                      <button
                        onClick={() => {
                          setShowLabelFor(trip.id);
                          setLabelInput('');
                        }}
                        disabled={saving}
                        className="px-2 py-1 bg-blue-700 hover:bg-blue-600 text-white text-xs rounded ml-2 whitespace-nowrap"
                      >
                        Approve
                      </button>
                    )}
                  </div>

                  {/* Inline label input */}
                  {showLabelFor === trip.id && (
                    <div className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-700">
                      <input
                        type="text"
                        value={labelInput}
                        onChange={(e) => setLabelInput(e.target.value)}
                        placeholder="Label (e.g., From Watford)"
                        className="flex-1 px-2 py-1 bg-gray-700 text-white rounded text-xs"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleApproveRoute(trip, labelInput);
                          if (e.key === 'Escape') setShowLabelFor(null);
                        }}
                      />
                      <button
                        onClick={() => handleApproveRoute(trip, labelInput)}
                        disabled={saving}
                        className="px-2 py-1 bg-green-700 hover:bg-green-600 text-white text-xs rounded whitespace-nowrap"
                      >
                        {saving ? '...' : 'Save'}
                      </button>
                      <button
                        onClick={() => setShowLabelFor(null)}
                        className="px-2 py-1 bg-gray-600 hover:bg-gray-500 text-white text-xs rounded"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {trips.length === 0 && approvedRoutes.length === 0 && (
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
