/**
 * Execute the exported callables and their real persistence/authority/binding
 * adapters. Only Firebase I/O is replaced; no revision fixture or normalization
 * is inserted between the publisher's tx.create and the dispatch loader.
 */
jest.mock('firebase-admin', () => ({ firestore: jest.fn(), database: jest.fn() }));

import * as admin from 'firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { publishJobPacketRevision } from '../../jobPacketPublishCallable';
import { staffWriteDispatch } from '../../staffWriteDispatchCallable';
import { TRUSTED_STAFF_AUTHORITY_COLLECTION } from '../../trustedStaffAuthority';
import {
  INDEX_COLLECTION,
  REVISION_COLLECTION,
  revisionDocId,
  snapshotPlain,
  validateStoredRevisionForBinding,
} from '../jobPacketRevisionStore';
import { RECEIPT_COLLECTION, packageIndexDocId, publicationReceiptDocId } from '../jobPacketPublish';
import { loadVerifiedRevisionFromData, stampDispatchBinding } from '../dispatchPacketPin';

const COMPANY = 'g019-test-company';
const UID = 'g019-test-staff';
const PACKAGE = 'g019-water';
const INITIAL_TIME = '2026-01-02T03:04:05.006Z';
type Doc = Record<string, unknown>;
type Ref = { path: string; get: () => Promise<{ exists: boolean; data: () => Doc | undefined }> };
type Write = { op: 'create' | 'update'; path: string; data: Doc };

// Preserve SDK objects, including their prototypes; never JSON-normalize reads.
function copy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copy);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
}

// Model Firestore's server-timestamp transform with the real SDK Timestamp type.
// The rejected parent must therefore fail, not accidentally become plain JSON.
function commitValue(value: unknown): unknown {
  if (value instanceof FieldValue) {
    expect(value.isEqual(FieldValue.serverTimestamp())).toBe(true);
    return Timestamp.fromMillis(Date.now());
  }
  if (value === null || typeof value !== 'object' || value instanceof Timestamp) return value;
  if (Array.isArray(value)) return value.map(commitValue);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, commitValue(item)]));
}

class FirebaseIo {
  docs = new Map<string, Doc>();
  attempts: Write[][] = [];
  committed: Write[] = [];
  reads: string[] = [];
  retryNext = false;

  constructor() {
    this.docs.set(`${TRUSTED_STAFF_AUTHORITY_COLLECTION}/${UID}`, {
      schemaVersion: 1, uid: UID, companyId: COMPANY, active: true, capabilities: ['manageDrivers'],
    });
  }

  snapshot(path: string) {
    this.reads.push(path);
    const data = this.docs.get(path);
    return { exists: data !== undefined, data: () => copy(data) as Doc | undefined };
  }

  firestore = {
    collection: (name: string) => ({ doc: (id: string): Ref => {
      const path = `${name}/${id}`;
      return { path, get: async () => this.snapshot(path) };
    } }),
    runTransaction: async <T>(callback: (tx: {
      get: (ref: Ref) => Promise<ReturnType<FirebaseIo['snapshot']>>;
      create: (ref: Ref, data: Doc) => void;
      update: (ref: Ref, data: Doc) => void;
    }) => Promise<T>): Promise<T> => {
      const attempts = this.retryNext ? 2 : 1;
      this.retryNext = false;
      for (let i = 0; i < attempts; i++) {
        // Advance before even the first callback: the publication clock must
        // already have been captured outside the retryable transaction.
        jest.setSystemTime(Date.now() + 5_000);
        const writes: Write[] = [];
        const result = await callback({
          get: async (ref) => {
            if (writes.length) throw new Error('read_after_write');
            return this.snapshot(ref.path);
          },
          create: (ref, data) => { writes.push({ op: 'create', path: ref.path, data: copy(data) as Doc }); },
          update: (ref, data) => { writes.push({ op: 'update', path: ref.path, data: copy(data) as Doc }); },
        });
        this.attempts.push(writes);
        if (i + 1 < attempts) continue; // discarded transaction, no partial writes
        const next = new Map(this.docs);
        for (const write of writes) {
          if ((write.op === 'create') === next.has(write.path)) throw new Error('write_precondition');
          const data = commitValue(write.data) as Doc;
          next.set(write.path, write.op === 'update' ? { ...next.get(write.path), ...data } : data);
        }
        this.docs = next;
        this.committed.push(...writes);
        return result;
      }
      throw new Error('no_transaction_attempt');
    },
  };

  database = {
    ref: (path: string) => {
      if (path !== 'well_config') throw new Error('unexpected_rtdb_path');
      return { once: async (event: string) => {
        expect(event).toBe('value');
        return { exists: () => true, val: () => ({ testWell: { companyId: COMPANY, wellName: 'Test Well', ndicName: 'Test Well Canonical' } }) };
      } };
    },
  };

