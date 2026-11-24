'use client';

import type { IndependentJob } from '@/lib/independentDispatchJobs';
import { buildIndependentWhatsAppText, independentWhatsAppGroupShareUrl } from '@/lib/independentWhatsAppDispatch';

let sharePage: Window | null = null;

function openSharePage(event: React.MouseEvent<HTMLAnchorElement>) {
  const href = event.currentTarget.href;
  if (sharePage && !sharePage.closed) {
    try {
      sharePage.location.href = href;
      sharePage.focus();
      event.preventDefault();
      return;
    } catch { sharePage = null; }
  }
  const opened = window.open(href, 'wellbuilt-independent-whatsapp');
  if (!opened) return; // Let the ordinary link work if popups are blocked.
  opened.focus();
  sharePage = opened;
  event.preventDefault();
}

export function IndependentWhatsAppLinks({ job }: { job: IndependentJob }) {
  if (!['assigned', 'in_progress'].includes(job.status) || !(job.drivers?.length || job.externalDriverId || job.wbDriverId)) return null;

  return <section className="mt-3 rounded border border-sky-900/70 bg-sky-950/20 px-3 py-2 text-sm">
    <p className="font-medium text-sky-200">WhatsApp dispatch handoff</p>
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <a href={independentWhatsAppGroupShareUrl(job)}
        target="_blank" rel="noopener noreferrer" data-testid="independent-whatsapp-share" onClick={openSharePage}
        className="rounded border border-sky-700 px-3 py-1.5 text-sky-200 hover:bg-sky-900/50">
        Share job to crew on WhatsApp
      </a>
      <button type="button" className="text-xs text-sky-200 underline" onClick={() => {
        if (sharePage && !sharePage.closed) sharePage.close();
        sharePage = null;
      }}>Close WhatsApp share page</button>
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
      Drivers can react with a thumbs-up to acknowledge; a private ACK is the fallback. WhatsApp reactions and replies are not automatically tracked in WellBuilt.
      After sending to one driver, mark it sent on their shift card. WellBuilt cannot verify delivery from this link.
    </p>
  </section>;
}
