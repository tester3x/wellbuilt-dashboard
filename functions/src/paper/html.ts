import { escapeHtml } from './format';
import type { WaterTicketProjection } from './types';

function row(label: string, value: string): string {
  if (!value) return '';
  return `<div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`;
}

/**
 * Letter-sized canonical Water Ticket HTML.
 * Semantic contract from receiptBuilder; not 4-inch thermal geometry.
 * Deterministic: no render-time clock, no host locale, no random ids.
 */
export function buildWaterTicketHtml(p: WaterTicketProjection): string {
  const title = 'WATER TICKET';
  const ticketNo = `Ticket #${p.ticketNumber}`;

  const timelineRows = p.timeline.map((ev) => {
    const loc = ev.locationName
      ? `<div class="tl-loc">${escapeHtml(ev.locationName)}</div>`
      : '';
    return `<div class="tl-row"><span class="tl-time">${escapeHtml(ev.timeDisplay)}</span><div><div class="tl-label">${escapeHtml(ev.label)}</div>${loc}</div></div>`;
  }).join('');

  const photoCells = p.photos.map((photo, i) => {
    const cap = [photo.type, photo.location].filter(Boolean).join(' · ');
    const capHtml = cap ? `<div class="photo-cap">${escapeHtml(cap)}</div>` : '';
    return `<figure class="photo"><img src="${escapeHtml(photo.dataUri)}" alt="Photo ${i + 1}" data-paper-asset="${escapeHtml(photo.contentHash)}" />${capHtml}</figure>`;
  }).join('');

  const jsa = p.jsaContentHash
    ? `<section class="block"><h2>JSA</h2><p class="jsa">Signed JSA snapshot</p><p class="muted">paper-asset:${escapeHtml(p.jsaContentHash)}</p></section>`
    : '';

  const hoursRow = p.totalHours && p.totalHours !== '0' ? row('Total Hours', p.totalHours) : '';
  const edited = p.auditEditedBy ? ` · Edited by: ${escapeHtml(p.auditEditedBy)}` : '';
  const created = p.auditCreatedAtDisplay ? ` · ${escapeHtml(p.auditCreatedAtDisplay)}` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(title)} ${escapeHtml(ticketNo)}</title>
<style>
@page { size: letter; margin: 0.6in; }
html, body { margin: 0; padding: 0; }
body {
  font-family: Arial, Helvetica, sans-serif;
  color: #111111;
  background: #ffffff;
  width: 7.3in;
  margin: 0 auto;
  padding: 0.4in 0.35in 0.5in 0.35in;
  font-size: 12pt;
  line-height: 1.35;
}
h1 {
  font-size: 22pt;
  letter-spacing: 0.18em;
  text-align: center;
  margin: 0 0 8px 0;
  font-weight: 800;
}
.meta {
  display: flex;
  justify-content: space-between;
  border-bottom: 2px solid #111;
  padding-bottom: 8px;
  margin-bottom: 14px;
  font-weight: 700;
  font-size: 13pt;
}
.row { display: flex; justify-content: space-between; border-bottom: 1px dotted #888; padding: 5px 0; }
.label { font-weight: 700; color: #333; }
.value { text-align: right; }
h2 {
  font-size: 9pt;
  letter-spacing: 0.14em;
  margin: 16px 0 6px 0;
  text-transform: uppercase;
  border-top: 1px solid #111;
  padding-top: 8px;
}
.tl-row { display: flex; gap: 12px; margin: 6px 0; }
.tl-time { font-family: ui-monospace, Consolas, monospace; width: 5.5em; color: #444; font-size: 10pt; }
.tl-label { font-weight: 700; }
.tl-loc { font-size: 10pt; color: #555; }
.photos { display: flex; flex-wrap: wrap; gap: 8px; }
.photo { margin: 0; width: 1.6in; }
.photo img { width: 1.6in; height: 1.6in; object-fit: cover; border: 1px solid #ccc; }
.photo-cap { font-size: 8pt; color: #555; margin-top: 2px; }
.totals { border-top: 2px solid #111; margin-top: 18px; padding-top: 8px; }
.footer { margin-top: 18px; text-align: center; font-size: 9pt; color: #666; }
.audit { margin-top: 10px; font-size: 8pt; color: #666; border-top: 1px solid #ddd; padding-top: 8px; }
.muted { font-size: 9pt; color: #666; word-break: break-all; }
.jsa { font-weight: 700; }
.pagebreak { page-break-before: always; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta"><span>${escapeHtml(ticketNo)}</span><span>${escapeHtml(p.dateDisplay)}${p.acceptedTimeDisplay ? '  ' + escapeHtml(p.acceptedTimeDisplay) : ''}</span></div>
  ${row('Operator', p.operator)}
  ${row('Pickup', p.pickupLocation)}
  ${row('Drop-off', p.dropoffLocation)}
  ${row('Driver', p.driverDisplayName)}
  ${row('Truck #', p.truck)}
  ${row('Trailer #', p.trailer)}
  <h2>Measurements</h2>
  ${row('Pickup BBL', p.pickupBbls)}
  ${row('Drop-off BBL', p.dropoffBbls)}
  ${row('Top', p.tankTop)}
  ${row('Bottom', p.tankBottom)}
  ${p.timeline.length ? `<h2>Job Timeline</h2>${timelineRows}` : ''}
  ${p.photos.length ? `<h2>Photos (${p.photos.length})</h2><div class="photos">${photoCells}</div>` : ''}
  ${jsa}
  <div class="totals">
    ${row('Total BBL', p.totalBbl)}
    ${hoursRow}
    ${row('Tickets', p.ticketCount)}
  </div>
  <div class="footer">WellBuilt Tickets</div>
  <div class="audit">Submitted by: ${escapeHtml(p.auditSubmittedBy)}${edited}${created}</div>
</body>
</html>
`;
}

export function normalizePaperHtml(html: string): string {
  return html.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim() + '\n';
}

export function htmlContainsForbiddenInvoice(html: string): boolean {
  return /invoice/i.test(html);
}
