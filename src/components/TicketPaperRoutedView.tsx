'use client';

import { useEffect, useState } from 'react';
import type { Ticket } from '@/lib/tickets';
import { getTicketPaperRoute, type PaperLookup, type TicketPaperRoute } from '@/lib/canonicalPaper';
import { CanonicalTicketPaperHost } from './CanonicalTicketPaperHost';
import { TicketReviewEditor } from './TicketReviewEditor';
import { TicketReadOnlyDetail } from './TicketReadOnlyDetail';
import { TicketPolicyUnavailable, TicketRouteFailure } from './TicketPaperRouteStates';

export function TicketPaperRoutedView(input: {
  lookup: PaperLookup | null;
  ticket?: Ticket;
  onClose?: () => void;
  embedded?: boolean;
}) {
  const [route, setRoute] = useState<TicketPaperRoute | null>(null);
  const [preview, setPreview] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!input.lookup) {
      setFailed(true);
      return;
    }
    getTicketPaperRoute(input.lookup).then((r) => {
      if (!cancelled) setRoute(r);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => { cancelled = true; };
  }, [input.lookup && 'ticketDocId' in input.lookup ? input.lookup.ticketDocId : '', input.lookup && 'invoiceDocId' in input.lookup ? input.lookup.invoiceDocId : '']);

  if (failed) return <TicketRouteFailure message="Could not load the paper route." onClose={input.onClose || (() => undefined)} />;
  if (!route) return <div className="bg-[#FAFAF8] rounded-lg p-8 text-center text-gray-500">Loading...</div>;
  if (!route.ok) {
    if (route.reason === 'policy_undefined' || route.reason === 'workflow_unavailable') {
      return <TicketPolicyUnavailable message={route.message} gap={route.gap} onClose={input.onClose || (() => undefined)} />;
    }
    return <TicketRouteFailure message={route.message} onClose={input.onClose || (() => undefined)} />;
  }
  if (preview || route.mode === 'canonical_paper') {
    return (
      <div data-paper-mode="canonical_paper">
        {route.mode === 'edit_form' && (
          <button type="button" className="mb-3 text-sm text-yellow-400 underline" onClick={() => setPreview(false)}>
            Back to editor
          </button>
        )}
        <CanonicalTicketPaperHost lookup={input.lookup} onClose={input.onClose} embedded={input.embedded} />
      </div>
    );
  }
  if (route.mode === 'edit_form' && input.ticket) {
    return (
      <TicketReviewEditor
        ticket={input.ticket}
        allowedFields={route.allowedFields || []}
        canEdit={route.canEdit}
        previewAvailable={route.previewAvailable}
        onPreview={() => setPreview(true)}
        onClose={input.onClose || (() => undefined)}
      />
    );
  }
  if (input.ticket) return <TicketReadOnlyDetail ticket={input.ticket} onClose={input.onClose || (() => undefined)} />;
  return <TicketReadOnlyDetail ticket={{
    id: '', ticketNumber: '', date: '', company: '', companyId: '', location: '', hauledTo: '', type: '', qty: '', bbls: '',
    top: '', bottom: '', driver: '', truck: '', trailer: '', notes: '', apiNo: '', invoiceNumber: '', invoiceDocId: '',
    createdAt: null, updatedAt: null, submittedBy: '', updatedBy: '', status: '', voidedAt: null, gpsLat: '', gpsLng: '',
    legalDesc: '', county: '', fieldName: '', disposalApiNo: '', disposalGpsLat: '', disposalGpsLng: '', hauledToLegalDesc: '',
    hauledToCounty: '', hauledToOperator: '', startTime: '', stopTime: '', hours: '', timeGauged: '', packageId: '',
    materialType: '', grossWeight: '', tareWeight: '', netWeight: '', tons: '', sourceName: '', deliverySite: '', customer: '',
    splitGroupId: '', splitRole: '', state: '', operator: '',
  }} onClose={input.onClose || (() => undefined)} />;
}
