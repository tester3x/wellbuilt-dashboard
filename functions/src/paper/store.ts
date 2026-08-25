import { hashExactBytes } from './hash';
import { parseGovernedStorageUri } from './storageUri';
import type {
  InvoiceSourceRecord,
  PaperArtifactRecord,
  PaperInvoiceIndexRecord,
  PaperRevisionRecord,
  PaperSourceEventRecord,
  PaperSourceSnapshot,
  PaperReviewBatchItemSpec,
  PaperReviewBatchRecord,
  PaperWorkflowRecord,
  TicketReviewEventRecord,
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

export type LiveAssetRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: string; retry: boolean };

export interface PaperStore {
  getTicket(ticketDocId: string): Promise<TicketSourceRecord | null>;
  getInvoice(invoiceDocId: string): Promise<InvoiceSourceRecord | null>;
  findTicketsByInvoiceDocId(invoiceDocId: string): Promise<TicketSourceRecord[]>;
  getCompanyTimeZone(companyId: string): Promise<string>;
  getIdentityByDriverId(driverId: string): Promise<PaperIdentity | null>;
  readLiveAsset(uri: string, opts?: { companyId?: string; invoiceDocId?: string; ticketDocId?: string }): Promise<LiveAssetRead>;

  getArtifact(artifactId: string): Promise<PaperArtifactRecord | null>;
  getRevision(artifactId: string, revisionId: string): Promise<PaperRevisionRecord | null>;
  getInvoiceIndex(invoiceDocId: string): Promise<PaperInvoiceIndexRecord | null>;
  getSourceEvent(sourceEventId: string): Promise<PaperSourceEventRecord | null>;
  getWorkflow(ticketDocId: string): Promise<PaperWorkflowRecord | null>;
  putWorkflow(row: PaperWorkflowRecord): Promise<void>;
  patchTicket(ticketDocId: string, patch: Record<string, unknown>): Promise<void>;
  patchInvoice(invoiceDocId: string, patch: Record<string, unknown>): Promise<void>;
  putReviewEvent(event: TicketReviewEventRecord): Promise<void>;
  getReviewBatch(batchId: string): Promise<PaperReviewBatchRecord | null>;
  putReviewBatch(row: PaperReviewBatchRecord): Promise<void>;
  reserveReviewBatch(input: {
    batchId: string;
    actorUid: string;
    companyId: string;
    action: 'hand_to_payroll' | 'finalize_to_billing';
    digest: string;
    items: PaperReviewBatchItemSpec[];
    nowMs: number;
  }): Promise<
    | { ok: true; action: 'created' | 'resume' | 'idempotent'; record: PaperReviewBatchRecord }
    | { ok: false; reason: string; message: string }
  >;
  runReviewTransaction<T>(fn: (store: PaperStore) => Promise<T>): Promise<T>;
  readHtmlBytes(path: string): Promise<Buffer | null>;

  reserveSourceEvent(input: {
    sourceEventId: string;
    eventMs: number;
    artifactSeed: Omit<PaperArtifactRecord, 'currentRevisionId' | 'nextRevisionSeq' | 'updatedAtMs'> & {
      currentRevisionId?: string;
      nextRevisionSeq?: number;
      updatedAtMs?: number;
    };
    sourceSnapshot: PaperSourceSnapshot;
  }): Promise<ReserveResult>;
  createHtmlBytes(path: string, bytes: Buffer): Promise<void>;
  createAssetBytes(path: string, bytes: Buffer): Promise<void>;
  finalizeRevision(input: {
    sourceEventId: string;
    revision: PaperRevisionRecord;
    invoiceIndex: PaperInvoiceIndexRecord | null;
    nowMs: number;
    reviewSeed?: PaperWorkflowRecord | null;
  }): Promise<{ action: 'created' | 'idempotent'; artifact: PaperArtifactRecord; revision: PaperRevisionRecord }>;
}

function cloneBuf(bytes: Buffer): Buffer {
  return Buffer.from(bytes);
}

