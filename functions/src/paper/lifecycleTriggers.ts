/**
 * Authoritative paper materialization on ticket/invoice writes.
 * SOURCE ONLY / NOT DEPLOYED. Selector when approved:
 *   --only functions:onInvoicePaperLifecycle,functions:onTicketPaperLifecycle
 */
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { createFirestorePaperStore } from './firestoreStore';
import { applyInvoicePaperLifecycle, applyTicketPaperLifecycle } from './lifecycle';

function asRecord(data: unknown): Record<string, unknown> | null {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
}

export const onInvoicePaperLifecycle = onDocumentWritten(
  { document: 'invoices/{invoiceId}', retry: false },
  async (event) => {
    const store = createFirestorePaperStore();
    await applyInvoicePaperLifecycle({
      store,
      invoiceId: String(event.params.invoiceId),
      before: asRecord(event.data?.before?.data()),
      after: asRecord(event.data?.after?.data()),
      nowMs: Date.now(),
    });
  },
);

export const onTicketPaperLifecycle = onDocumentWritten(
  { document: 'tickets/{ticketId}', retry: false },
  async (event) => {
    const store = createFirestorePaperStore();
    await applyTicketPaperLifecycle({
      store,
      ticketId: String(event.params.ticketId),
      before: asRecord(event.data?.before?.data()),
      after: asRecord(event.data?.after?.data()),
      nowMs: Date.now(),
    });
  },
);
