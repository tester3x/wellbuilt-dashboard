import type { IndependentJob } from './independentDispatchJobs';
import { googleMapsRouteToUrl, googleMapsSearchUrl, identifiedPadPin, plannedGoogleRouteUrl, routeGuidesForJob, type IndependentRouteGuide } from './independentRouteGuides';

type WhatsAppJob = Pick<IndependentJob,
  'title' | 'customer' | 'pickup' | 'destination' | 'additionalStops' | 'cargo' | 'reference' | 'notes' |
  'scheduledAt' | 'requestedDriverCount' | 'jobContactName' | 'jobContactPhoneE164' | 'drivers' | 'driverName'
>;

export type IndependentDispatchUrgency = 'urgent' | 'soon' | 'routine';

/** Presentation only; a time-based flag never changes the saved job or dispatch authority. */
export function independentDispatchUrgency(job: WhatsAppJob, nowMs = Date.now()): IndependentDispatchUrgency {
  if (/\b(asap|emergency|urgent|immediately)\b/i.test(job.notes || '')) return 'urgent';
  const dueMs = job.scheduledAt ? Date.parse(job.scheduledAt) : NaN;
  if (!Number.isFinite(dueMs)) return 'routine';
  const minutesRemaining = (dueMs - nowMs) / 60_000;
  if (minutesRemaining <= 60) return 'urgent';
  if (minutesRemaining <= 240) return 'soon';
  return 'routine';
}