  revision(number = 1): Doc {
    const raw = this.docs.get(`${REVISION_COLLECTION}/${revisionDocId(COMPANY, PACKAGE, number)}`);
    if (!raw) throw new Error('missing_stored_revision');
    return raw;
  }
}

function draft(): Doc {
  return {
    schemaVersion: 1, packetId: PACKAGE, industryId: 'oil-gas', segmentId: 'produced-water', label: 'Test Water',
    jobTypes: [{ jobTypeId: 'pw', label: 'Production Water', capabilities: ['lifecycle', 'pickup'] }],
    capabilities: [
      { capabilityId: 'lifecycle', moduleVersion: 1, configuration: {} },
      { capabilityId: 'pickup', moduleVersion: 1, configuration: { unit: 'bbl' } },
    ],
    fields: [{ key: 'pickupLocationId', label: 'Pickup', capabilityId: 'pickup', kind: 'location', required: true }],
    commandRules: [
      { command: 'lifecycle.advance', states: ['planned', 'accepted', 'atPickup', 'loaded', 'inTransit', 'atDropoff', 'unloaded'] },
      { command: 'lifecycle.close', states: ['unloaded'] },
      { command: 'lifecycle.cancel', states: ['planned', 'accepted'] },
      { command: 'pickup.record', states: ['atPickup'] },
    ],
    workflow: [
      { from: 'planned', to: 'accepted', command: 'lifecycle.advance' },
      { from: 'accepted', to: 'atPickup', command: 'lifecycle.advance' },
      { from: 'atPickup', to: 'loaded', command: 'lifecycle.advance' },
      { from: 'loaded', to: 'inTransit', command: 'lifecycle.advance' },
      { from: 'inTransit', to: 'atDropoff', command: 'lifecycle.advance' },
      { from: 'atDropoff', to: 'unloaded', command: 'lifecycle.advance' },
      { from: 'unloaded', to: 'closed', command: 'lifecycle.close' },
      { from: 'planned', to: 'cancelled', command: 'lifecycle.cancel' },
    ],
    compatibility: { minimumContractVersion: 1, legacyAdapterId: null, migrationFrom: null },
  };
}

function publish(overrides: Doc = {}) {
  return publishJobPacketRevision.run({
    auth: { uid: UID, token: {} },
    data: { requestId: 'request-1', expectedLatestRevision: 0, packetDraft: draft(), ...overrides },
  } as never);
}

function dispatch(revision = 1, dispatchId = 'g019-test-dispatch') {
  return staffWriteDispatch.run({
    auth: { uid: UID, token: {} },
    data: { op: 'create', dispatchId, record: { wellName: 'Test Well', ndicWellName: 'Test Well Canonical', jobType: 'pw' }, packetRef: { packageId: PACKAGE, revision } },
  } as never);
}

