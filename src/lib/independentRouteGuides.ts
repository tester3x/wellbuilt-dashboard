export type IndependentRouteGuide = {
  id: string;
  title: string;
  locations: string[];
  imageUrls: string[];
  padPins?: { label: string; location: string; url: string }[];
  directionsUrl?: string;
};

type RouteJob = { pickup?: string; destination?: string; asset?: string };

/** A guide applies when a named well appears at either end of the job. */
export function routeGuidesForJob(job: RouteJob, guides: IndependentRouteGuide[] = []): IndependentRouteGuide[] {
  const places = [job.pickup, job.destination, job.asset].filter(Boolean).join(' ');
  return guides.filter(guide => guide.locations.some(location => {
    const name = location.trim();
    return name.length > 1 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(places);
  }));
}

/** Show all saved pins for a named well family; dispatch chooses the exact pad. */
export function padPinsForJob(job: RouteJob, guide: IndependentRouteGuide) {
  const places = [job.pickup, job.destination, job.asset].filter(Boolean).join(' ');
  return (guide.padPins || []).filter(pin => {
    const name = pin.location.trim();
    return name.length > 1 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(places);
  });
}

/** Search shows a location without silently treating Google's route as approved access. */
export function googleMapsSearchUrl(location: string | undefined): string | null {
  const query = location?.trim();
  if (!query || query.length > 180) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function googleMapsDirectionsUrl(pickup: string | undefined, destination: string | undefined): string | null {
  const origin = pickup?.trim();
  const end = destination?.trim();
  if (!origin || !end || origin.length > 180 || end.length > 180 || /\s+or\s+/i.test(origin)) return null;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(end)}&travelmode=driving`;
}
