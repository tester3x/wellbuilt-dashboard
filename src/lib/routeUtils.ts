// routeUtils.ts — Route simplification for GPS breadcrumb override system.
// Uses Douglas-Peucker algorithm to reduce waypoints while preserving turns.
// Google Maps URL supports ~25 waypoints, so we target ≤23 (minus origin/dest).

const EARTH_RADIUS_M = 6371000;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Simplify a route to at most `maxPoints` waypoints while preserving shape.
 * Uses Douglas-Peucker with progressive tolerance increase.
 */
export function simplifyRoute(
  points: Array<{ lat: number; lng: number }>,
  maxPoints: number = 23,
): Array<{ lat: number; lng: number }> {
  if (points.length <= maxPoints) return points;

  let tolerance = 50; // meters — start tight
  let simplified = douglasPeucker(points, tolerance);

  // Increase tolerance until we fit under the limit
  while (simplified.length > maxPoints && tolerance < 5000) {
    tolerance += 25;
    simplified = douglasPeucker(points, tolerance);
  }

  // Prevent over-simplification: a 2-point result loses ALL turn info and
  // gives Google Maps a straight line.  Keep at least 5 evenly-spaced points
  // so the route stays on the correct roads.
  const minPoints = Math.min(5, points.length);
  if (simplified.length < minPoints) {
    const step = (points.length - 1) / (minPoints - 1);
    simplified = [];
    for (let i = 0; i < minPoints; i++) {
      simplified.push(points[Math.round(i * step)]);
    }
  }

  // Safety net: if still too many (extremely winding route), take evenly spaced subset
  if (simplified.length > maxPoints) {
    const step = simplified.length / maxPoints;
    const result: Array<{ lat: number; lng: number }> = [];
    for (let i = 0; i < maxPoints; i++) {
      result.push(simplified[Math.floor(i * step)]);
    }
    // Always include the last point
    result[result.length - 1] = simplified[simplified.length - 1];
    return result;
  }

  return simplified;
}

function douglasPeucker(
  points: Array<{ lat: number; lng: number }>,
  tolerance: number,
): Array<{ lat: number; lng: number }> {
  if (points.length <= 2) return [...points];

  const start = points[0];
  const end = points[points.length - 1];
  let maxDist = 0;
  let maxIdx = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistanceMeters(points[i], start, end);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > tolerance) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), tolerance);
    const right = douglasPeucker(points.slice(maxIdx), tolerance);
    return [...left.slice(0, -1), ...right];
  }

  return [start, end];
}

/**
 * Perpendicular distance from a point to a line segment, in meters.
 * Uses equirectangular approximation (accurate for <100km at ND/MT latitudes).
 */
function perpendicularDistanceMeters(
  point: { lat: number; lng: number },
  lineStart: { lat: number; lng: number },
  lineEnd: { lat: number; lng: number },
): number {
  const cosLat = Math.cos(((lineStart.lat + lineEnd.lat) / 2) * DEG_TO_RAD);

  // Convert to local meters (equirectangular projection)
  const x = (point.lng - lineStart.lng) * cosLat;
  const y = point.lat - lineStart.lat;
  const x1 = (lineEnd.lng - lineStart.lng) * cosLat;
  const y1 = lineEnd.lat - lineStart.lat;

  const dot = x * x1 + y * y1;
  const lenSq = x1 * x1 + y1 * y1;
  const param = lenSq !== 0 ? dot / lenSq : -1;

  let closestX: number, closestY: number;
  if (param < 0) {
    closestX = 0;
    closestY = 0;
  } else if (param > 1) {
    closestX = x1;
    closestY = y1;
  } else {
    closestX = param * x1;
    closestY = param * y1;
  }

  const dx = x - closestX;
  const dy = y - closestY;
  return Math.sqrt(dx * dx + dy * dy) * EARTH_RADIUS_M * DEG_TO_RAD;
}

/**
 * Haversine distance between two GPS coordinates, in meters.
 * Used for well pad proximity detection (~150m radius).
 */
export function haversineMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLng = (lng2 - lng1) * DEG_TO_RAD;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Well pad proximity threshold — wells within this distance share routes. */
export const PAD_RADIUS_METERS = 150;

/**
 * Check if a new recorded trip is a duplicate of an existing approved route.
 * Samples evenly-spaced points from both routes and compares average deviation.
 * Used to auto-discard identical daily runs and only surface genuinely new routes.
 */
export function isDuplicateRoute(
  newRoute: Array<{ lat: number; lng: number }>,
  existingRoute: Array<{ lat: number; lng: number }>,
  thresholdMeters: number = 500,
): boolean {
  if (newRoute.length < 2 || existingRoute.length < 2) return false;

  // Fast reject: check start and end points first
  const startDist = haversineMeters(
    newRoute[0].lat, newRoute[0].lng,
    existingRoute[0].lat, existingRoute[0].lng,
  );
  const endDist = haversineMeters(
    newRoute[newRoute.length - 1].lat, newRoute[newRoute.length - 1].lng,
    existingRoute[existingRoute.length - 1].lat, existingRoute[existingRoute.length - 1].lng,
  );
  if (startDist > thresholdMeters * 2 || endDist > thresholdMeters * 2) return false;

  // Sample 10 evenly-spaced points from each route, compare average deviation
  const sampleCount = 10;
  let totalDeviation = 0;
  for (let i = 0; i < sampleCount; i++) {
    const t = i / (sampleCount - 1);
    const newIdx = Math.round(t * (newRoute.length - 1));
    const existIdx = Math.round(t * (existingRoute.length - 1));
    totalDeviation += haversineMeters(
      newRoute[newIdx].lat, newRoute[newIdx].lng,
      existingRoute[existIdx].lat, existingRoute[existIdx].lng,
    );
  }

  return (totalDeviation / sampleCount) < thresholdMeters;
}

