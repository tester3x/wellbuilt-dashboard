import * as admin from 'firebase-admin';
import { eventDocId } from './persist';
import { parseGovernedStorageUri } from './storageUri';
import { eventIsNewerThanCurrent } from './eventOrder';
import { MAX_SOURCE_ASSET_BYTES } from './media';
import type { PaperStore, ReserveResult } from './store';
import type {
  InvoiceSourceRecord,
  PaperArtifactRecord,
  PaperInvoiceIndexRecord,
  PaperRevisionRecord,
  PaperSourceEventRecord,
  PaperWorkflowRecord,
  TicketSourceRecord,
} from './types';

function dataWithId<T extends { id: string }>(snap: admin.firestore.DocumentSnapshot): T | null {
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data() as object) } as T;
}

async function writeBytesCreateOnly(
  file: { save(d: Buffer | string, opts: object): Promise<unknown>; download(): Promise<Buffer[]> },
  bytes: Buffer,
  contentType: string,
): Promise<void> {
  try {
    await file.save(bytes, {
      resumable: false,
      contentType,
      precondition: { ifGenerationMatch: 0 },
    });
  } catch (err) {
    try {
      const [existing] = await file.download();
      if (Buffer.isBuffer(existing) && existing.equals(bytes)) return;
    } catch {
      /* fall through */
    }
    throw err;
  }
}

