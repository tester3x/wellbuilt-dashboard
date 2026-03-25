// lib/directions.ts — Google Distance Matrix API for drive time calculations
//
// Used by dispatch ETA calculations to estimate driver arrival times.

const API_KEY = 'AIzaSyDCfKaRQ7Wr3VvIJ0kX4d2xmC9CO3EBRUs'; // Same key as WB T

interface DistanceResult {
  durationMinutes: number;
  distanceMiles: number;
}

/**
 * Get drive times from multiple origins to a single destination.
 * Uses Google Distance Matrix API (server-side compatible).
 * Returns null for any origin that fails.
 */
export async function getDistanceMatrix(
  origins: Array<{ lat: number; lng: number }>,
  destination: { lat: number; lng: number },
): Promise<Array<DistanceResult | null>> {
  if (origins.length === 0) return [];

  const originsStr = origins.map(o => `${o.lat},${o.lng}`).join('|');
  const destStr = `${destination.lat},${destination.lng}`;

  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${originsStr}&destinations=${destStr}&mode=driving&departure_time=now&key=${API_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== 'OK') {
      console.warn('[directions] Distance Matrix API error:', data.status, data.error_message);
      return origins.map(() => null);
    }

    return data.rows.map((row: any) => {
      const el = row.elements?.[0];
      if (!el || el.status !== 'OK') return null;
      return {
        durationMinutes: Math.round((el.duration_in_traffic?.value || el.duration?.value || 0) / 60),
        distanceMiles: Math.round((el.distance?.value || 0) / 1609.34 * 10) / 10,
      };
    });
  } catch (err) {
    console.warn('[directions] Distance Matrix API call failed:', err);
    return origins.map(() => null);
  }
}
