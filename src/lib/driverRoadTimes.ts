import type { ArrivalPoint, ArrivalTravel } from './driverArrivalRecommendations.ts';

/** One explicit comparison only. No timers, cross-comparison cache or persisted Google data. */
export function createDriverRoadComparison(options: {
  apiKey?: string; signal?: AbortSignal; fetcher?: typeof fetch; timeoutMs?: number;
} = {}) {
  const apiKey = options.apiKey ?? process.env.NEXT_PUBLIC_DRIVER_ROUTES_API_KEY ?? '';
  const fetcher = options.fetcher ?? fetch;
  const sharedLegs = new Map<string, Promise<ArrivalTravel | null>>();
  let lookups = 0, failures = 0;
  const roadTime = (from: ArrivalPoint, to: ArrivalPoint): Promise<ArrivalTravel | null> => {
    if (!apiKey || options.signal?.aborted) return Promise.resolve(null);
    const id = JSON.stringify([from.lat, from.lng, to.lat, to.lng]);
    const existing = sharedLegs.get(id);
    if (existing) return existing;
    const pending = (async () => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, options.timeoutMs ?? 10000);
      try {
        lookups++;
        const waypoint = (p: ArrivalPoint) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
        const response = await fetcher('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'originIndex,destinationIndex,status,condition,duration,distanceMeters' },
          body: JSON.stringify({ origins: [waypoint(from)], destinations: [waypoint(to)],
            travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE' }),
        });
        const data = await response.json();
        const row = Array.isArray(data) ? data.find(r => (r.originIndex ?? 0) === 0 && (r.destinationIndex ?? 0) === 0) : null;
        if (!response.ok || !row || row.condition !== 'ROUTE_EXISTS' || (row.status?.code ?? 0) !== 0
          || typeof row.duration !== 'string' || !/^\d+(?:\.\d+)?s$/.test(row.duration)
          || typeof row.distanceMeters !== 'number' || !Number.isFinite(row.distanceMeters) || row.distanceMeters < 0) {
          failures++; return null;
        }
        const minutes = parseFloat(row.duration) / 60;
        if (!Number.isFinite(minutes) || minutes < 0) { failures++; return null; }
        return { minutes, miles: row.distanceMeters / 1609.344, source: 'road' as const };
      } catch { failures++; return null; }
      finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
    })();
    sharedLegs.set(id, pending);
    return pending;
  };
  return { roadTime, usage: () => ({ lookups, failures, configured: !!apiKey }) };
}
