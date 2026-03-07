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
  deleteDoc,
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
  groupMembers?: string[];
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

// SVG route preview — renders waypoints as a polyline scaled to fit
function RoutePreview({ waypoints, width = 700, height = 400, highlightColor = '#22d3ee' }: {
  waypoints: Array<{ lat: number; lng: number }>;
  width?: number;
  height?: number;
  highlightColor?: string;
}) {
  if (waypoints.length < 2) return <div className="text-gray-500 text-sm">Not enough points to display</div>;

  const padding = 40;
  const lats = waypoints.map(w => w.lat);
  const lngs = waypoints.map(w => w.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const latRange = maxLat - minLat || 0.001;
  const lngRange = maxLng - minLng || 0.001;

  const scaleX = (width - padding * 2) / lngRange;
  const scaleY = (height - padding * 2) / latRange;
  const scale = Math.min(scaleX, scaleY);
  const offsetX = (width - lngRange * scale) / 2;
  const offsetY = (height - latRange * scale) / 2;

  const toX = (lng: number) => offsetX + (lng - minLng) * scale;
  const toY = (lat: number) => height - offsetY - (lat - minLat) * scale;

  const points = waypoints.map(w => `${toX(w.lng).toFixed(1)},${toY(w.lat).toFixed(1)}`).join(' ');
  const start = waypoints[0];
  const end = waypoints[waypoints.length - 1];

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="bg-gray-950 rounded-lg border border-gray-700">
      {/* Route line */}
      <polyline
        points={points}
        fill="none"
        stroke={highlightColor}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.9"
      />
      {/* Waypoint dots */}
      {waypoints.map((w, i) => (
        <circle key={i} cx={toX(w.lng)} cy={toY(w.lat)} r="4" fill={highlightColor} opacity="0.5" />
      ))}
      {/* Start marker (green) */}
      <circle cx={toX(start.lng)} cy={toY(start.lat)} r="8" fill="#22c55e" stroke="#fff" strokeWidth="2" />
      <text x={toX(start.lng) + 14} y={toY(start.lat) + 5} fill="#22c55e" fontSize="13" fontWeight="bold">Start</text>
      {/* End marker (red/orange) */}
      <circle cx={toX(end.lng)} cy={toY(end.lat)} r="8" fill="#ef4444" stroke="#fff" strokeWidth="2" />
      <text x={toX(end.lng) + 14} y={toY(end.lat) + 5} fill="#ef4444" fontSize="13" fontWeight="bold">Well</text>
      {/* Waypoint count */}
      <text x="10" y="18" fill="#666" fontSize="11">{waypoints.length} waypoints</text>
    </svg>
  );
}

