import type { IndependentJob } from './independentDispatchJobs';
import { googleMapsSearchUrl, identifiedPadPin, jobLocationMapUrl, plannedGoogleRouteUrl, routeGuidesForJob, type IndependentRouteGuide } from './independentRouteGuides';

type WhatsAppJob = Pick<IndependentJob,
  'title' | 'customer' | 'pickup' | 'destination' | 'cargo' | 'reference' | 'notes' |
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
    const savedLocation = jobLocationMapUrl(location, guides);
    const pin = identified?.pin;
    const gps = pin && Number.isFinite(pin.lat) && Number.isFinite(pin.lng) ? `${pin.lat}, ${pin.lng}` : null;
    const pinUrl = gps ? googleMapsSearchUrl(`${pin!.lat},${pin!.lng}`) : pin?.url || null;
    return { url: route || (!matchingGuides.length ? savedLocation || googleMapsSearchUrl(location) : null), pinUrl, gps,
      kind: route ? 'route' : identified ? 'pin' : 'search', specialAccess: matchingGuides.length > 0 };
  };
  const pickupMap = mapFor(job.pickup);
  const deliveryMap = mapFor(job.destination);
  const locationSection = (heading: string, location: string | undefined, map: ReturnType<typeof mapFor>, leg: 'pickup' | 'delivery') => {
    const legLabel = leg === 'pickup' ? 'Pickup' : 'Delivery';
    const mapLabel = map.kind === 'route' ? `Route to ${legLabel}`
      : map.specialAccess && map.kind === 'search' ? `Route to ${legLabel} — confirm exact site with dispatch`
        : map.kind === 'pin' ? `${leg === 'pickup' ? 'Pickup' : 'Delivery'} pin — confirm driving route`
          : `${leg === 'pickup' ? 'Pickup' : 'Delivery'} map`;
    const accessNote = map.specialAccess ? map.kind === 'route'
      ? 'Open this route first. Verify turns 1, 2 and 3 before driving; Google may recalculate.'
      : 'Confirm the exact pad with dispatch. Check the access photos and follow approved turns 1, 2 and 3; Google may recalculate.' : '';
    return [`*${heading}*`, location || 'Not specified', map.gps ? `GPS pin: ${map.gps}` : '',
      map.pinUrl ? `Pin drop: ${map.pinUrl}` : '',
      map.url || map.specialAccess ? `${mapLabel}:` : '', accessNote, map.url || ''].filter(Boolean).join('\n');
  };
  const driverBlock = `*ASSIGNED DRIVERS*\n${assigned || 'No driver assigned yet'}${job.requestedDriverCount ? `\nDrivers requested: ${job.requestedDriverCount}` : ''}`;
  const sections = [
    includeEmojiAlert && urgency === 'urgent' ? `🚨🚨🚨🚨🚨👆🏽\n${heading}` : heading,
    ['*JOB*', job.title, `Customer: ${job.customer}`,
      job.reference ? `Reference: ${job.reference}` : '',
      recipientName ? `For: ${recipientName}` : ''].filter(Boolean).join('\n'),
    driverBlock,
    job.notes ? `*DESCRIPTION / INSTRUCTIONS*\n${job.notes}` : '',
    locationSection('PICKUP / SOURCE', job.pickup, pickupMap, 'pickup'),
    locationSection('DELIVERY / DESTINATION', job.destination, deliveryMap, 'delivery'),
    ...accessGuides.map(guide => guide.imageUrls.length
      ? `*ACCESS PHOTOS — ${guide.title.toUpperCase()}*\n${guide.imageUrls.map((url, index) => `${index === 0 ? 'Photo 1 — satellite overview' : index === 1 ? 'Photo 2 — marked safe turn / avoid farmer road' : `Photo ${index + 1} — access map`}: ${url}`).join('\n')}` : ''),
    job.cargo ? `*CARGO / LOADS*\n${job.cargo}` : '',
    job.scheduledAt ? `*SCHEDULE*\nScheduled pickup (UTC): ${new Date(job.scheduledAt).toISOString()}` : '',
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
