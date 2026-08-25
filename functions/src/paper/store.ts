import type {
  InvoiceSourceRecord,
  PaperArtifactRecord,
  PaperRevisionRecord,
  TicketSourceRecord,
} from './types';

export interface PaperStore {
  getTicket(ticketDocId: string): Promise<TicketSourceRecord | null>;
  getInvoice(invoiceDocId: string): Promise<InvoiceSourceRecord | null>;
  findTicketsForInvoice(invoice: InvoiceSourceRecord): Promise<TicketSourceRecord[]>;
  getArtifact(artifactId: string): Promise<PaperArtifactRecord | null>;
  listRevisions(artifactId: string): Promise<PaperRevisionRecord[]>;
  getRevision(artifactId: string, revisionId: string): Promise<PaperRevisionRecord | null>;
  readHtml(path: string): Promise<string | null>;
  writeHtml(path: string, html: string): Promise<void>;
  writeRevision(revision: PaperRevisionRecord): Promise<void>;
  writeArtifact(artifact: PaperArtifactRecord): Promise<void>;
  resolveLegalName(driverField: string): Promise<{ legalName?: string; displayName?: string }>;
}

export class MemoryPaperStore implements PaperStore {
  tickets = new Map<string, TicketSourceRecord>();
  invoices = new Map<string, InvoiceSourceRecord>();
  artifacts = new Map<string, PaperArtifactRecord>();
  revisions = new Map<string, PaperRevisionRecord>();
  html = new Map<string, string>();
  names = new Map<string, { legalName?: string; displayName?: string }>();
  failAt: 'html' | 'revision' | 'artifact' | null = null;

  async getTicket(id: string) {
    return this.tickets.get(id) || null;
  }
  async getInvoice(id: string) {
    return this.invoices.get(id) || null;
  }
  async findTicketsForInvoice(invoice: InvoiceSourceRecord) {
    const out: TicketSourceRecord[] = [];
    for (const t of this.tickets.values()) {
      if (String(t.invoiceDocId || '') === invoice.id) out.push(t);
    }
    if (out.length) return out;
    const numbers = Array.isArray(invoice.tickets) ? invoice.tickets.map((n) => String(n)) : [];
    for (const t of this.tickets.values()) {
      if (numbers.includes(String(t.ticketNumber || '')) || numbers.includes(t.id)) out.push(t);
    }
    return out;
  }
  async getArtifact(id: string) {
    return this.artifacts.get(id) || null;
  }
  async listRevisions(artifactId: string) {
    return [...this.revisions.values()].filter((r) => r.artifactId === artifactId);
  }
  async getRevision(artifactId: string, revisionId: string) {
    return this.revisions.get(`${artifactId}/${revisionId}`) || null;
  }
  async readHtml(path: string) {
    return this.html.has(path) ? this.html.get(path)! : null;
  }
  async writeHtml(path: string, html: string) {
    if (this.failAt === 'html') throw new Error('storage_html_failed');
    this.html.set(path, html);
  }
  async writeRevision(revision: PaperRevisionRecord) {
    if (this.failAt === 'revision') throw new Error('revision_write_failed');
    this.revisions.set(`${revision.artifactId}/${revision.revisionId}`, revision);
  }
  async writeArtifact(artifact: PaperArtifactRecord) {
    if (this.failAt === 'artifact') throw new Error('artifact_write_failed');
    this.artifacts.set(artifact.artifactId, artifact);
  }
  async resolveLegalName(driverField: string) {
    return this.names.get(driverField) || {};
  }
}
