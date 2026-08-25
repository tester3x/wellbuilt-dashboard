import * as admin from 'firebase-admin';
import type { PaperStore } from './store';
import type { InvoiceSourceRecord, PaperArtifactRecord, PaperRevisionRecord, TicketSourceRecord } from './types';

function dataWithId<T extends { id: string }>(snap: admin.firestore.DocumentSnapshot): T | null {
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data() as object) } as T;
}

export function createFirestorePaperStore(deps?: {
  firestore?: admin.firestore.Firestore;
  bucket?: { file(path: string): { save(d: string, opts: object): Promise<unknown>; download(): Promise<Buffer[]> } };
}): PaperStore {
  const fs = () => deps?.firestore || admin.firestore();
  const file = (path: string) => {
    if (deps?.bucket) return deps.bucket.file(path);
    return admin.storage().bucket().file(path);
  };

  return {
    async getTicket(ticketDocId) {
      return dataWithId<TicketSourceRecord>(await fs().collection('tickets').doc(ticketDocId).get());
    },
    async getInvoice(invoiceDocId) {
      return dataWithId<InvoiceSourceRecord>(await fs().collection('invoices').doc(invoiceDocId).get());
    },
    async findTicketsForInvoice(invoice) {
      const byDoc = await fs().collection('tickets').where('invoiceDocId', '==', invoice.id).limit(10).get();
      if (!byDoc.empty) return byDoc.docs.map((d) => ({ id: d.id, ...d.data() } as TicketSourceRecord));
      const numbers = Array.isArray(invoice.tickets) ? invoice.tickets.map((n) => String(n)).slice(0, 10) : [];
      if (numbers.length === 0) return [];
      const byNum = await fs().collection('tickets').where('ticketNumber', 'in', numbers).limit(10).get();
      return byNum.docs.map((d) => ({ id: d.id, ...d.data() } as TicketSourceRecord));
    },
    async getArtifact(artifactId) {
      const snap = await fs().collection('paper_artifacts').doc(artifactId).get();
      return snap.exists ? (snap.data() as PaperArtifactRecord) : null;
    },
    async listRevisions(artifactId) {
      const snap = await fs().collection('paper_artifacts').doc(artifactId).collection('revisions').get();
      return snap.docs.map((d) => d.data() as PaperRevisionRecord);
    },
    async getRevision(artifactId, revisionId) {
      const snap = await fs().collection('paper_artifacts').doc(artifactId).collection('revisions').doc(revisionId).get();
      return snap.exists ? (snap.data() as PaperRevisionRecord) : null;
    },
    async readHtml(path) {
      try {
        const [buf] = await file(path).download();
        return buf.toString('utf8');
      } catch {
        return null;
      }
    },
    async writeHtml(path, html) {
      await file(path).save(html, { contentType: 'text/html; charset=utf-8', resumable: false });
    },
    async writeRevision(revision) {
      await fs()
        .collection('paper_artifacts')
        .doc(revision.artifactId)
        .collection('revisions')
        .doc(revision.revisionId)
        .set(revision);
    },
    async writeArtifact(artifact) {
      await fs().collection('paper_artifacts').doc(artifact.artifactId).set(artifact);
    },
    async resolveLegalName(driverField) {
      if (!driverField) return {};
      const approved = await admin.database().ref('drivers/approved').once('value');
      const rows = (approved.exists() ? approved.val() : {}) as Record<string, { legalName?: string; displayName?: string }>;
      for (const row of Object.values(rows || {})) {
        if (!row) continue;
        if (row.legalName === driverField || row.displayName === driverField) {
          return { legalName: row.legalName, displayName: row.displayName };
        }
      }
      return {};
    },
  };
}