function cloneBatch(row: PaperReviewBatchRecord): PaperReviewBatchRecord {
  return {
    ...row,
    items: row.items.map((item) => ({ ...item })),
    results: row.results.map((r) => ({ ...r })),
  };
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
  workflows = new Map<string, PaperWorkflowRecord>();
  reviewEvents = new Map<string, TicketReviewEventRecord>();
  reviewBatches = new Map<string, PaperReviewBatchRecord>();
  liveAssets = new Map<string, Buffer>();
  companyTimezones = new Map<string, string>();
  fetchCount = 0;
  failAt: 'html' | 'asset' | 'revision' | 'finalize' | null = null;
  failAfterAssetWrites = 0;
  projectBucket = 'wellbuilt-sync.appspot.com';
  private assetWriteCount = 0;
  private chain: Promise<unknown> = Promise.resolve();

  private takeFail(kind: 'html' | 'asset' | 'revision' | 'finalize'): boolean {
    if (this.failAt !== kind) return false;
    if (kind === 'asset') {
      this.assetWriteCount += 1;
      if (this.assetWriteCount > this.failAfterAssetWrites) {
        this.failAt = null;
        return true;
      }
      return false;
    }
    this.failAt = null;
    return true;
  }

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
  async findTicketsByInvoiceDocId(invoiceDocId: string) {
    return [...this.tickets.values()].filter((t) => String(t.invoiceDocId || '') === invoiceDocId);
  }
  async getCompanyTimeZone(companyId: string) {
    return this.companyTimezones.get(companyId) || 'America/Chicago';
  }
  async getIdentityByDriverId(driverId: string) {
    return this.identities.get(driverId) || null;
  }
  async readLiveAsset(uri: string, opts?: { companyId?: string; invoiceDocId?: string; ticketDocId?: string }): Promise<LiveAssetRead> {
    this.fetchCount += 1;
    if (/^gs:\/\//i.test(uri) || /storage\.googleapis\.com|firebasestorage\.googleapis\.com/i.test(uri)) {
      const parsed = parseGovernedStorageUri(uri, {
        projectBucket: this.projectBucket,
        companyId: opts?.companyId,
        invoiceDocId: opts?.invoiceDocId,
        ticketDocId: opts?.ticketDocId,
      });
      if (!parsed.ok) return { ok: false, reason: parsed.reason, retry: false };
    }
    const buf = this.liveAssets.get(uri);
    if (!buf) return { ok: false, reason: 'asset_unavailable', retry: true };
    return { ok: true, bytes: cloneBuf(buf) };
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
  async getWorkflow(ticketDocId: string) {
    const row = this.workflows.get(ticketDocId);
    return row ? { ...row } : null;
  }
  async putWorkflow(row: PaperWorkflowRecord) {
    this.workflows.set(row.ticketDocId, { ...row });
  }
  async patchTicket(ticketDocId: string, patch: Record<string, unknown>) {
    const cur = this.tickets.get(ticketDocId);
    if (!cur) throw new Error('ticket_not_found');
    this.tickets.set(ticketDocId, { ...cur, ...patch });
  }
  async patchInvoice(invoiceDocId: string, patch: Record<string, unknown>) {
    const cur = this.invoices.get(invoiceDocId);
    if (!cur) throw new Error('invoice_not_found');
    this.invoices.set(invoiceDocId, { ...cur, ...patch });
  }
  async putReviewEvent(event: TicketReviewEventRecord) {
    this.reviewEvents.set(event.mutationId, { ...event });
  }
  async getReviewBatch(batchId: string) {
    const row = this.reviewBatches.get(batchId);
    return row ? cloneBatch(row) : null;
  }
  async putReviewBatch(row: PaperReviewBatchRecord) {
    this.reviewBatches.set(row.batchId, cloneBatch(row));
  }
  async reserveReviewBatch(input: Parameters<PaperStore['reserveReviewBatch']>[0]) {
    return this.runExclusive(() => {
      const existing = this.reviewBatches.get(input.batchId);
      if (existing) {
        if (
          existing.digest !== input.digest
          || existing.actorUid !== input.actorUid
          || existing.companyId !== input.companyId
          || existing.action !== input.action
        ) {
          return { ok: false as const, reason: 'batch_id_conflict', message: 'batchId is already bound to a different command.' };
        }
        const record = cloneBatch(existing);
        return { ok: true as const, action: existing.status === 'complete' ? 'idempotent' as const : 'resume' as const, record };
      }
      const record: PaperReviewBatchRecord = {
        batchId: input.batchId,
        actorUid: input.actorUid,
        companyId: input.companyId,
        action: input.action,
        digest: input.digest,
        itemCount: input.items.length,
        items: input.items.map((row) => ({ ...row })),
        results: [],
        status: 'pending',
        createdAtMs: input.nowMs,
        updatedAtMs: input.nowMs,
      };
      this.reviewBatches.set(input.batchId, cloneBatch(record));
      return { ok: true as const, action: 'created' as const, record };
    });
  }
  async runReviewTransaction<T>(fn: (store: PaperStore) => Promise<T>): Promise<T> {
    return this.runExclusive(() => fn(this));
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
        currentEventMs: current?.currentEventMs || 0,
        currentSourceEventId: current?.currentSourceEventId || '',
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
        eventMs: input.eventMs,
        status: 'reserved',
        sourceSnapshot: input.sourceSnapshot,
      };
      this.sourceEvents.set(input.sourceEventId, event);
      return { action: 'reserved', event, artifact: { ...artifact } };
    });
  }

  async createHtmlBytes(path: string, bytes: Buffer) {
    if (this.takeFail('html')) throw new Error('storage_html_failed');
    const existing = this.html.get(path);
    if (existing) {
      if (hashExactBytes(existing) === hashExactBytes(bytes)) return;
      throw new Error('immutable_overwrite');
    }
    this.html.set(path, cloneBuf(bytes));
  }

  async createAssetBytes(path: string, bytes: Buffer) {
    if (this.takeFail('asset')) throw new Error('storage_asset_failed');
    const existing = this.assets.get(path);
    if (existing) {
      if (hashExactBytes(existing) === hashExactBytes(bytes)) return;
      throw new Error('immutable_overwrite');
    }
    this.assets.set(path, cloneBuf(bytes));
  }

  async finalizeRevision(input: Parameters<PaperStore['finalizeRevision']>[0]) {
    return this.runExclusive(() => {
      if (this.takeFail('finalize') || this.takeFail('revision')) throw new Error('revision_write_failed');
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
      event.eventMs = input.revision.eventMs;
      const newer = !artifact.currentSourceEventId
        || input.revision.eventMs > artifact.currentEventMs
        || (input.revision.eventMs === artifact.currentEventMs && input.revision.sourceEventId > artifact.currentSourceEventId);
      if (newer) {
        artifact.currentRevisionId = input.revision.revisionId;
        artifact.currentEventMs = input.revision.eventMs;
        artifact.currentSourceEventId = input.revision.sourceEventId;
      }
      artifact.updatedAtMs = input.nowMs;
      if (input.invoiceIndex) {
        const existingIdx = this.invoiceIndex.get(input.invoiceIndex.invoiceDocId);
        if (existingIdx && existingIdx.artifactId !== input.invoiceIndex.artifactId) {
          throw new Error('ambiguous_invoice_index');
        }
        if (!existingIdx) this.invoiceIndex.set(input.invoiceIndex.invoiceDocId, { ...input.invoiceIndex });
      }
      if (input.reviewSeed && !this.workflows.get(input.reviewSeed.ticketDocId)) {
        this.workflows.set(input.reviewSeed.ticketDocId, { ...input.reviewSeed });
      }
      return { action: 'created' as const, artifact: { ...artifact }, revision: input.revision };
    });
  }
}
