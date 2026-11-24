'use client';

import { useState } from 'react';
import type { IndependentJob } from '@/lib/independentDispatchJobs';
import { buildIndependentWhatsAppText, independentWhatsAppGroupShareUrl } from '@/lib/independentWhatsAppDispatch';
import type { IndependentRouteGuide } from '@/lib/independentRouteGuides';

export function IndependentWhatsAppLinks({ job, guides = [] }: { job: IndependentJob; guides?: IndependentRouteGuide[] }) {
  const [copyStatus, setCopyStatus] = useState('');
  if (!['assigned', 'in_progress'].includes(job.status) || !(job.drivers?.length || job.externalDriverId || job.wbDriverId)) return null;

  return <section className="mt-3 rounded border border-sky-900/70 bg-sky-950/20 px-3 py-2 text-sm">
    <p className="font-medium text-sky-200">WhatsApp dispatch handoff</p>
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <a href={independentWhatsAppGroupShareUrl(job, guides)}
        data-testid="independent-whatsapp-share"
        className="rounded border border-sky-700 px-3 py-1.5 text-sky-200 hover:bg-sky-900/50">
        Share job to crew on WhatsApp
      </a>
      <button type="button" className="rounded border border-amber-700 px-3 py-1.5 text-amber-100 hover:bg-amber-900/40"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(buildIndependentWhatsAppText(job, undefined, Date.now(), guides, true));
            setCopyStatus('Copied. Paste into the crew chat and send; urgent alert symbols are preserved.');
          } catch { setCopyStatus('Copy failed. Open the preview and copy the message manually.'); }
        }}>Copy full message (emoji safe)</button>
    </div>
    {copyStatus && <p role="status" className="mt-2 text-xs text-amber-200">{copyStatus}</p>}
    <p className="mt-2 text-xs text-gray-400">
      Share opens WhatsApp in this browser tab; use Back to return to WellBuilt. Choose recipients in WhatsApp.
      Multiple recipients may send from the chooser; one recipient may open a draft that still needs Send.
      To message one driver, use Prepare job message in their shift card below; it also opens in this tab.
      WhatsApp's share page may replace emoji. Copy the full message, then paste into WhatsApp, when the alert symbols matter.
    </p>
    <details className="mt-2 rounded border border-gray-700 bg-gray-900/70 p-2 text-xs">
      <summary className="cursor-pointer font-medium text-sky-200">Preview WhatsApp message</summary>
      <div data-testid="independent-whatsapp-message-preview" className="mt-2 whitespace-pre-wrap break-words rounded bg-emerald-950/60 p-3 text-gray-100">{buildIndependentWhatsAppText(job, undefined, Date.now(), guides, true)}</div>
    </details>
    <p className="mt-2 text-xs text-gray-400">
      Drivers can react with a thumbs-up to acknowledge; a private ACK is the fallback. WhatsApp reactions and replies are not automatically tracked in WellBuilt.
      Mark a driver sent only after WhatsApp sends the message. WellBuilt cannot verify delivery from this link.
    </p>
  </section>;
}