export function createFirestorePaperStore(deps?: {
  firestore?: admin.firestore.Firestore;
  bucket?: { file(path: string): { save(d: Buffer | string, opts: object): Promise<unknown>; download(): Promise<Buffer[]> } };
  rtdb?: admin.database.Database;
}): PaperStore {
  const fs = () => deps?.firestore || admin.firestore();
  const file = (path: string) => {
    if (deps?.bucket) return deps.bucket.file(path);
    return admin.storage().bucket().file(path);
  };
  const rtdb = () => deps?.rtdb || admin.database();

  return {
    async getTicket(ticketDocId) {
      return dataWithId<TicketSourceRecord>(await fs().collection('tickets').doc(ticketDocId).get());
    },
    async getInvoice(invoiceDocId) {
      return dataWithId<InvoiceSourceRecord>(await fs().collection('invoices').doc(invoiceDocId).get());
    },
    async findTicketsByInvoiceDocId(invoiceDocId) {
      const snap = await fs().collection('tickets').where('invoiceDocId', '==', invoiceDocId).limit(20).get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() } as TicketSourceRecord));
    },
    async getCompanyTimeZone(companyId) {
      const snap = await fs().collection('companies').doc(companyId).get();
      const tz = snap.exists && typeof snap.data()?.timezone === 'string' ? String(snap.data()?.timezone).trim() : '';
      return tz || 'America/Chicago';
    },
    async getIdentityByDriverId(driverId) {
      const snap = await rtdb().ref(`drivers/profiles/${driverId}`).once('value');
      if (!snap.exists()) return null;
      const row = snap.val() as { legalName?: string; displayName?: string };
      return { driverId, legalName: row.legalName, displayName: row.displayName };
    },
    async readLiveAsset(uri, opts) {
      const bucketName = (deps?.bucket as { name?: string } | undefined)?.name
        || process.env.GCLOUD_PROJECT && `${process.env.GCLOUD_PROJECT}.appspot.com`
        || 'wellbuilt-sync.appspot.com';
      const parsed = parseGovernedStorageUri(uri, {
        projectBucket: typeof bucketName === 'string' ? bucketName : 'wellbuilt-sync.appspot.com',
        companyId: opts?.companyId,
        invoiceDocId: opts?.invoiceDocId,
        ticketDocId: opts?.ticketDocId,
      });
      if (!parsed.ok) return { ok: false, reason: parsed.reason, retry: false };
      try {
        const [buf] = await file(parsed.objectPath).download();
        const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        if (bytes.length > MAX_SOURCE_ASSET_BYTES) {
          return { ok: false, reason: 'asset_too_large', retry: false };
        }
        return { ok: true, bytes };
      } catch {
        return { ok: false, reason: 'asset_unavailable', retry: true };
      }
    },
    async getArtifact(artifactId) {
      const snap = await fs().collection('paper_artifacts').doc(artifactId).get();
      return snap.exists ? (snap.data() as PaperArtifactRecord) : null;
    },
    async getRevision(artifactId, revisionId) {
      const snap = await fs().collection('paper_artifacts').doc(artifactId).collection('revisions').doc(revisionId).get();
      return snap.exists ? (snap.data() as PaperRevisionRecord) : null;
    },
    async getInvoiceIndex(invoiceDocId) {
      const snap = await fs().collection('paper_invoice_index').doc(invoiceDocId).get();
      return snap.exists ? (snap.data() as PaperInvoiceIndexRecord) : null;
    },
    async getSourceEvent(sourceEventId) {
      const snap = await fs().collection('paper_source_events').doc(eventDocId(sourceEventId)).get();
      return snap.exists ? (snap.data() as PaperSourceEventRecord) : null;
    },
    async getWorkflow(ticketDocId) {
      const snap = await fs().collection('paper_ticket_workflows').doc(ticketDocId).get();
      return snap.exists ? (snap.data() as PaperWorkflowRecord) : null;
    },
    async putWorkflow(row) {
      await fs().collection('paper_ticket_workflows').doc(row.ticketDocId).set(row);
    },
    async patchTicket(ticketDocId, patch) {
      await fs().collection('tickets').doc(ticketDocId).update(patch);
    },
    async patchInvoice(invoiceDocId, patch) {
      await fs().collection('invoices').doc(invoiceDocId).update(patch);
    },
    async readHtmlBytes(path) {
      try {
        const [buf] = await file(path).download();
        return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      } catch {
        return null;
      }
    },
    async reserveSourceEvent(input) {
      const db = fs();
      return db.runTransaction(async (tx) => {
        const eventRef = db.collection('paper_source_events').doc(eventDocId(input.sourceEventId));
        const artifactRef = db.collection('paper_artifacts').doc(input.artifactSeed.artifactId);
        const eventSnap = await tx.get(eventRef);
        const artSnap = await tx.get(artifactRef);
        if (eventSnap.exists) {
          const event = eventSnap.data() as PaperSourceEventRecord;
          const artifact = artSnap.exists
            ? artSnap.data() as PaperArtifactRecord
            : { ...input.artifactSeed, currentRevisionId: '', nextRevisionSeq: 0, updatedAtMs: input.artifactSeed.createdAtMs } as PaperArtifactRecord;
          return {
            action: event.status === 'complete' ? 'idempotent' : 'reserved',
            event,
            artifact,
          } as ReserveResult;
        }
        const current = artSnap.exists ? artSnap.data() as PaperArtifactRecord : null;
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
        const event: PaperSourceEventRecord = {
          sourceEventId: input.sourceEventId,
          artifactId: artifact.artifactId,
          revisionId,
          eventMs: input.eventMs,
          status: 'reserved',
          sourceSnapshot: input.sourceSnapshot,
        };
        tx.set(eventRef, event);
        tx.set(artifactRef, artifact);
        return { action: 'reserved', event, artifact } as ReserveResult;
      });
    },
    async createHtmlBytes(path, bytes) {
      await writeBytesCreateOnly(file(path), bytes, 'text/html; charset=utf-8');
    },
    async createAssetBytes(path, bytes) {
      await writeBytesCreateOnly(file(path), bytes, 'application/octet-stream');
    },
    async finalizeRevision(input) {
      const db = fs();
      return db.runTransaction(async (tx) => {
        const eventRef = db.collection('paper_source_events').doc(eventDocId(input.sourceEventId));
        const artifactRef = db.collection('paper_artifacts').doc(input.revision.artifactId);
        const revRef = artifactRef.collection('revisions').doc(input.revision.revisionId);
        const eventSnap = await tx.get(eventRef);
        const artSnap = await tx.get(artifactRef);
        const revSnap = await tx.get(revRef);
        const idxRef = input.invoiceIndex
          ? db.collection('paper_invoice_index').doc(input.invoiceIndex.invoiceDocId)
          : null;
        const idxSnap = idxRef ? await tx.get(idxRef) : null;
        if (!eventSnap.exists || !artSnap.exists) throw new Error('event_not_reserved');
        const event = eventSnap.data() as PaperSourceEventRecord;
        const artifact = artSnap.data() as PaperArtifactRecord;
        if (event.status === 'complete') {
          const revision = revSnap.exists ? revSnap.data() as PaperRevisionRecord : input.revision;
          return { action: 'idempotent' as const, artifact, revision };
        }
        if (revSnap.exists) throw new Error('immutable_overwrite');
        tx.create(revRef, input.revision);
        tx.update(eventRef, { status: 'complete', eventMs: input.revision.eventMs });
        const newer = eventIsNewerThanCurrent(
          { eventMs: input.revision.eventMs, sourceEventId: input.revision.sourceEventId },
          artifact.currentSourceEventId
            ? { eventMs: artifact.currentEventMs, sourceEventId: artifact.currentSourceEventId }
            : null,
        );
        const artPatch: Record<string, unknown> = { updatedAtMs: input.nowMs };
        if (newer) {
          artPatch.currentRevisionId = input.revision.revisionId;
          artPatch.currentEventMs = input.revision.eventMs;
          artPatch.currentSourceEventId = input.revision.sourceEventId;
        }
        tx.update(artifactRef, artPatch);
        if (input.invoiceIndex && idxRef) {
          if (idxSnap && idxSnap.exists) {
            const existing = idxSnap.data() as PaperInvoiceIndexRecord;
            if (existing.artifactId !== input.invoiceIndex.artifactId) {
              throw new Error('ambiguous_invoice_index');
            }
          } else {
            tx.create(idxRef, input.invoiceIndex);
          }
        }
        return {
          action: 'created' as const,
          artifact: {
            ...artifact,
            ...artPatch,
          } as PaperArtifactRecord,
          revision: input.revision,
        };
      });
    },
  };
}
