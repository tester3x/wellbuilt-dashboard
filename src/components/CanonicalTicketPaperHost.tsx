'use client';

import { useEffect, useState } from 'react';
import { CanonicalPaperViewer } from './CanonicalPaperViewer';
import {
  isDocumentUnavailable,
  staffGetTicketPaper,
  type CanonicalPaperView,
  type PaperLookup,
} from '@/lib/canonicalPaper';

interface Props {
  lookup: PaperLookup | null;
  onClose?: () => void;
  embedded?: boolean;
}

/**
 * Loads stored canonical HTML through the governed callable.
 * Missing paper → Document unavailable. Never rebuilds from ticket/invoice fields.
 */
export function CanonicalTicketPaperHost({ lookup, onClose, embedded }: Props) {
  const [view, setView] = useState<CanonicalPaperView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!lookup) {
      setUnavailable(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    setUnavailable(false);
    setView(null);
    staffGetTicketPaper(lookup)
      .then((data) => {
        if (cancelled) return;
        setView(data);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setUnavailable(true);
        setLoading(false);
        if (!isDocumentUnavailable(err)) {
          console.error('[canonical-paper] resolve failed', err);
        }
      });
    return () => { cancelled = true; };
  }, [lookup && 'ticketDocId' in lookup ? lookup.ticketDocId : '', lookup && 'invoiceDocId' in lookup ? lookup.invoiceDocId : '']);

  if (loading) {
    return <div className="bg-[#FAFAF8] rounded-lg p-8 text-center text-gray-500">Loading...</div>;
  }
  if (unavailable || !view) {
    return (
      <div className="bg-[#FAFAF8] rounded-lg p-8 text-center text-gray-700">
        <p className="font-semibold">Document unavailable</p>
        {onClose && !embedded ? (
          <button type="button" onClick={onClose} className="mt-4 text-sm text-gray-500">Back</button>
        ) : null}
      </div>
    );
  }
  return (
    <CanonicalPaperViewer
      html={view.html}
      contentHash={view.contentHash}
      displayNumber={view.displayNumber}
      onClose={onClose}
      embedded={embedded}
    />
  );
}
