import { asTrimmedString, formatTimeDisplay } from './format';
import type { PaperTimelineEvent } from './types';

interface RawEvent {
  type?: unknown;
  timestamp?: unknown;
  locationName?: unknown;
  reason?: unknown;
}

function asEvents(raw: unknown): RawEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => e && typeof e === 'object') as RawEvent[];
}

export function labelTimelineEvent(
  type: string,
  arriveCount: number,
  departSiteCount: number,
  reason: string,
): string {
  if (type === 'depart') return 'Start / Departed';
  if (type === 'arrive') return arriveCount % 2 === 1 ? 'Pickup Arrival' : 'Drop-off Arrival';
  if (type === 'depart_site') {
    return departSiteCount % 2 === 1 ? 'Loaded / Departure' : 'Unloaded / Departure';
  }
  if (type === 'close') return 'Job Closed';
  if (type === 'pause') return reason ? `Paused — ${reason}` : 'Paused';
  if (type === 'resume') return 'Resumed';
  if (type === 'transfer') return 'Load Transferred';
  if (type === 'accept') return 'Accepted';
  if (type === 'reroute') return 'Rerouted';
  return type || 'Event';
}

export function buildPaperTimeline(raw: unknown, timeZone: string): PaperTimelineEvent[] {
  const events = asEvents(raw)
    .map((e) => ({
      type: asTrimmedString(e.type),
      timestamp: asTrimmedString(e.timestamp),
      locationName: asTrimmedString(e.locationName),
      reason: asTrimmedString(e.reason),
    }))
    .filter((e) => e.timestamp)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  let arriveCount = 0;
  let departSiteCount = 0;
  return events.map((e) => {
    if (e.type === 'arrive') arriveCount += 1;
    if (e.type === 'depart_site') departSiteCount += 1;
    return {
      type: e.type,
      timestamp: e.timestamp,
      timeDisplay: formatTimeDisplay(e.timestamp, timeZone),
      label: labelTimelineEvent(e.type, arriveCount, departSiteCount, e.reason),
      locationName: e.locationName,
    };
  });
}

export function acceptedTimeFromInvoice(invoice: {
  invoiceStartedAt?: unknown;
  timeline?: unknown;
  startTime?: unknown;
}, timeZone: string): string {
  const started = asTrimmedString(invoice.invoiceStartedAt);
  if (started) return formatTimeDisplay(started, timeZone);
  const events = asEvents(invoice.timeline);
  const depart = events.find((e) => asTrimmedString(e.type) === 'depart');
  if (depart && depart.timestamp) return formatTimeDisplay(depart.timestamp, timeZone);
  const startTime = asTrimmedString(invoice.startTime);
  if (startTime) return formatTimeDisplay(startTime, timeZone);
  return '';
}