export function buildIndependentWhatsAppText(job: WhatsAppJob, recipientName?: string, nowMs = Date.now(), guides: IndependentRouteGuide[] = [], includeEmojiAlert = false): string {
  const urgency = independentDispatchUrgency(job, nowMs);
  const heading = urgency === 'urgent' ? '*URGENT DISPATCH*'
    : urgency === 'soon' ? '*UPCOMING DISPATCH*'
      : '*JOB DISPATCH*';
  const crew = job.drivers || [];
  const shiftGroup = (shift: 'day' | 'night' | '') => crew.filter(driver => (driver.shift || '') === shift).map(driver => driver.name).filter(Boolean);
  const day = shiftGroup('day');
  const night = shiftGroup('night');
  const unset = shiftGroup('');
  const shiftBlock = (label: string, names: string[]) => names.length
    ? `*${label}*\n${names.map(name => `- ${name}`).join('\n')}` : '';
  const assigned = crew.length
    ? [shiftBlock('DAY SHIFT', day), shiftBlock('NIGHT SHIFT', night), shiftBlock('SHIFT NOT SET', unset)].filter(Boolean).join('\n\n')
    : job.driverName ? `- ${job.driverName}` : '';
  const accessGuides = routeGuidesForJob(job, guides);
  const mapFor = (location: string | undefined) => {
    const matchingGuides = routeGuidesForJob({ destination: location }, guides);
    const identified = matchingGuides.map(guide => ({ guide, pin: identifiedPadPin({ destination: location }, guide) }))
      .find(({ pin }) => pin);
    const route = identified ? plannedGoogleRouteUrl(identified.guide, identified.pin!) : null;
    const pin = identified?.pin;
    const enteredGps = location?.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
    const coordinates = pin && Number.isFinite(pin.lat) && Number.isFinite(pin.lng)
      ? { lat: pin.lat!, lng: pin.lng! }
      : enteredGps && Math.abs(Number(enteredGps[1])) <= 90 && Math.abs(Number(enteredGps[2])) <= 180
        ? { lat: Number(enteredGps[1]), lng: Number(enteredGps[2]) } : null;
    const gps = coordinates ? `${Math.abs(coordinates.lat)}° ${coordinates.lat < 0 ? 'S' : 'N'}, ${Math.abs(coordinates.lng)}° ${coordinates.lng < 0 ? 'W' : 'E'}` : null;
    const pinUrl = coordinates ? googleMapsSearchUrl(`${coordinates.lat},${coordinates.lng}`) : pin?.url || null;
    const direction = route || (matchingGuides.length ? null : googleMapsRouteToUrl(coordinates ? `${coordinates.lat},${coordinates.lng}` : location));
    return { url: direction || (!matchingGuides.length ? googleMapsSearchUrl(location) : null), pinUrl, gps,
      kind: route ? 'approved' : direction ? 'route' : 'search', specialAccess: matchingGuides.length > 0 };
  };
  const locationSection = (heading: string, location: string, legLabel: string) => {
    const map = mapFor(location);
    const mapLabel = map.kind === 'approved' ? `Route to ${legLabel}`
      : map.specialAccess ? `Route to ${legLabel} — confirm exact site with dispatch`
        : map.kind === 'route' ? `Route to ${legLabel}${map.gps ? '' : ' — confirm exact site'}`
          : `Location search for ${legLabel} — confirm exact site`;
    const accessNote = map.specialAccess ? map.kind === 'approved'
      ? 'Open this route first. Verify turns 1, 2 and 3 before driving; Google may recalculate.'
      : 'Confirm the exact pad with dispatch. Check the access photos and follow approved turns 1, 2 and 3; Google may recalculate.'
      : map.kind === 'route' && !map.gps ? 'Confirm this is the exact site before driving; Google may choose a similar name.' : '';
    return [`*${heading}*`, location, map.gps ? `GPS pin: ${map.gps}` : '',
      map.pinUrl ? `Pin drop: ${map.pinUrl}` : '',
      `${mapLabel}:`, accessNote, map.url || 'Confirm location with dispatch before driving.'].filter(Boolean).join('\n');
  };
  const driverBlock = `*ASSIGNED DRIVERS*\n${assigned || 'No driver assigned yet'}${job.requestedDriverCount ? `\nDrivers requested: ${job.requestedDriverCount}` : ''}`;
  const sections = [
    includeEmojiAlert && urgency === 'urgent' ? `🚨🚨🚨🚨🚨👆🏽\n${heading}` : heading,
    ['*JOB*', job.title, `Customer: ${job.customer}`,
      job.reference ? `Reference: ${job.reference}` : '',
      recipientName ? `For: ${recipientName}` : ''].filter(Boolean).join('\n'),
    job.scheduledAt ? `*SCHEDULE*\nScheduled pickup (UTC): ${new Date(job.scheduledAt).toISOString()}` : '',
    driverBlock,
    job.notes ? `*DESCRIPTION / INSTRUCTIONS*\n${job.notes}` : '',
    job.pickup?.trim() ? locationSection('PICKUP / SOURCE', job.pickup, 'Pickup') : '',
    ...(job.additionalStops || []).filter(Boolean).map((stop, index) => locationSection(`STOP ${index + 1}`, stop, `Stop ${index + 1}`)),
    job.destination?.trim() ? locationSection('DELIVERY / DESTINATION', job.destination, 'Delivery') : '',
    ...accessGuides.map(guide => guide.imageUrls.length
      ? `*ACCESS PHOTOS — ${guide.title.toUpperCase()}*\n${guide.imageUrls.map((url, index) => `${index === 0 ? 'Photo 1 — satellite overview' : index === 1 ? 'Photo 2 — marked safe turn / avoid farmer road' : `Photo ${index + 1} — access map`}: ${url}`).join('\n')}` : ''),
    job.cargo ? `*CARGO / LOADS*\n${job.cargo}` : '',
    [job.jobContactName ? `Job contact: ${job.jobContactName}` : '',
      job.jobContactPhoneE164 ? `Contact phone: ${job.jobContactPhoneE164}` : ''].filter(Boolean).join('\n'),
    '*ACKNOWLEDGMENT*\nDrivers: react with a thumbs-up to this dispatch message to confirm you saw it. If reactions are unavailable, reply ACK privately to dispatch.',
  ];
  return sections.filter(Boolean).join('\n\n');
}

export function normalizeWhatsAppNumber(phone: string | undefined): string | null {
  const trimmed = phone?.trim() || '';
  return /^\+[1-9]\d{7,14}$/.test(trimmed) ? trimmed.slice(1) : null;
}

export function independentWhatsAppGroupShareUrl(job: WhatsAppJob, guides: IndependentRouteGuide[] = []): string {
  return 'https://wa.me/?text=' + encodeURIComponent(buildIndependentWhatsAppText(job, undefined, Date.now(), guides));
}

export function independentWhatsAppDriverUrl(job: WhatsAppJob, name: string, phone: string | undefined, guides: IndependentRouteGuide[] = []): string | null {
  const digits = normalizeWhatsAppNumber(phone);
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(buildIndependentWhatsAppText(job, name, Date.now(), guides))}` : null;
}
