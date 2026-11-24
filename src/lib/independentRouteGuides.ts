export type IndependentRouteGuide = {
  id: string;
  title: string;
  locations: string[];
  imageUrls: string[];
  routeWaypoints?: { lat: number; lng: number }[];
  padPins?: { label: string; location: string; url: string; lat?: number; lng?: number; matchTerms?: string[]; coversFamily?: boolean }[];
  directionsUrl?: string;
};

type RouteJob = { pickup?: string; destination?: string; asset?: string; additionalStops?: string[] };

/** Operator request name for the saved Daredevil 1 pad pin. */
function knownPadAlias(places: string, pin: NonNullable<IndependentRouteGuide['padPins']>[number]): boolean {
  return /^Daredevil 1$/i.test(pin.label.trim()) && /^Daredevil$/i.test(pin.location.trim())
    && /\bDaredevil\s+Fed\.?\s*2-2-14H\b/i.test(places);
}

/** A guide applies when a named well appears at either end of the job. */
export function routeGuidesForJob(job: RouteJob, guides: IndependentRouteGuide[] = []): IndependentRouteGuide[] {
  const places = [job.pickup, job.destination, job.asset, ...(job.additionalStops || [])].filter(Boolean).join(' ');
  return guides.filter(guide => guide.locations.some(location => {
    const name = location.trim();
    return name.length > 1 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(places);
  }));
}

/** Show all saved pins for a named well family; dispatch chooses the exact pad. */
export function padPinsForJob(job: RouteJob, guide: IndependentRouteGuide) {
  const destination = [job.destination, job.asset].filter(Boolean).join(' ');
  const matchingFamily = (places: string) => (guide.padPins || []).filter(pin => {
    const name = pin.location.trim();
    return name.length > 1 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(places);
  });
  const family = matchingFamily(destination);
  const places = family.length ? destination : job.pickup || '';
  const candidates = family.length ? family : matchingFamily(places);
  const exact = candidates.filter(pin => knownPadAlias(places, pin) || (pin.matchTerms || []).some(term =>
    new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(places)));
  return exact.length ? exact : candidates;
}

export function identifiedPadPin(job: RouteJob, guide: IndependentRouteGuide) {
  const pins = padPinsForJob(job, guide);
  if (pins.length !== 1) return null;
  const pin = pins[0];
  const destination = [job.destination, job.asset].filter(Boolean).join(' ');
  const family = new RegExp(`\\b${pin.location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const places = family.test(destination) ? destination : job.pickup || '';
  if (pin.coversFamily) return pin;
  return knownPadAlias(places, pin) || (pin.matchTerms || []).some(term =>
    new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(places)) ? pin : null;
}

/** Three saved turns keep the route on the approved access road from either approach. */
export function plannedGoogleRouteUrl(guide: IndependentRouteGuide, pin: NonNullable<IndependentRouteGuide['padPins']>[number]): string | null {
  const stops = guide.routeWaypoints;
  if (!stops || stops.length !== 3 || !Number.isFinite(pin.lat) || !Number.isFinite(pin.lng)) return null;
  if (stops.some(point => !Number.isFinite(point.lat) || !Number.isFinite(point.lng))) return null;
  const params = new URLSearchParams({ api: '1', destination: `${pin.lat},${pin.lng}`, travelmode: 'driving',
    waypoints: stops.map(point => `${point.lat},${point.lng}`).join('|') });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Search shows a location without silently treating Google's route as approved access. */
export function googleMapsSearchUrl(location: string | undefined): string | null {
  const query = location?.trim();
  if (!query || query.length > 180) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** Use a saved pad pin for a named well; never send a driver to a Google text search for an ambiguous pad. */
export function jobLocationMapUrl(location: string | undefined, guides: IndependentRouteGuide[] = []): string | null {
  const matchingGuides = routeGuidesForJob({ destination: location }, guides);
  for (const guide of matchingGuides) {
    const pin = identifiedPadPin({ destination: location }, guide);
    if (pin?.url) return pin.url;
  }
  if (matchingGuides.some(guide => padPinsForJob({ destination: location }, guide).length > 0)) return null;
  return googleMapsSearchUrl(location);
}

export function googleMapsDirectionsUrl(pickup: string | undefined, destination: string | undefined): string | null {
  const origin = pickup?.trim();
  const end = destination?.trim();
  if (!origin || !end || origin.length > 180 || end.length > 180 || /\s+or\s+/i.test(origin)) return null;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(end)}&travelmode=driving`;
}

/** Route from the driver's current position; a named site still needs dispatch confirmation. */
export function googleMapsRouteToUrl(location: string | undefined): string | null {
  const destination = location?.trim();
  if (!destination || destination.length > 180 || /\s+or\s+/i.test(destination)) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`;
}
