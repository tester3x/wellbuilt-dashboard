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
 * No origin — Google uses the recipient's current location.
 * Waypoints are pipe-separated lat,lng pairs.
 */
export function buildGoogleMapsUrl(
  waypoints: Array<{ lat: number; lng: number }>,
  destLat: number,
  destLng: number,
): string {
  const dest = `&destination=${destLat},${destLng}`;
  const wp = waypoints.length > 0
    ? `&waypoints=${waypoints.map(w => `${w.lat},${w.lng}`).join('|')}`
    : '';
  return `https://www.google.com/maps/dir/?api=1${dest}${wp}&travelmode=driving`;
}