describe('G-019 real publication persistence to dispatch binding', () => {
  let io: FirebaseIo;
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(INITIAL_TIME) });
    io = new FirebaseIo();
    (admin.firestore as unknown as jest.Mock).mockReturnValue(io.firestore);
    (admin.database as unknown as jest.Mock).mockReturnValue(io.database);
  });
  afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

  it('stores a primitive ISO string and the exact persisted document immediately validates and stamps', async () => {
    const result = await publish();
    expect(result).toMatchObject({ ok: true, result: 'created', revision: 1 });
    const stored = io.revision();
    expect(typeof stored.publishedAt).toBe('string');
    expect(stored.publishedAt).toBe(INITIAL_TIME);
    expect(snapshotPlain(stored).ok).toBe(true);
    // This is an assertion only; validators below receive the untouched stored object.
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
    const expected = { companyId: COMPANY, packageId: PACKAGE, revision: 1 };
    const bound = validateStoredRevisionForBinding(stored, expected);
    if (!bound.ok) throw new Error(`binding_rejected:${bound.reason}`);
    expect(bound.publishedAt).toBe(INITIAL_TIME);
    expect(stampDispatchBinding(bound.envelope)).toEqual({
      packageId: PACKAGE, packetRevision: 1, contentHash: result.contentHash, policyHash: result.policyHash,
    });
    const loaded = await loadVerifiedRevisionFromData(true, stored, COMPANY, { packageId: PACKAGE, revision: 1 });
    expect(loaded.ok).toBe(true);
    expect(stored.implementedEffects).toEqual([]);
  });

  it('staffWriteDispatch loads the published revision with no intermediate rewrite', async () => {
    const published = await publish();
    const stored = io.revision();
    const writeCount = io.committed.length;
    expect(await dispatch()).toMatchObject({ ok: true, result: 'created' });
    expect(io.revision()).toBe(stored);
    expect(io.committed.slice(writeCount).map((write) => write.path)).toEqual(['dispatches/g019-test-dispatch']);
    expect(io.reads).toContain(`${REVISION_COLLECTION}/${revisionDocId(COMPANY, PACKAGE, 1)}`);
    expect(io.docs.get('dispatches/g019-test-dispatch')).toMatchObject({
      companyId: COMPANY, packageId: PACKAGE, packetRevision: 1, jobType: 'pw', status: 'pending',
      contentHash: published.contentHash, policyHash: published.policyHash,
    });
    expect(await dispatch()).toMatchObject({ ok: true, result: 'already_exists' });
  });

  it('captures one timestamp outside transaction retries for revision, receipt and head', async () => {
    io.retryNext = true;
    await publish();
    expect(io.attempts).toHaveLength(2);
    for (const writes of io.attempts) {
      expect(writes.find((write) => write.path.startsWith(`${REVISION_COLLECTION}/`))?.data.publishedAt).toBe(INITIAL_TIME);
      expect(writes.find((write) => write.path.startsWith(`${RECEIPT_COLLECTION}/`))?.data.publishedAt).toBe(INITIAL_TIME);
      expect(writes.find((write) => write.path.startsWith(`${INDEX_COLLECTION}/`))?.data.updatedAt).toBe(INITIAL_TIME);
    }
    expect(io.committed).toHaveLength(4);
    expect(io.revision().publishedAt).toBe(INITIAL_TIME);
  });

  it('replays the original receipt without writes and keeps original hashes and timestamp', async () => {
    const first = await publish();
    const before = [...io.docs];
    const writes = io.committed.length;
    jest.setSystemTime(Date.now() + 60_000);
    expect(await publish()).toEqual(first);
    expect(io.committed).toHaveLength(writes);
    expect([...io.docs]).toEqual(before);
  });

  it('unchanged publication creates only its receipt and also replays without writes', async () => {
    const first = await publish();
    const original = io.revision();
    const headPath = `${INDEX_COLLECTION}/${packageIndexDocId(COMPANY, PACKAGE)}`;
    const head = io.docs.get(headPath);
    const writes = io.committed.length;
    const now = new Date(Date.now()).toISOString();
    const input = { requestId: 'unchanged-request', expectedLatestRevision: 1 };
    const unchanged = await publish(input);
    expect(unchanged).toEqual({ ...first, result: 'unchanged' });
    expect(io.revision()).toBe(original);
    expect(io.docs.get(headPath)).toBe(head);
    expect(io.committed.slice(writes)).toHaveLength(1);
    const receiptPath = `${RECEIPT_COLLECTION}/${publicationReceiptDocId(COMPANY, PACKAGE, 'unchanged-request')}`;
    expect(io.docs.get(receiptPath)?.publishedAt).toBe(now);
    expect(io.docs.get(receiptPath)?.result).toBe('unchanged');
    expect(await publish(input)).toEqual(unchanged);
    expect(io.committed).toHaveLength(writes + 1);
  });

  it('allocates revision 2 sequentially and both revisions remain consumable', async () => {
    const first = await publish();
    const original = io.revision();
    const nextDraft = draft();
    (nextDraft.fields as unknown[]).push({ key: 'loadedQuantity', label: 'Quantity', capabilityId: 'pickup', kind: 'quantity', required: true });
    const now = new Date(Date.now()).toISOString();
    const second = await publish({ requestId: 'request-2', expectedLatestRevision: 1, packetDraft: nextDraft });
    expect(second).toMatchObject({ ok: true, result: 'created', revision: 2, packetRevision: 2 });
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.policyHash).toBe(first.policyHash);
    expect(io.revision()).toBe(original);
    expect(io.revision(2).publishedAt).toBe(now);
    expect(io.revision(2).supersedes).toEqual({ packageId: PACKAGE, revision: 1, contentHash: first.contentHash });
    expect(await dispatch(1, 'dispatch-v1')).toMatchObject({ result: 'created' });
    expect(await dispatch(2, 'dispatch-v2')).toMatchObject({ result: 'created' });
  });

  it('continues rejecting SDK Timestamps and arbitrary toMillis objects without invoking them', async () => {
    await publish();
    const toMillis = jest.fn(() => Date.now());
    class TimestampLike { toMillis = toMillis; }
    for (const publishedAt of [Timestamp.fromMillis(Date.now()), new TimestampLike(), { toMillis }]) {
      const invalid = { ...io.revision(), publishedAt };
      expect(validateStoredRevisionForBinding(invalid, { companyId: COMPANY, packageId: PACKAGE, revision: 1 }).ok).toBe(false);
      expect((await loadVerifiedRevisionFromData(true, invalid, COMPANY, { packageId: PACKAGE, revision: 1 })).ok).toBe(false);
    }
    expect(toMillis).not.toHaveBeenCalled();
  });

  it('rejects caller timestamps and missing trusted authority before any persistence', async () => {
    await expect(publish({ publishedAt: INITIAL_TIME })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(io.committed).toHaveLength(0);
    io.docs.delete(`${TRUSTED_STAFF_AUTHORITY_COLLECTION}/${UID}`);
    await expect(publish()).rejects.toMatchObject({ code: 'permission-denied' });
    expect(io.committed).toHaveLength(0);
  });
});
