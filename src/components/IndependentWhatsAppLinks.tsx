'use client';

import type { IndependentJob } from '@/lib/independentDispatchJobs';
import type { ExternalDriver } from '@/lib/externalAssignmentDelivery';
import {
  independentWhatsAppDriverUrl,
  independentWhatsAppGroupShareUrl,
} from '@/lib/independentWhatsAppDispatch';

type Crew = NonNullable<IndependentJob['drivers']>[number];

export function IndependentWhatsAppLinks({
  job,
  drivers,
}: {
  job: IndependentJob;
  drivers: ExternalDriver[];
}) {
  const crew: Crew[] = job.drivers || (job.externalDriverId
    ? [{ key: `outside:${job.externalDriverId}`, name: job.driverName || 'Assigned driver', source: 'outside', assignedAt: '' }]
    : []);
  return <section className="mt-3 rounded border border-sky-900/70 bg-sky-950/20 px-3 py-2 text-sm">
    <p className="font-medium text-sky-200">WhatsApp dispatch handoff</p>
    <div className="mt-2 flex flex-wrap gap-3">
      <a href={independentWhatsAppGroupShareUrl(job)} target="_blank" rel="noopener noreferrer"
        className="rounded border border-sky-700 px-3 py-1.5 text-sky-200 hover:bg-sky-900/50">
        Share to main group
      </a>
      {crew.filter(member => member.source === 'outside').map(member => {
        const profile = drivers.find(driver => `outside:${driver.externalDriverId}` === member.key);
        const url = independentWhatsAppDriverUrl(job, member.name, profile?.phoneE164);
        return url
          ? <a key={member.key} href={url} target="_blank" rel="noopener noreferrer"
              className="rounded border border-sky-700 px-3 py-1.5 text-sky-200 hover:bg-sky-900/50">
              WhatsApp {member.name}
            </a>
          : <span key={member.key} className="text-xs text-amber-200">
              {member.name}: add a valid +country-code number in the outside-driver roster
            </span>;
      })}
    </div>
    {crew.some(member => member.source === 'wellbuilt') && <p className="mt-1 text-xs text-gray-400">
      WellBuilt-driver direct links require an approved driver phone-number source; no phone number is guessed.
    </p>}
    <p className="mt-2 text-xs text-gray-400">Opens WhatsApp with the message prepared. Select the group or confirm the driver, then press Send. No automatic sending or delivery confirmation.</p>
  </section>;
}
