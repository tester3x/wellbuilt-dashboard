'use client';

import type { IndependentJob } from '@/lib/independentDispatchJobs';
import { buildIndependentWhatsAppText, independentWhatsAppGroupShareUrl } from '@/lib/independentWhatsAppDispatch';

export function IndependentWhatsAppLinks({ job }: { job: IndependentJob }) {
  if (!['assigned', 'in_progress'].includes(job.status) || !(job.drivers?.length || job.externalDriverId || job.wbDriverId)) return null;

  return <section className="mt-3 rounded border border-sky-900/70 bg-sky-950/20 px-3 py-2 text-sm">
    <p className="font-medium text-sky-200">WhatsApp dispatch handoff</p>
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <a href={independentWhatsAppGroupShareUrl(job)}
        target="_blank" rel="noopener noreferrer" data-testid="independent-whatsapp-share"
        className="rounded border border-sky-700 px-3 py-1.5 text-sky-200 hover:bg-sky-900/50">
        Share job to crew on WhatsApp
      </a>
    </div>
    <p className="mt-2 text-xs text-gray-400">
      Choose recipients and press Send in WhatsApp. To message one driver, use Prepare job message in their shift card below.
      The dashboard cannot preselect recipients or detect which chats you sent to.
    </p>
    <details className="mt-2 rounded border border-gray-700 bg-gray-900/70 p-2 text-xs">
      <summary className="cursor-pointer font-medium text-sky-200">Preview WhatsApp message</summary>
      <div data-testid="independent-whatsapp-message-preview" className="mt-2 whitespace-pre-wrap break-words rounded bg-emerald-950/60 p-3 text-gray-100">{buildIndependentWhatsAppText(job)}</div>
    </details>
    <p className="mt-2 text-xs text-gray-400">
      Drivers reply ACK privately to dispatch; WhatsApp replies are not automatically tracked in WellBuilt.
      After sending to one driver, mark it sent on their shift card. WellBuilt cannot verify delivery from this link.
    </p>
  </section>;
}
