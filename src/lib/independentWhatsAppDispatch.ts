import type { IndependentJob } from './independentDispatchJobs';

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

export function buildIndependentWhatsAppText(job: WhatsAppJob, recipientName?: string, nowMs = Date.now()): string {
  const urgency = independentDispatchUrgency(job, nowMs);
  const heading = urgency === 'urgent' ? '🚨🚨🚨🚨🚨\n*URGENT DISPATCH*'
    : urgency === 'soon' ? '🟠🟠🟠🟠🟠\n*UPCOMING DISPATCH*'
      : '🟡🟡🟡🟡🟡\n*JOB DISPATCH*';
  const crew = job.drivers || [];
  const shiftGroup = (shift: 'day' | 'night' | '') => crew.filter(driver => (driver.shift || '') === shift).map(driver => driver.name).filter(Boolean);
  const day = shiftGroup('day');
  const night = shiftGroup('night');
  const unset = shiftGroup('');
  const assigned = crew.length
    ? [day.length ? `Day Shift:\n${day.join('\n')}` : '', night.length ? `Night Shift:\n${night.join('\n')}` : '',
      unset.length ? `Shift not set:\n${unset.join('\n')}` : ''].filter(Boolean).join('\n')
    : job.driverName || '';
  const sections = [
    heading,
    ['*JOB*', job.title, `Customer: ${job.customer}`,
      job.reference ? `Reference: ${job.reference}` : '',
      recipientName ? `For: ${recipientName}` : ''].filter(Boolean).join('\n'),
    job.notes ? `*DESCRIPTION / INSTRUCTIONS*\n${job.notes}` : '',
    `*PICKUP / SOURCE*\n${job.pickup || 'Not specified'}`,
    `*DELIVERY / DESTINATION*\n${job.destination || 'Not specified'}`,
    job.cargo ? `*CARGO / LOADS*\n${job.cargo}` : '',
    job.scheduledAt ? `*SCHEDULE*\nScheduled pickup (UTC): ${new Date(job.scheduledAt).toISOString()}` : '',
    [job.requestedDriverCount ? `Drivers requested: ${job.requestedDriverCount}` : '',
      assigned ? `Assigned drivers:\n${assigned}` : ''].filter(Boolean).join('\n'),
    [job.jobContactName ? `Job contact: ${job.jobContactName}` : '',
      job.jobContactPhoneE164 ? `Contact phone: ${job.jobContactPhoneE164}` : ''].filter(Boolean).join('\n'),
    '*ACKNOWLEDGMENT*\nDrivers: reply ACK privately to dispatch in WhatsApp to confirm this assignment. Do not reply in the group.',
  ];
  return sections.filter(Boolean).join('\n\n');
}

export function normalizeWhatsAppNumber(phone: string | undefined): string | null {
  const trimmed = phone?.trim() || '';
  return /^\+[1-9]\d{7,14}$/.test(trimmed) ? trimmed.slice(1) : null;
}

export function independentWhatsAppGroupShareUrl(job: WhatsAppJob): string {
  return 'https://wa.me/?text=' + encodeURIComponent(buildIndependentWhatsAppText(job));
}

export function independentWhatsAppDriverUrl(job: WhatsAppJob, name: string, phone: string | undefined): string | null {
  const digits = normalizeWhatsAppNumber(phone);
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(buildIndependentWhatsAppText(job, name))}` : null;
}
