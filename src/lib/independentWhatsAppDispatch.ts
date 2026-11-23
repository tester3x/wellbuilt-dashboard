import type { IndependentJob } from './independentDispatchJobs';

type WhatsAppJob = Pick<IndependentJob,
  'title' | 'customer' | 'pickup' | 'destination' | 'cargo' | 'reference' | 'notes' |
  'scheduledAt' | 'requestedDriverCount' | 'jobContactName' | 'jobContactPhoneE164' | 'drivers' | 'driverName'
>;

export function buildIndependentWhatsAppText(job: WhatsAppJob, recipientName?: string): string {
  const assigned = job.drivers?.map(driver => driver.name).filter(Boolean).join(', ') || job.driverName || '';
  const rows = [
    recipientName ? `DRIVER ASSIGNMENT: ${recipientName}` : `DISPATCH: ${job.title}`,
    `Job: ${job.title}`,
    `Customer: ${job.customer}`,
    job.reference ? `Reference: ${job.reference}` : '',
    `Pickup: ${job.pickup || 'Not specified'}`,
    `Delivery: ${job.destination || 'Not specified'}`,
    job.cargo ? `Cargo / loads: ${job.cargo}` : '',
    job.scheduledAt ? `Scheduled pickup (UTC): ${new Date(job.scheduledAt).toISOString()}` : '',
    job.requestedDriverCount ? `Drivers requested: ${job.requestedDriverCount}` : '',
    assigned ? `Assigned drivers: ${assigned}` : '',
    job.jobContactName ? `Job contact: ${job.jobContactName}` : '',
    job.jobContactPhoneE164 ? `Contact phone: ${job.jobContactPhoneE164}` : '',
    job.notes ? `Instructions: ${job.notes}` : '',
    recipientName ? 'Please acknowledge this assignment in WhatsApp.' : '',
  ];
  return rows.filter(Boolean).join('\n');
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