/**
 * Convert meters to miles (for display).
 */
export function metersToMiles(meters: number): string {
  return (meters / 1609.344).toFixed(1);
}

/**
 * Generate a short unique route ID for approved routes.
 */
export function generateRouteId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

/**
 * Build a shareable Google Maps URL from simplified waypoints.
 * Origin = start of route, Destination = end of route.
 * Middle waypoints (excluding first/last which duplicate origin/dest) are intermediate stops.
 * Without an explicit origin, Google uses "Your location" which adds an unwanted extra leg.
 */
export function buildGoogleMapsUrl(
  waypoints: Array<{ lat: number; lng: number }>,
  startLat: number,
  startLng: number,
  destLat: number,
  destLng: number,
): string {
  const origin = `&origin=${startLat},${startLng}`;
  const dest = `&destination=${destLat},${destLng}`;
  // Skip first and last waypoints — they duplicate origin/destination
  const midWps = waypoints.length > 2 ? waypoints.slice(1, -1) : [];
  const wp = midWps.length > 0
    ? `&waypoints=${midWps.map(w => `via:${w.lat},${w.lng}`).join('|')}`
    : '';
  return `https://www.google.com/maps/dir/?api=1${origin}${dest}${wp}&travelmode=driving`;
}

// ── Compass bearing + reverse geocoding for auto-naming routes ──

const COMPASS_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/**
 * Compute compass bearing from a well to a route's start point.
 * Returns the direction the driver approaches FROM (looking outward from the well).
 */
export function computeRouteBearing(
  wellLat: number,
  wellLng: number,
  startLat: number,
  startLng: number,
): { degrees: number; compass: string } {
  const lat1 = wellLat * DEG_TO_RAD;
  const lat2 = startLat * DEG_TO_RAD;
  const dLng = (startLng - wellLng) * DEG_TO_RAD;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const degrees = (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
  // Map to 8-point compass (each sector = 45 degrees, offset by 22.5)
  const idx = Math.round(degrees / 45) % 8;
  return { degrees, compass: COMPASS_LABELS[idx] };
}

const GEOCODING_API_KEY = 'AIzaSyDY_JNtqytvj-QQcwSF1zT1QD67Xlorurw';

/**
 * Reverse geocode a GPS coordinate to get the nearest road, town, or county name.
 * Used to auto-name routes on approval (e.g., "From NW via US-85").
 * Returns null on any failure — never throws.
 */
export async function reverseGeocodeStartPoint(
  lat: number,
  lng: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json` +
      `?latlng=${lat},${lng}` +
      `&result_type=route|locality|administrative_area_level_2` +
      `&key=${GEOCODING_API_KEY}`;

    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json();

    if (data.status !== 'OK' || !data.results?.length) return null;

    // Priority: road/highway > town > county
    for (const result of data.results) {
      const types: string[] = result.types || [];
      if (types.includes('route')) {
        return cleanRoadName(result.address_components?.[0]?.long_name || result.formatted_address);
      }
    }
    for (const result of data.results) {
      const types: string[] = result.types || [];
      if (types.includes('locality')) {
        return result.address_components?.[0]?.long_name || null;
      }
    }
    for (const result of data.results) {
      const types: string[] = result.types || [];
      if (types.includes('administrative_area_level_2')) {
        return result.address_components?.[0]?.long_name || null;
      }
    }

    // Last resort: first segment of formatted address
    const first = data.results[0]?.formatted_address;
    if (first) return first.split(',')[0].trim();

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Clean up road names for display: "US Route 85" → "US-85", etc. */
function cleanRoadName(name: string): string {
  if (!name) return name;
  return name
    .replace(/^United States Highway\s+/i, 'US-')
    .replace(/^US Route\s+/i, 'US-')
    .replace(/^US Highway\s+/i, 'US-')
    .replace(/^North Dakota Highway\s+/i, 'Hwy ')
    .replace(/^Montana Highway\s+/i, 'Hwy ')
    .replace(/^State Highway\s+/i, 'Hwy ')
    .replace(/^State Route\s+/i, 'Hwy ')
    .replace(/^County Road\s+/i, 'CR ')
    .replace(/^County Route\s+/i, 'CR ')
    .replace(/^Township Road\s+/i, 'Twp Rd ')
    .trim();
}

/**
 * Generate an auto-label for an approved route based on compass bearing + landmark.
 * Checks for collisions with existing routes to disambiguate.
 */
export function buildAutoLabel(
  compass: string,
  landmark: string | null,
  distanceMiles: number,
  existingLabels: string[],
): string {
  const base = landmark ? `From ${compass} via ${landmark}` : `From ${compass}`;

  // Check if this label already exists (collision)
  if (!existingLabels.some(l => l === base)) return base;

  // Collision — append distance to disambiguate
  return `${base} (${distanceMiles.toFixed(0)} mi)`;
}
