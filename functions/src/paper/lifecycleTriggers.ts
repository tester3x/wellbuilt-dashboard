/**
 * Authoritative paper materialization on ticket/invoice writes.
 * SOURCE ONLY / NOT DEPLOYED. Selector when approved:
 *   --only functions:onInvoicePaperLifecycle,functions:onTicketPaperLifecycle
 *
 * retry:true — at-least-once delivery. Source-event reservation is idempotent.
 * memory:512MiB — bounded JPEG/PNG thumbnail work.
 */
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { writeSecurityAudit } from '../security/audit';
import { createFirestorePaperStore } from './firestoreStore';
import { applyInvoicePaperLifecycle, applyTicketPaperLifecycle, settlePaperLifecycle } from './lifecycle';

function asRecord(data: unknown): Record<string, unknown> | null {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
}

const TRIGGER_OPTS = {
  retry: true,
  memory: '512MiB' as const,
  timeoutSeconds: 120,
};

export const onInvoicePaperLifecycle = onDocumentWritten(
  { document: 'invoices/{invoiceId}', ...TRIGGER_OPTS },
  async (event) => {
    const store = createFirestorePaperStore();
    const outcome = await applyInvoicePaperLifecycle({
      store,
      invoiceId: String(event.params.invoiceId),
      before: asRecord(event.data?.before?.data()),
      after: asRecord(event.data?.after?.data()),
      nowMs: Date.now(),
    });
    await settlePaperLifecycle(outcome, writeSecurityAudit);
  },
);

export const onTicketPaperLifecycle = onDocumentWritten(
  { document: 'tickets/{ticketId}', ...TRIGGER_OPTS },
  async (event) => {
    const store = createFirestorePaperStore();
    const outcome = await applyTicketPaperLifecycle({
      store,
      ticketId: String(event.params.ticketId),
      before: asRecord(event.data?.before?.data()),
      after: asRecord(event.data?.after?.data()),
      nowMs: Date.now(),
    });
    await settlePaperLifecycle(outcome, writeSecurityAudit);
  },
);
