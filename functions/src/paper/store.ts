import { hashExactBytes } from './hash';
import type {
  InvoiceSourceRecord,
  PaperArtifactRecord,
  PaperInvoiceIndexRecord,
  PaperRevisionRecord,
  PaperSourceEventRecord,
  TicketSourceRecord,
} from './types';

export interface PaperIdentity {
  driverId: string;
  legalName?: string;
  displayName?: string;
}

export type ReserveResult =
  | { action: 'idempotent'; event: PaperSourceEventRecord; artifact: PaperArtifactRecord }
  | { action: 'reserved'; event: PaperSourceEventRecord; artifact: PaperArtifactRecord };

export interface PaperStore {
  getTicket(ticketDocId: string): Promise<TicketSourceRecord | null>;
  getInvoice(invoiceDocId: string): Promise<InvoiceSourceRecord | null>;
  getCompanyTimeZone(companyId: string): Promise<string>;
  getIdentityByDriverId(driverId: string): Promise<PaperIdentity | null>;
  readLiveAsset(uri: string): Promise<Buffer | null>;

  getArtifact(artifactId: string): Promise<PaperArtifactRecord | null>;
  getRevision(artifactId: string, revisionId: string): Promise<PaperRevisionRecord | null>;
  getInvoiceIndex(invoiceDocId: string): Promise<PaperInvoiceIndexRecord | null>;
  getSourceEvent(sourceEventId: string): Promise<PaperSourceEventRecord | null>;
  readHtmlBytes(path: string): Promise<Buffer | null>;

  reserveSourceEvent(input: {
    sourceEventId: string;
    artifactSeed: Omit<PaperArtifactRecord, 'currentRevisionId' | 'nextRevisionSeq' | 'updatedAtMs'> & {
      currentRevisionId?: string;
      nextRevisionSeq?: number;
      updatedAtMs?: number;
    };
  }): Promise<ReserveResult>;
  createHtmlBytes(path: string, bytes: Buffer): Promise<void>;
  createAssetBytes(path: string, bytes: Buffer): Promise<void>;
  finalizeRevision(input: {
    sourceEventId: string;
    revision: PaperRevisionRecord;
    invoiceIndex: PaperInvoiceIndexRecord | null;
    nowMs: number;
  }): Promise<{ action: 'created' | 'idempotent'; artifact: PaperArtifactRecord; revision: PaperRevisionRecord }>;
}

function cloneBuf(bytes: Buffer): Buffer {
  return Buffer.from(bytes);
}

export class MemoryPaperStore implements PaperStore {
  tickets = new Map<string, TicketSourceRecord>();
  invoices = new Map<string, InvoiceSourceRecord>();
  artifacts = new Map<string, PaperArtifactRecord>();
  revisions = new Map<string, PaperRevisionRecord>();
  html = new Map<string, Buffer>();
  assets = new Map<string, Buffer>();
  identities = new Map<string, PaperIdentity>();
  invoiceIndex = new Map<string, PaperInvoiceIndexRecord>();
  sourceEvents = new Map<string, PaperSourceEventRecord>();
  liveAssets = new Map<string, Buffer>();
  companyTimezones = new Map<string, string>();
  failAt: 'html' | 'revision' | 'finalize' | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  private runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async getTicket(id: string) {
    return this.tickets.get(id) || null;
  }
  async getInvoice(id: string) {
    return this.invoices.get(id) || null;
  }
  async getCompanyTimeZone(companyId: string) {
    return this.companyTimezones.get(companyId) || 'America/Chicago';
  }
  async getIdentityByDriverId(driverId: string) {
    return this.identities.get(driverId) || null;
  }
  async readLiveAsset(uri: string) {
    const buf = this.liveAssets.get(uri);
    return buf ? cloneBuf(buf) : null;
  }
  async getArtifact(id: string) {
    const art = this.artifacts.get(id);
    return art ? { ...art } : null;
  }
  async getRevision(artifactId: string, revisionId: string) {
    const rev = this.revisions.get(`${artifactId}/${revisionId}`);
    return rev ? { ...rev, projection: rev.projection } : null;
  }
  async getInvoiceIndex(invoiceDocId: string) {
    const idx = this.invoiceIndex.get(invoiceDocId);
    return idx ? { ...idx } : null;
  }
  async getSourceEvent(sourceEventId: string) {
    const ev = this.sourceEvents.get(sourceEventId);
    return ev ? { ...ev } : null;
  }
  async readHtmlBytes(path: string) {
    const buf = this.html.get(path);
    return buf ? cloneBuf(buf) : null;
  }

