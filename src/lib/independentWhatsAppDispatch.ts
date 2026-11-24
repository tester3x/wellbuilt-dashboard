import type { IndependentJob } from './independentDispatchJobs';
import { googleMapsDirectionsUrl, googleMapsSearchUrl, padPinsForJob, routeGuidesForJob, type IndependentRouteGuide } from './independentRouteGuides';

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
  const pickupMap = googleMapsSearchUrl(job.pickup);
  const deliveryMap = googleMapsSearchUrl(job.destination);
  const directions = accessGuides.length ? null : googleMapsDirectionsUrl(job.pickup, job.destination);
  const sections = [
    includeEmojiAlert && urgency === 'urgent' ? `🚨🚨🚨🚨🚨👆🏽\n${heading}` : heading,
    ['*JOB*', job.title, `Customer: ${job.customer}`,
      job.reference ? `Reference: ${job.reference}` : '',
      recipientName ? `For: ${recipientName}` : ''].filter(Boolean).join('\n'),
    job.notes ? `*DESCRIPTION / INSTRUCTIONS*\n${job.notes}` : '',
    `*PICKUP / SOURCE*\n${job.pickup || 'Not specified'}`,
    `*DELIVERY / DESTINATION*\n${job.destination || 'Not specified'}`,
    [pickupMap ? `Pickup map: ${pickupMap}` : '', deliveryMap ? `Delivery map: ${deliveryMap}` : ''].filter(Boolean).join('\n'),
    ...accessGuides.map(guide => `*APPROVED ACCESS ROUTE: ${guide.title.toUpperCase()}*\nFollow the blue route in these maps. Avoid the marked roads near the farmer's home. Google Maps may suggest a different road; the approved access maps take priority.\n${guide.imageUrls.map((url, index) => `Route map ${index + 1}: ${url}`).join('\n')}${padPinsForJob(job, guide).length ? `\n*PAD PINS — CONFIRM THE CORRECT PAD*\n${padPinsForJob(job, guide).map(pin => `${pin.label}: ${pin.url}`).join('\n')}` : ''}${guide.directionsUrl ? `\nGoogle Maps planned route (verify against the access maps): ${guide.directionsUrl}` : ''}`),
    directions ? `Google Maps directions: ${directions}` : '',
    job.cargo ? `*CARGO / LOADS*\n${job.cargo}` : '',
    job.scheduledAt ? `*SCHEDULE*\nScheduled pickup (UTC): ${new Date(job.scheduledAt).toISOString()}` : '',
    [job.requestedDriverCount ? `Drivers requested: ${job.requestedDriverCount}` : '',
      assigned ? `*ASSIGNED DRIVERS*\n${assigned}` : ''].filter(Boolean).join('\n\n'),
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