// ── Route Viewer Modal ──
function RouteViewerModal({
  title,
  waypoints,
  trip,
  approvedRoute,
  highlightColor = '#22d3ee',
  onClose,
  onApprove,
  saving,
}: {
  title: string;
  waypoints: Array<{ lat: number; lng: number }>;
  trip?: RouteTripDoc;
  approvedRoute?: ApprovedRoute;
  highlightColor?: string;
  onClose: () => void;
  onApprove?: (trimStart: number, trimEnd: number, label: string) => void;
  saving?: boolean;
}) {
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [labelInput, setLabelInput] = useState('');

  const totalPts = waypoints.length;
  const trimmedWps = waypoints.slice(trimStart, totalPts - trimEnd || undefined);
  const canTrim = totalPts > 4;
  const maxTrim = Math.floor(totalPts / 3);

  // Build Google Maps URL with origin (start of route) so direction is correct
  const start = trimmedWps[0];
  const end = trimmedWps[trimmedWps.length - 1];
  const middleWps = trimmedWps.length > 2
    ? simplifyRoute(trimmedWps.slice(1, -1), 23)
    : [];
  const wpParam = middleWps.length > 0
    ? `&waypoints=${middleWps.map(w => `${w.lat},${w.lng}`).join('|')}`
    : '';
  const mapsUrl = start && end
    ? `https://www.google.com/maps/dir/?api=1&origin=${start.lat},${start.lng}&destination=${end.lat},${end.lng}${wpParam}&travelmode=driving`
    : '#';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-xl border border-gray-700 shadow-2xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div>
            <h3 className="text-lg font-semibold text-white">{title}</h3>
            {trip && (
              <div className="text-sm text-gray-400 mt-1">
                {trip.driverName} &middot; {formatDate(trip.recordedAt)} &middot; {metersToMiles(trip.totalDistanceMeters)} mi &middot; {Math.round(trip.durationMinutes)} min
              </div>
            )}
            {approvedRoute && (
              <div className="text-sm text-gray-400 mt-1">
                {approvedRoute.sourceDriverName} &middot; {metersToMiles(approvedRoute.totalDistanceMeters)} mi &middot; {Math.round(approvedRoute.durationMinutes)} min &middot; {approvedRoute.waypoints.length} simplified waypoints
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl leading-none px-2">&times;</button>
        </div>

        {/* Map */}
        <div className="p-4">
          <RoutePreview waypoints={trimmedWps} highlightColor={highlightColor} />
        </div>

        {/* Trim controls (trips only) */}
        {canTrim && onApprove && (
          <div className="px-4 pb-2 space-y-2">
            <div className="text-xs text-gray-500 uppercase tracking-wider">Trim Route</div>
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-400 w-24">Trim start:</span>
              <input
                type="range"
                min={0}
                max={maxTrim}
                value={trimStart}
                onChange={(e) => setTrimStart(Number(e.target.value))}
                className="flex-1 accent-cyan-500"
              />
              <span className="text-gray-500 w-20 text-right font-mono">
                {trimStart > 0 ? `−${trimStart} pts` : 'none'}
              </span>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-400 w-24">Trim end:</span>
              <input
                type="range"
                min={0}
                max={maxTrim}
                value={trimEnd}
                onChange={(e) => setTrimEnd(Number(e.target.value))}
                className="flex-1 accent-cyan-500"
              />
              <span className="text-gray-500 w-20 text-right font-mono">
                {trimEnd > 0 ? `−${trimEnd} pts` : 'none'}
              </span>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="p-4 border-t border-gray-700 flex items-center gap-3">
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 bg-cyan-800 hover:bg-cyan-700 text-cyan-200 text-sm rounded-lg"
          >
            Open in Google Maps
          </a>
          {onApprove && (
            <>
              <input
                type="text"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                placeholder="Route label (e.g., From Watford)"
                className="flex-1 px-3 py-2 bg-gray-800 text-white rounded-lg text-sm border border-gray-600 focus:border-cyan-500 outline-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onApprove(trimStart, trimEnd, labelInput);
                }}
              />
              <button
                onClick={() => onApprove(trimStart, trimEnd, labelInput)}
                disabled={saving}
                className="px-4 py-2 bg-green-700 hover:bg-green-600 text-white text-sm rounded-lg font-medium whitespace-nowrap"
              >
                {saving ? 'Saving...' : 'Approve Route'}
              </button>
            </>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RouteManager({ wellName, groupMembers }: RouteManagerProps) {
  const [trips, setTrips] = useState<RouteTripDoc[]>([]);
  const [overrideDoc, setOverrideDoc] = useState<RouteOverrideDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [copiedRouteId, setCopiedRouteId] = useState<string | null>(null);
  const [modalTrip, setModalTrip] = useState<RouteTripDoc | null>(null);
  const [modalRoute, setModalRoute] = useState<ApprovedRoute | null>(null);

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
          setOverrideDoc(data as RouteOverrideDoc);
        } else if (data.active && data.waypoints) {
          // Legacy single-route format
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

  const handleApproveRoute = async (trip: RouteTripDoc, trimStart: number, trimEnd: number, label: string) => {
    setSaving(true);
    setMessage('');
    try {
      const db = getFirestoreDb();
      const trimmedWps = trip.waypoints.slice(trimStart, trip.waypoints.length - trimEnd || undefined);
      const rawPoints = trimmedWps.map(w => ({ lat: w.lat, lng: w.lng }));
      const simplified = simplifyRoute(rawPoints, 23);
      const actualStart = trimmedWps[0] || trip.waypoints[0];
      const actualEnd = trimmedWps[trimmedWps.length - 1] || trip.waypoints[trip.waypoints.length - 1];

      const newRoute: ApprovedRoute = {
        routeId: generateRouteId(),
        label: label?.trim() || undefined,
        waypoints: simplified,
        fullWaypoints: rawPoints,
        startLat: actualStart.lat,
        startLng: actualStart.lng,
        endLat: actualEnd.lat,
        endLng: actualEnd.lng,
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
      setModalTrip(null);
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

  const handleDeleteTrip = async (tripId: string) => {
    setSaving(true);
    try {
      const db = getFirestoreDb();
      await deleteDoc(doc(db, 'route_recordings', slug, 'trips', tripId));
      setTrips(prev => prev.filter(t => t.id !== tripId));
      setMessage('Trip deleted');
    } catch (err: any) {
      console.error('[RouteManager] Failed to delete trip:', err);
      setMessage('Failed to delete trip');
    }
    setSaving(false);
  };

  const handleCopyLink = async (route: ApprovedRoute) => {
    const url = buildGoogleMapsUrl(route.waypoints, route.startLat, route.startLng, route.endLat, route.endLng);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
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

      {/* Pad group members badge */}
      {groupMembers && groupMembers.length > 0 && (
        <div className="mb-2 px-2 py-1.5 bg-orange-900/30 border border-orange-800/50 rounded text-xs text-orange-300">
          <span className="font-medium">Shared with:</span>{' '}
          {groupMembers.join(', ')}
        </div>
      )}

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
                    onClick={() => setModalRoute(route)}
                    className="px-2 py-1 bg-gray-600 hover:bg-gray-500 text-white text-xs rounded whitespace-nowrap"
                  >
                    View
                  </button>
                  <button
                    onClick={() => handleCopyLink(route)}
                    className="px-2 py-1 bg-cyan-800 hover:bg-cyan-700 text-cyan-200 text-xs rounded whitespace-nowrap"
                    title="Copy Google Maps link to clipboard"
                  >
                    {copiedRouteId === route.routeId ? '✓ Copied!' : 'Copy Link'}
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

      {/* Recorded Trips — only show unapproved trips (approved ones already visible in Approved Routes) */}
      {(() => {
        const pendingTrips = trips.filter(t => !approvedTripIds.has(t.id));
        return pendingTrips.length > 0 ? (
          <>
            <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Recorded Trips</div>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {pendingTrips.map((trip) => (
                <div key={trip.id} className="p-2 rounded text-xs bg-gray-800">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="text-white">{trip.driverName}</div>
                      <div className="text-gray-500">
                        {formatDate(trip.recordedAt)} · {trip.waypoints.length} pts ·{' '}
                        {metersToMiles(trip.totalDistanceMeters)} mi · {Math.round(trip.durationMinutes)} min
                      </div>
                    </div>
                    <div className="flex items-center gap-1 ml-2">
                      <button
                        onClick={() => setModalTrip(trip)}
                        className="px-2 py-1 bg-gray-600 hover:bg-gray-500 text-white text-xs rounded whitespace-nowrap"
                      >
                        View
                      </button>
                      <button
                        onClick={() => setModalTrip(trip)}
                        disabled={saving}
                        className="px-2 py-1 bg-blue-700 hover:bg-blue-600 text-white text-xs rounded whitespace-nowrap"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => handleDeleteTrip(trip.id)}
                        disabled={saving}
                        className="px-2 py-1 bg-red-900 hover:bg-red-800 text-red-300 text-xs rounded whitespace-nowrap"
                        title="Delete this recorded trip"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null;
      })()}

      {trips.length === 0 && approvedRoutes.length === 0 && (
        <div className="text-gray-500 text-xs">
          No recorded trips yet. Drivers will automatically record GPS breadcrumbs when driving to this well.
        </div>
      )}

      {message && (
        <div className="text-xs text-cyan-400 mt-2">{message}</div>
      )}

      {/* Trip Viewer Modal */}
      {modalTrip && (
        <RouteViewerModal
          title={`Route to ${wellName}`}
          waypoints={modalTrip.waypoints.map(w => ({ lat: w.lat, lng: w.lng }))}
          trip={modalTrip}
          highlightColor="#22d3ee"
          onClose={() => setModalTrip(null)}
          onApprove={approvedTripIds.has(modalTrip.id) ? undefined : (ts, te, label) => {
            handleApproveRoute(modalTrip, ts, te, label);
          }}
          saving={saving}
        />
      )}

      {/* Approved Route Viewer Modal */}
      {modalRoute && (
        <RouteViewerModal
          title={modalRoute.label || `Route to ${wellName}`}
          waypoints={modalRoute.fullWaypoints.length > 0 ? modalRoute.fullWaypoints : modalRoute.waypoints}
          approvedRoute={modalRoute}
          highlightColor="#22c55e"
          onClose={() => setModalRoute(null)}
        />
      )}
    </div>
  );
}
