'use client';

import type { IndependentJob } from '@/lib/independentDispatchJobs';
import type { ExternalDriver } from '@/lib/externalAssignmentDelivery';
import type { IndependentDriverProfile } from '@/lib/independentDriverProfiles';
import { independentDriverContact } from '@/lib/independentDriverContact';
import { buildIndependentWhatsAppText, independentWhatsAppDriverUrl, independentWhatsAppGroupShareUrl } from '@/lib/independentWhatsAppDispatch';

export function IndependentWhatsAppLinks({ job, drivers, profiles }: { job: IndependentJob; drivers: ExternalDriver[]; profiles: IndependentDriverProfile[] }) {
  const crew = job.drivers || (job.externalDriverId
    ? [{ key: `outside:${job.externalDriverId}`, name: job.driverName || 'Assigned driver', source: 'outside' as const }]
    : job.wbDriverId ? [{ key: `wellbuilt:${job.wbDriverId}`, name: job.driverName || 'Assigned driver', source: 'wellbuilt' as const }] : []);
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
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      {crew.map(member => {
        const contact = independentDriverContact(member, profiles, drivers);
        const chatUrl = independentWhatsAppDriverUrl(job, contact.whatsappName, contact.phoneE164);
        return <div key={member.key} className="min-w-0 rounded border border-sky-900/70 bg-gray-900/60 px-2 py-1.5 text-xs">
          <p className="break-words font-medium text-white">{contact.officialName}</p>
          <p className="break-words text-gray-300">WhatsApp: {contact.whatsappName}</p>
          <p className="text-gray-300">{contact.phoneE164 || 'No phone on profile'}</p>
          {chatUrl && <a href={chatUrl} target="_blank" rel="noopener noreferrer" className="text-sky-200 underline">Open driver chat</a>}
        </div>;
      })}
    </div>
    {job.status === 'in_progress' && <p className="mt-2 text-xs text-gray-400">
      Choose the main dispatch group and up to four assigned drivers in WhatsApp (five chats per batch).
      For larger crews, share again with remaining drivers; include the main group only once.
      The dashboard cannot preselect recipients or detect which chats you sent to.
    </p>}
    <details className="mt-2 rounded border border-gray-700 bg-gray-900/70 p-2 text-xs">
      <summary className="cursor-pointer font-medium text-sky-200">Preview WhatsApp message</summary>
      <div data-testid="independent-whatsapp-message-preview" className="mt-2 whitespace-pre-wrap break-words rounded bg-emerald-950/60 p-3 text-gray-100">{buildIndependentWhatsAppText(job)}</div>
    </details>
    <p className="mt-2 text-xs text-gray-400">
      Press Send in WhatsApp. Drivers reply ACK privately to dispatch; WhatsApp replies are not automatically tracked in WellBuilt.
    </p>
  </section>;
}