  async reserveSourceEvent(input: Parameters<PaperStore['reserveSourceEvent']>[0]): Promise<ReserveResult> {
    return this.runExclusive(() => {
      const existing = this.sourceEvents.get(input.sourceEventId);
      const artifactId = input.artifactSeed.artifactId;
      if (existing) {
        const artifact = this.artifacts.get(existing.artifactId);
        if (!artifact) throw new Error('event_artifact_missing');
        return { action: existing.status === 'complete' ? 'idempotent' : 'reserved', event: { ...existing }, artifact: { ...artifact } } as ReserveResult;
      }
      const current = this.artifacts.get(artifactId);
      const nextSeq = (current?.nextRevisionSeq || 0) + 1;
      const revisionId = `r${nextSeq}`;
      const artifact: PaperArtifactRecord = {
        ...input.artifactSeed,
        currentRevisionId: current?.currentRevisionId || '',
        nextRevisionSeq: nextSeq,
        createdAtMs: current?.createdAtMs || input.artifactSeed.createdAtMs,
        updatedAtMs: current?.updatedAtMs || input.artifactSeed.createdAtMs,
        invoiceDocId: current?.invoiceDocId || input.artifactSeed.invoiceDocId,
        ownerDriverId: current?.ownerDriverId || input.artifactSeed.ownerDriverId,
        paperTimeZone: current?.paperTimeZone || input.artifactSeed.paperTimeZone,
      };
      this.artifacts.set(artifactId, artifact);
      const event: PaperSourceEventRecord = {
        sourceEventId: input.sourceEventId,
        artifactId,
        revisionId,
        status: 'reserved',
      };
      this.sourceEvents.set(input.sourceEventId, event);
      return { action: 'reserved', event, artifact: { ...artifact } };
    });
  }

  async createHtmlBytes(path: string, bytes: Buffer) {
    if (this.failAt === 'html') throw new Error('storage_html_failed');
    const existing = this.html.get(path);
    if (existing) {
      if (hashExactBytes(existing) === hashExactBytes(bytes)) return;
      throw new Error('immutable_overwrite');
    }
    this.html.set(path, cloneBuf(bytes));
  }

  async createAssetBytes(path: string, bytes: Buffer) {
    const existing = this.assets.get(path);
    if (existing) {
      if (hashExactBytes(existing) === hashExactBytes(bytes)) return;
      throw new Error('immutable_overwrite');
    }
    this.assets.set(path, cloneBuf(bytes));
  }

  async finalizeRevision(input: Parameters<PaperStore['finalizeRevision']>[0]) {
    return this.runExclusive(() => {
      if (this.failAt === 'finalize' || this.failAt === 'revision') throw new Error('revision_write_failed');
      const event = this.sourceEvents.get(input.sourceEventId);
      if (!event) throw new Error('event_not_reserved');
      const artifact = this.artifacts.get(event.artifactId);
      if (!artifact) throw new Error('event_artifact_missing');
      if (event.status === 'complete') {
        const revision = this.revisions.get(`${event.artifactId}/${event.revisionId}`);
        if (!revision) throw new Error('complete_revision_missing');
        return { action: 'idempotent' as const, artifact: { ...artifact }, revision };
      }
      const key = `${input.revision.artifactId}/${input.revision.revisionId}`;
      if (this.revisions.has(key)) throw new Error('immutable_overwrite');
      this.revisions.set(key, input.revision);
      event.status = 'complete';
      artifact.currentRevisionId = input.revision.revisionId;
      artifact.updatedAtMs = input.nowMs;
      if (input.invoiceIndex) {
        const existingIdx = this.invoiceIndex.get(input.invoiceIndex.invoiceDocId);
        if (existingIdx && existingIdx.artifactId !== input.invoiceIndex.artifactId) {
          throw new Error('ambiguous_invoice_index');
        }
        if (!existingIdx) this.invoiceIndex.set(input.invoiceIndex.invoiceDocId, { ...input.invoiceIndex });
      }
      return { action: 'created' as const, artifact: { ...artifact }, revision: input.revision };
    });
  }
}
