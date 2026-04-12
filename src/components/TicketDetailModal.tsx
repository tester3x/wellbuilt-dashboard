'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ticket, InvoiceDetail, TimelineEvent, fetchInvoiceForTicket, fetchSiblingTickets } from '@/lib/tickets';

interface Props {
  ticket: Ticket;
  onClose: () => void;
  onNavigateTicket?: (ticket: Ticket) => void;
}

export function TicketDetailModal({ ticket, onClose, onNavigateTicket }: Props) {
  const router = useRouter();
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [siblings, setSiblings] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchInvoiceForTicket(ticket),
      fetchSiblingTickets(ticket.invoiceNumber, ticket.id),
    ]).then(([inv, sibs]) => {
      if (cancelled) return;
      setInvoice(inv);
      setSiblings(sibs);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [ticket.id]);

  const isVoid = ticket.status === 'void';
  const isAggregate = ticket.packageId === 'aggregate';
  const timeline = invoice?.timeline || [];
  const sortedTimeline = [...timeline].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center z-50 overflow-y-auto py-8" onClick={onClose}>
      <div
        className="w-full max-w-2xl mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header bar (dark, outside the paper) */}
        <div className="flex items-center justify-between px-4 py-3 mb-0">
          <button onClick={onClose} className="text-gray-400 hover:text-white text-sm flex items-center gap-1">
            <span className="text-lg">&larr;</span>
          </button>
          <h2 className="text-white font-semibold">Invoice Detail</h2>
          <div className="w-8" />
        </div>

        {loading ? (
          <div className="bg-[#FAFAF8] rounded-lg p-8 text-center text-gray-500">Loading...</div>
        ) : (
          /* Paper card */
          <div className={`bg-[#FAFAF8] rounded-lg shadow-lg ${isVoid ? 'border-l-4 border-red-500' : 'border-l-4 border-yellow-500'}`}>
            <div className="p-6 space-y-0">

              {/* ═══ INVOICE HEADER ═══ */}
              <div className="flex items-start justify-between mb-4">
                <h3 className="text-[#111] font-black text-xl tracking-tight">INVOICE</h3>
                <span className={`px-3 py-1 rounded-full text-xs font-semibold border ${
                  isVoid
                    ? 'border-red-400 text-red-600'
                    : invoice?.status === 'paid'
                    ? 'border-green-500 text-green-700 bg-green-50'
                    : 'border-gray-400 text-gray-600'
                }`}>
                  {isVoid ? 'VOID' : (invoice?.status || 'CLOSED').toUpperCase()}
                </span>
              </div>

              <PaperRow label="Invoice #" value={ticket.invoiceNumber || '--'} mono />
              <PaperRow label="Date" value={ticket.date} />
              <PaperRow label="Type" value={ticket.type || invoice?.commodityType || '--'} />

              <Divider />

              {/* ═══ JOB DETAILS ═══ */}
              <SectionTitle>JOB DETAILS</SectionTitle>
              <PaperRow label="Operator" value={ticket.operator || invoice?.operator || '--'} />
              <PaperRow label="Well / Location" value={ticket.location || '--'} />
              <PaperRow label="Drop-off" value={ticket.hauledTo || '--'} />
              <PaperRow label="State" value={ticket.state || 'ND'} />

              <Divider />

              {/* ═══ DRIVER & VEHICLE ═══ */}
              <SectionTitle>DRIVER &amp; VEHICLE</SectionTitle>
              <PaperRow label="Driver" value={ticket.driver || '--'} />
              <PaperRow label="Truck #" value={ticket.truck || '--'} />
              <PaperRow label="Trailer #" value={ticket.trailer || '--'} />

              {/* ═══ TIME (if present) ═══ */}
              {(ticket.startTime || ticket.stopTime) && (
                <>
                  <Divider />
                  <SectionTitle>TIME</SectionTitle>
                  {ticket.startTime && <PaperRow label="Start" value={ticket.startTime} mono />}
                  {ticket.stopTime && <PaperRow label="Stop" value={ticket.stopTime} mono />}
                </>
              )}

              <Divider />

              {/* ═══ LINE ITEMS ═══ */}
              <SectionTitle>LINE ITEMS</SectionTitle>

              {/* Ticket card (bordered stub) */}
              <div className="border border-gray-300 rounded-lg overflow-hidden mb-4">
                {/* Ticket header */}
                <div className="flex items-center justify-between px-4 py-2 bg-gray-100 border-b border-gray-300">
                  <span className={`text-xs font-bold tracking-wide ${isAggregate ? 'text-amber-600' : 'text-red-500'}`}>
                    {isAggregate ? 'AGGREGATE TICKET' : 'WATER TICKET'}
                  </span>
                  <span className="text-[#111] font-mono font-semibold text-sm">#{ticket.ticketNumber}</span>
                </div>

                <div className="px-4 py-3 space-y-1">
                  {ticket.operator && <TicketRow label="Operator" value={ticket.operator} />}
                  <TicketRow label="Pickup" value={ticket.location} />
                  <TicketRow label="Drop-off" value={ticket.hauledTo} />
                  <TicketRow label="Date" value={ticket.date} />
                  {ticket.timeGauged && <TicketRow label="Time Gauged" value={ticket.timeGauged} />}
                </div>

                {/* Measurement boxes */}
                {isAggregate ? (
                  <div className="grid grid-cols-4 border-t border-gray-300">
                    <MeasureBox label="MATERIAL" value={ticket.materialType || '--'} />
                    <MeasureBox label="GROSS" value={ticket.grossWeight || '--'} />
                    <MeasureBox label="TARE" value={ticket.tareWeight || '--'} />
                    <MeasureBox label="NET / TONS" value={ticket.tons || ticket.netWeight || '--'} />
                  </div>
                ) : (
                  <div className="grid grid-cols-4 border-t border-gray-300">
                    <MeasureBox label="TYPE" value={ticket.type || 'Production Water'} />
                    <MeasureBox label="QTY (BBL)" value={ticket.qty || ticket.bbls || '--'} />
                    <MeasureBox label="TOP" value={ticket.top || '--'} />
                    <MeasureBox label="BOTTOM" value={ticket.bottom || '--'} />
                  </div>
                )}

                {/* Legal info — Pickup & Drop-off side by side */}
                {(ticket.apiNo || ticket.gpsLat || ticket.legalDesc || ticket.disposalApiNo || ticket.disposalGpsLat || ticket.hauledToLegalDesc) && (
                  <div className="px-4 py-2 border-t border-gray-200 grid grid-cols-2 gap-4">
                    {/* Pickup column */}
                    <div>
                      <p className="text-[9px] text-gray-500 font-semibold uppercase tracking-wide mb-0.5">Pickup</p>
                      {ticket.apiNo && <p className="text-[10px] text-gray-400">API# {ticket.apiNo}</p>}
                      {ticket.gpsLat && ticket.gpsLng && (
                        <p className="text-[10px] text-gray-400">GPS: {ticket.gpsLat}, {ticket.gpsLng}</p>
                      )}
                      {ticket.legalDesc && <p className="text-[10px] text-gray-400">{ticket.legalDesc}</p>}
                      {ticket.county && <p className="text-[10px] text-gray-400">{ticket.county} County</p>}
                    </div>
                    {/* Drop-off column */}
                    <div>
                      <p className="text-[9px] text-gray-500 font-semibold uppercase tracking-wide mb-0.5">Drop-off</p>
                      {ticket.disposalApiNo && <p className="text-[10px] text-gray-400">API# {ticket.disposalApiNo}</p>}
                      {ticket.disposalGpsLat && ticket.disposalGpsLng && (
                        <p className="text-[10px] text-gray-400">GPS: {ticket.disposalGpsLat}, {ticket.disposalGpsLng}</p>
                      )}
                      {ticket.hauledToLegalDesc && <p className="text-[10px] text-gray-400">{ticket.hauledToLegalDesc}</p>}
                      {ticket.hauledToCounty && <p className="text-[10px] text-gray-400">{ticket.hauledToCounty} County</p>}
                    </div>
                  </div>
                )}
              </div>

              {/* Sibling tickets */}
              {siblings.map((sib) => (
                <div key={sib.id} className="border border-gray-300 rounded-lg overflow-hidden mb-4 opacity-70 hover:opacity-100 transition-opacity cursor-pointer"
                  onClick={() => onNavigateTicket?.(sib)}>
                  <div className="flex items-center justify-between px-4 py-2 bg-gray-100 border-b border-gray-300">
                    <span className="text-xs font-bold tracking-wide text-gray-500">WATER TICKET</span>
                    <span className="text-[#111] font-mono font-semibold text-sm">#{sib.ticketNumber}</span>
                  </div>
                  <div className="px-4 py-2 flex items-center justify-between">
                    <span className="text-sm text-gray-600">{sib.location} &rarr; {sib.hauledTo}</span>
                    <span className="text-sm font-mono text-[#111]">{sib.qty} BBL</span>
                  </div>
                </div>
              ))}

              {/* ═══ JOB TIMELINE ═══ */}
              {sortedTimeline.length > 0 && (
                <>
                  <Divider />
                  <SectionTitle>JOB TIMELINE</SectionTitle>
                  <div className="space-y-3 ml-1">
                    {sortedTimeline.map((event, i) => (
                      <TimelineRow key={i} event={event} />
                    ))}
                  </div>
                </>
              )}

              {/* ═══ NOTES ═══ */}
              {(ticket.notes || invoice?.notes) && (
                <>
                  <Divider />
                  <SectionTitle>REMARKS</SectionTitle>
                  <p className="text-sm text-[#111] whitespace-pre-wrap">{ticket.notes || invoice?.notes}</p>
                </>
              )}

              {/* ═══ PHOTOS ═══ */}
              {invoice?.photos && invoice.photos.length > 0 && (
                <>
                  <Divider />
                  <SectionTitle>PHOTOS ({invoice.photos.length})</SectionTitle>
                  <div className="flex gap-2 overflow-x-auto pb-2">
                    {invoice.photos.map((photo: any, i: number) => {
                      let url = typeof photo === 'string' ? photo : photo?.uri;
                      const loc = typeof photo === 'object' ? photo?.location : '';
                      const photoType = typeof photo === 'object' ? photo?.type : '';
                      if (!url) return null;
                      // Rewrite firebasestorage.googleapis.com → storage.googleapis.com (DNS fix)
                      if (url.includes('firebasestorage.googleapis.com')) {
                        const m = url.match(/\/o\/(.+?)(\?|$)/);
                        const bucketM = url.match(/\/b\/([^/]+)\//);
                        if (m && bucketM) url = `https://storage.googleapis.com/${bucketM[1]}/${decodeURIComponent(m[1])}`;
                      }
                      return (
                        <div key={i} className="flex-shrink-0 text-center">
                          <a href={url} target="_blank" rel="noopener noreferrer">
                            <img src={url} alt={`Photo ${i + 1}`} className="w-20 h-20 object-cover rounded border border-gray-300 hover:border-yellow-500 transition-colors cursor-pointer" />
                          </a>
                          {loc && <p className="text-[9px] text-gray-400 mt-0.5 max-w-[80px] truncate">{photoType === 'pickup' ? '📍' : '📦'} {loc}</p>}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* ═══ TOTALS ═══ */}
              <div className="border-t-2 border-yellow-500 mt-6 pt-3 space-y-1">
                <TotalRow label="Total BBL" value={String(invoice?.totalBBL || ticket.qty || '--')} />
                {(invoice?.totalHours || 0) > 0 && (
                  <TotalRow label="Total Hours" value={invoice!.totalHours.toFixed(1)} />
                )}
                <TotalRow label="Tickets" value={String((siblings.length || 0) + 1)} />
              </div>

              {/* Footer */}
              <div className="text-center pt-4 pb-1">
                <span className="text-xs text-gray-400 tracking-wider">WellBuilt Tickets</span>
              </div>

              {/* Metadata footer */}
              <div className="flex items-center justify-between text-[10px] text-gray-400 pt-2 border-t border-gray-200 mt-2">
                <div className="space-x-3">
                  {ticket.submittedBy && <span>Submitted by: {ticket.submittedBy}</span>}
                  {ticket.updatedBy && <span>Edited by: {ticket.updatedBy}</span>}
                </div>
                <div className="space-x-3">
                  {ticket.createdAt && <span>{fmtDateTime(ticket.createdAt)}</span>}
                  {isVoid && ticket.voidedAt && <span className="text-red-500">Voided: {fmtDateTime(ticket.voidedAt)}</span>}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Paper UI Components ──────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="text-[#111] font-extrabold text-xs tracking-[1.5px] uppercase pt-4 pb-2">{children}</h4>;
}

function PaperRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-gray-200 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className={`text-sm text-[#111] text-right ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function TicketRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-xs text-[#111] text-right">{value}</span>
    </div>
  );
}

function MeasureBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center py-2 border-r border-gray-300 last:border-r-0">
      <div className="text-[9px] text-gray-400 uppercase tracking-wide font-medium">{label}</div>
      <div className="text-sm font-semibold text-[#111] font-mono mt-0.5">{value}</div>
    </div>
  );
}

function Divider() {
  return <div className="border-b border-gray-300 my-1" />;
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm font-semibold text-[#111]">{label}</span>
      <span className="text-sm font-semibold text-[#111] font-mono">{value}</span>
    </div>
  );
}

function TimelineRow({ event }: { event: TimelineEvent }) {
  return (
    <div className="flex items-start gap-3">
      {/* Dot */}
      <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${getEventDot(event.type)}`} />
      {/* Time */}
      <span className="text-xs font-mono text-gray-500 w-16 shrink-0">{fmtTime(event.timestamp)}</span>
      {/* Label */}
      <div>
        <span className="text-sm font-semibold text-[#111]">{getEventLabel(event)}</span>
        {event.locationName && (
          <div className="text-xs text-gray-400">{event.locationName}</div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDateTime(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '\u00A0');
  } catch {
    return iso;
  }
}

// Ping-pong aware labels (matching WB T)
let arriveCount = 0;
let departSiteCount = 0;
function getEventLabel(event: TimelineEvent): string {
  // Reset counters on depart (first event)
  if (event.type === 'depart') {
    arriveCount = 0;
    departSiteCount = 0;
    return 'Start / Departed';
  }
  if (event.type === 'arrive') {
    arriveCount++;
    return arriveCount % 2 === 1 ? 'Pickup Arrival' : 'Drop-off Arrival';
  }
  if (event.type === 'depart_site') {
    departSiteCount++;
    return departSiteCount % 2 === 1 ? 'Loaded / Departure' : 'Unloaded / Departure';
  }
  if (event.type === 'close') return 'Job Closed';
  if (event.type === 'pause') return `Paused${event.reason ? ` — ${event.reason}` : ''}`;
  if (event.type === 'resume') return 'Resumed';
  if (event.type === 'transfer') return 'Load Transferred';
  return event.type;
}

function getEventDot(type: string): string {
  switch (type) {
    case 'depart': return 'bg-gray-600';
    case 'arrive': return 'bg-gray-600';
    case 'depart_site': return 'bg-gray-600';
    case 'close': return 'bg-gray-600';
    case 'pause': return 'bg-orange-500';
    case 'resume': return 'bg-green-500';
    case 'transfer': return 'bg-purple-500';
    default: return 'bg-gray-400';
  }
}
