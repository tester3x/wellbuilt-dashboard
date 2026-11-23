'use client';

import type { IndependentJob } from '@/lib/independentDispatchJobs';
import { independentWhatsAppGroupShareUrl } from '@/lib/independentWhatsAppDispatch';

export function IndependentWhatsAppLinks({ job }: { job: IndependentJob }) {
  const crew = job.drivers || (job.externalDriverId
    ? [{ key: `outside:${job.externalDriverId}`, name: job.driverName || 'Assigned driver', source: 'outside' as const }]
    : []);
  if (!['assigned', 'in_progress'].includes(job.status) || crew.length === 0) return null;

  return <section className="mt-3 rounded border border-sky-900/70 bg-sky-950/20 px-3 py-2 text-sm">
    <p className="font-medium text-sky-200">WhatsApp dispatch handoff</p>
    <div className="mt-2 flex flex-wrap items-center gap-3">
      {job.status === 'in_progress' ? <a href={independentWhatsAppGroupShareUrl(job)}
        target="_blank" rel="noopener noreferrer" data-testid="independent-whatsapp-share"
        className="rounded border border-sky-700 px-3 py-1.5 text-sky-200 hover:bg-sky-900/50">
        Share job on WhatsApp
      </a> : <span className="text-xs text-gray-300">Mark started to prepare the WhatsApp job handoff.</span>}
      <span className="text-xs text-gray-400">{crew.length} assigned driver{crew.length === 1 ? '' : 's'}</span>
    </div>
    {job.status === 'in_progress' && <p className="mt-2 text-xs text-gray-400">
      Choose the main dispatch group and up to four assigned drivers in WhatsApp (five chats per batch).
      For larger crews, share again with remaining drivers; include the main group only once.
      The dashboard cannot preselect recipients or detect which chats you sent to.
    </p>}
    {crew.some(member => member.source === 'wellbuilt') && <p className="mt-1 text-xs text-gray-400">
      WellBuilt-driver contact numbers are not available to this handoff; select verified contacts in WhatsApp.
    </p>}
    <p className="mt-2 text-xs text-gray-400">
      Press Send in WhatsApp. Sending is not a driver acknowledgment; the driver must acknowledge separately.
    </p>
  </section>;
}
