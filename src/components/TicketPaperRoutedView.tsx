'use client';

import { useEffect, useState } from 'react';
import type { Ticket } from '@/lib/tickets';
import {
  getTicketPaperRoute,
  type PaperLookup,
  type PaperStructuredTicket,
  type TicketPaperRoute,
} from '@/lib/canonicalPaper';
import { CanonicalTicketPaperHost } from './CanonicalTicketPaperHost';
import { TicketReviewEditor } from './TicketReviewEditor';
import { TicketReadOnlyDetail } from './TicketReadOnlyDetail';
import { TicketPolicyUnavailable, TicketRouteFailure } from './TicketPaperRouteStates';

function asTicket(record: PaperStructuredTicket | Ticket): Ticket {
  return record as Ticket;
}

export function TicketPaperRoutedView(input: {
  lookup: PaperLookup | null;
  ticket?: Ticket;
  onClose?: () => void;
  embedded?: boolean;
}) {
  const [route, setRoute] = useState<TicketPaperRoute | null>(null);
  const [preview, setPreview] = useState(false);
  const [failed, setFailed] = useState(false);
  const [structured, setStructured] = useState<PaperStructuredTicket | Ticket | null>(input.ticket || null);
  const [reviewVersion, setReviewVersion] = useState<number | null>(null);

  async function loadRoute() {
    if (!input.lookup) {
      setFailed(true);
      return;
    }
    const r = await getTicketPaperRoute(input.lookup);
    setRoute(r);
    if (r.ok) {
      if (r.structuredRecord?.id) setStructured(r.structuredRecord);
      if (typeof r.reviewVersion === 'number') setReviewVersion(r.reviewVersion);
    }
  }

  useEffect(() => {
    let cancelled = false;
    if (!input.lookup) {
      setFailed(true);
      return;
    }
    getTicketPaperRoute(input.lookup).then((r) => {
      if (cancelled) return;
      setRoute(r);
      if (r.ok) {
        if (r.structuredRecord?.id) setStructured(r.structuredRecord);
        if (typeof r.reviewVersion === 'number') setReviewVersion(r.reviewVersion);
      }
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

  const record = structured && 'id' in structured && structured.id ? structured : null;
  if ((route.mode === 'edit_form' || route.mode === 'read_only_detail') && !record) {
    return (
      <TicketRouteFailure
        message="Structured ticket record is unavailable."
        mode="structured_record_unavailable"
        onClose={input.onClose || (() => undefined)}
      />
    );
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
  if (route.mode === 'edit_form' && record) {
    return (
      <TicketReviewEditor
        ticket={asTicket(record)}
        allowedFields={route.allowedFields || []}
        canEdit={route.canEdit}
        previewAvailable={route.previewAvailable}
        reviewVersion={reviewVersion ?? route.reviewVersion}
        onPreview={() => setPreview(true)}
        onClose={input.onClose || (() => undefined)}
        onVersionConflict={loadRoute}
        onSaved={(next) => setReviewVersion(next)}
      />
    );
  }
  if (record) return <TicketReadOnlyDetail ticket={asTicket(record)} onClose={input.onClose || (() => undefined)} />;
  return (
    <TicketRouteFailure
      message="Structured ticket record is unavailable."
      mode="structured_record_unavailable"
      onClose={input.onClose || (() => undefined)}
    />
  );
}
