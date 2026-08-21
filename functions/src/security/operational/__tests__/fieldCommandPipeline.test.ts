import {
  applyFieldCommandMutation,
  applyIncomingVersionState,
  publishCommittedEditMarkers,
  incrementIncomingVersionValue,
  type FieldApplyStores,
} from '../fieldCommandApply';
import {
  FIELD_COMMAND_FUNCTION_TIMEOUT_MS,
  FIELD_COMMAND_LEASE_MS,
  decideLease,
  decideAtomicMarkerWrite,
  decideMarkerWrite,
  decideReleaseLock,
  decideTargetLock,
  newAttemptToken,
  nextFenceGeneration,
  targetLockKey,
  verifyFence,
} from '../fieldCommandLease';
import {
  acquireExclusiveTargetLock,
  createSemanticFirestore,
  firestoreSetMerge,
  persistEffectPatch,
  readDoneEffects,
  releaseTargetLockIfOwner,
} from '../fieldCommandPersist';
import {
  FieldPipelineInterrupt,
  runFieldCommandPipeline,
  type FieldCrashPoint,
} from '../fieldCommandOrchestrator';
import type { SecureDriver } from '../../requireDriverAuth';

const driver: SecureDriver = {
  uid: 'driver_aaa',
  driverId: 'drv-a',
  companyId: 'liquid-gold',
  roles: ['driver'],
  displayName: 'MikeS24',
  authSource: 'claims',
};

const pull = {
  requestType: 'pull',
  packetId: '20260816_120000_WellA_pipe01',
  wellName: 'Gab 1',
  dateTimeUTC: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
  tankLevelFeet: 12,
  bblsTaken: 80,
};

function memStores(over: {
  processed?: Record<string, Record<string, unknown>>;
  invoices?: Record<string, Record<string, unknown>>;
  dispatches?: Record<string, Record<string, unknown>>;
  tickets?: Record<string, Record<string, unknown>>;
} = {}) {
  const processed = { ...(over.processed || {}) };
  const outgoing: Record<string, Record<string, unknown>> = {};
  const versions: string[] = ['0'];
  let versionState: unknown = { value: '0', acks: {} };
  const invoices = { ...(over.invoices || {}) };
  const dispatches = { ...(over.dispatches || {}) };
  const tickets = { ...(over.tickets || {}) };
  const stores: FieldApplyStores = {
    getProcessed: async (id) => processed[id] || null,
    createProcessedOnly: async (id, data) => {
      if (processed[id]) {
        const err = new Error('packet_collision') as Error & { code: string };
        err.code = 'packet_collision';
        throw err;
      }
      processed[id] = { ...data };
    },
    updateProcessed: async (id, patch) => {
      processed[id] = { ...(processed[id] || {}), ...patch };
    },
    listProcessedForWell: async (wellName, companyId) =>
      Object.entries(processed)
        .filter(([, d]) => d.wellName === wellName && d.companyId === companyId)
        .map(([id, data]) => ({ id, data })),
    replaceOutgoingForWell: async (wellName, companyId, responseId, response) => {
      for (const [k, v] of Object.entries(outgoing)) {
        if (v.wellName === wellName && v.companyId === companyId) delete outgoing[k];
      }
      outgoing[responseId] = { ...response, wellName, companyId };
    },
    incrementIncomingVersion: async () => {
      versions.push(incrementIncomingVersionValue(versions[versions.length - 1]));
    },
    incrementIncomingVersionOnce: async (scopeKey: string) => {
      const r = applyIncomingVersionState(versionState, scopeKey);
      versionState = r.next;
      versions.push(r.next.value);
    },
    setWellDown: async () => undefined,
    getWellDown: async () => false,
    getWellConfig: async () => ({ companyId: 'liquid-gold', tanks: 1, route: 'lg-north', bblPerFoot: 24 }),
    updateLinkedInvoice: async (id, patch) => {
      if (!invoices[id]) {
        throw Object.assign(new Error('linked_missing'), { code: 'linked_missing' });
      }
      invoices[id] = { ...invoices[id], ...patch };
    },
    updateLinkedDispatch: async (id, patch) => {
      if (!dispatches[id]) {
        throw Object.assign(new Error('linked_missing'), { code: 'linked_missing' });
      }
      if (dispatches[id].companyId !== patch.companyId) {
        throw Object.assign(new Error('linked_mismatch'), { code: 'linked_mismatch' });
      }
      dispatches[id] = { ...dispatches[id], ...patch };
    },
    updateLinkedTicket: async (id, patch) => {
      if (!tickets[id]) {
        throw Object.assign(new Error('linked_missing'), { code: 'linked_missing' });
      }
      tickets[id] = { ...tickets[id], ...patch };
    },
    getLinkedInvoice: async (id) => invoices[id] || null,
    getLinkedDispatch: async (id) => dispatches[id] || null,
    getLinkedTicket: async (id) => tickets[id] || null,
    patchOutgoing: async (id, patch) => {
      outgoing[id] = { ...(outgoing[id] || {}), ...patch };
    },
    getOutgoing: async (id) => outgoing[id] || null,
    transactProcessed: async (id, apply) => {
      const next = apply(processed[id] || null);
      if (next === undefined) return { committed: false, snapshot: processed[id] || null };
      processed[id] = next;
      return { committed: true, snapshot: next };
    },
    transactOutgoing: async (id, apply) => {
      const next = apply(outgoing[id] || null);
      if (next === undefined) return { committed: false, snapshot: outgoing[id] || null };
      outgoing[id] = next;
      return { committed: true, snapshot: next };
    },
  };
  return { stores, processed, outgoing, versions, invoices, dispatches, tickets };
}

describe('P0-1 Firestore nested doneEffects persist', () => {
  it('set-merge of a dotted key does NOT populate the nested map (the 16f defect)', () => {
    const doc: Record<string, unknown> = { doneEffects: {} };
    const broken = firestoreSetMerge(doc, { 'doneEffects.processed': true, lastEffect: 'processed' });
    expect(broken['doneEffects.processed']).toBe(true);
    expect(readDoneEffects(broken)).toEqual({});
  });

  it('production adapter writes a nested map that recovery can read', async () => {
    const { docs, txn } = createSemanticFirestore();
    docs['receipts/r1'] = { doneEffects: {}, status: 'leased' };
    docs['locks/l1'] = {
      attemptToken: 'tok-1',
      fenceGeneration: 1,
      leaseUntil: Date.now() + 60_000,
    };
    const { persistDoneEffectNested } = await import('../fieldCommandPersist');
    const done = await persistDoneEffectNested(
      txn,
      'receipts/r1',
      'locks/l1',
      { attemptToken: 'tok-1', fenceGeneration: 1 },
      'processed',
      Date.now(),
    );
    expect(done.processed).toBe(true);
    expect(docs['receipts/r1'].doneEffects).toEqual({ processed: true });
    expect(docs['receipts/r1']['doneEffects.processed']).toBeUndefined();
    expect(readDoneEffects(docs['receipts/r1'])).toEqual({ processed: true });
    const second = persistEffectPatch(docs['receipts/r1'].doneEffects, 'outgoing');
    expect(second.doneEffects).toEqual({ processed: true, outgoing: true });
  });

  it('lease exceeds the 30s function timeout with margin', () => {
    expect(FIELD_COMMAND_LEASE_MS).toBeGreaterThan(FIELD_COMMAND_FUNCTION_TIMEOUT_MS);
    expect(FIELD_COMMAND_LEASE_MS - FIELD_COMMAND_FUNCTION_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe('P0-2 exclusive fenced target lock', () => {
  it('uses one lock for edit and delete of the same original', () => {
    const edit = targetLockKey({ companyId: 'liquid-gold', targetPacketId: 'orig-1' });
    const del = targetLockKey({ companyId: 'liquid-gold', targetPacketId: 'orig-1' });
    const other = targetLockKey({ companyId: 'liquid-gold', targetPacketId: 'orig-2' });
    const otherCo = targetLockKey({ companyId: 'acme', targetPacketId: 'orig-1' });
    expect(edit).toBe(del);
    expect(edit).not.toBe(other);
    expect(edit).not.toBe(otherCo);
  });

  it('collides two different edits and edit-vs-delete while live', () => {
    const live = { exists: true, leaseUntil: 10_000, attemptToken: 'first' };
    expect(decideTargetLock(live, { attemptToken: 'edit-a', nowMs: 1000 })).toBe('collision');
    expect(decideTargetLock(live, { attemptToken: 'delete-b', nowMs: 1000 })).toBe('collision');
    expect(decideTargetLock(live, { attemptToken: 'first', nowMs: 1000 })).toBe('reacquire_same');
  });

  it('identical retry while first invocation is live collides', () => {
    expect(
      decideTargetLock(
        { exists: true, leaseUntil: Date.now() + 80_000, attemptToken: 'live-1' },
        { attemptToken: 'retry-2', nowMs: Date.now() + 20_000 },
      ),
    ).toBe('collision');
  });

  it('first invocation longer than 15s still owns the lock', () => {
    const acquiredAt = 1_000;
    const fifteenLater = acquiredAt + 15_000;
    const lock = {
      exists: true,
      attemptToken: 'first',
      fenceGeneration: 1,
      leaseUntil: acquiredAt + FIELD_COMMAND_LEASE_MS,
    };
    expect(verifyFence(lock, { attemptToken: 'first', fenceGeneration: 1, nowMs: fifteenLater })).toBe(true);
    expect(decideTargetLock(lock, { attemptToken: 'second', nowMs: fifteenLater })).toBe('collision');
  });

  it('lease expiry lets a new owner in; stale owner cannot effect, commit, or delete', () => {
    const expired = {
      exists: true,
      attemptToken: 'stale',
      fenceGeneration: 1,
      leaseUntil: 1000,
    };
    expect(decideTargetLock(expired, { attemptToken: 'new', nowMs: 2000 })).toBe('acquire');
    const newLock = {
      exists: true,
      attemptToken: 'new',
      fenceGeneration: nextFenceGeneration(expired),
      leaseUntil: 2000 + FIELD_COMMAND_LEASE_MS,
    };
    expect(newLock.fenceGeneration).toBe(2);
    expect(verifyFence(newLock, { attemptToken: 'stale', fenceGeneration: 1, nowMs: 3000 })).toBe(false);
    expect(verifyFence(newLock, { attemptToken: 'new', fenceGeneration: 2, nowMs: 3000 })).toBe(true);
    expect(decideReleaseLock(newLock, { attemptToken: 'stale', fenceGeneration: 1 })).toBe('refuse');
    expect(decideReleaseLock(newLock, { attemptToken: 'new', fenceGeneration: 2 })).toBe('delete');
  });

  it('two drivers targeting the same original share one lock', () => {
    const a = targetLockKey({ companyId: 'liquid-gold', targetPacketId: 'same' });
    const b = targetLockKey({ companyId: 'liquid-gold', targetPacketId: 'same' });
    expect(a).toBe(b);
    expect(
      decideTargetLock(
        { exists: true, leaseUntil: 9000, attemptToken: 'drv-a-attempt' },
        { attemptToken: 'drv-b-attempt', nowMs: 1000 },
      ),
    ).toBe('collision');
  });
});

describe('P0-1/P0-3 pipeline crash reconstruction from persisted store only', () => {
  const original = '20260816_110000_WellA_origPipe';

  async function seedEdit() {
    const mem = memStores({
      processed: {
        [original]: {
          driverId: 'drv-a',
          companyId: 'liquid-gold',
          wellName: 'Gab 1',
          requestType: 'pull',
          tankLevelFeet: 12,
          invoiceDocId: 'INV_1',
        },
      },
      invoices: { INV_1: { companyId: 'liquid-gold', lastPullPacketId: original } },
    });
    const fs = createSemanticFirestore();
    fs.docs['field_command_receipts/r1'] = {
      status: 'leased',
      doneEffects: {},
      targetPacketId: original,
    };
    return { mem, fs };
  }

  const crashPoints: FieldCrashPoint[] = [
    'after_mutation_before_effect_persist',
    'after_effect_processed',
    'after_effect_outgoing',
    'after_final_effect_before_applied',
    'after_applied_before_version',
    'after_version_before_versionIncremented',
    'after_versionIncremented_before_committed',
    'after_committed_before_markers',
    'after_committed_before_response',
  ];

  it('retries from Firestore/RTDB reconstruction at every crash boundary with exactly one result', async () => {
    for (const crashAt of crashPoints) {
      const { mem, fs } = await seedEdit();
      const inputBase = {
        type: 'edit' as const,
        packetId: `edit_${original}`,
        originalPacketId: original,
        stamped: { ...pull, tankLevelFeet: 8, bblsTaken: 40 },
        driver,
        manager: false,
        receiptKey: 'r1',
      };
      try {
        await runFieldCommandPipeline(mem.stores, fs.txn, {
          receiptPath: 'field_command_receipts/r1',
          lockPath: 'field_command_locks/l1',
        }, {
          ...inputBase,
          attemptToken: 'attempt-1',
          nowMs: 1_000,
          crashAt,
        });
        throw new Error(`expected crash at ${crashAt}`);
      } catch (e) {
        expect(e).toBeInstanceOf(FieldPipelineInterrupt);
      }

      // Reconstruct exclusively from persisted docs. Advance past lease so a
      // new invocation can fence-takeover after process death.
      const persistedDone = readDoneEffects(fs.docs['field_command_receipts/r1'] || {});
      void persistedDone;
      const retry = await runFieldCommandPipeline(mem.stores, fs.txn, {
        receiptPath: 'field_command_receipts/r1',
        lockPath: 'field_command_locks/l1',
      }, {
        ...inputBase,
        attemptToken: 'attempt-2',
        nowMs: 1_000 + FIELD_COMMAND_LEASE_MS + 1,
      });

      expect(retry.committed).toBe(true);
      expect(mem.processed[original].requestType).toBe('pull');
      expect(mem.processed[original].editCommitted).toBe(true);
      expect(mem.processed[original].editCommittedReceiptKey).toBe('r1');
      expect(Object.keys(mem.outgoing)).toHaveLength(1);
      expect(new Set(mem.versions.filter((v) => v !== '0'))).toEqual(new Set(['1']));
      expect(mem.invoices.INV_1.tankLevelFeet).toBe(8);
    }
  });

  it('never badges or confirms before committed server state', async () => {
    const { mem, fs } = await seedEdit();
    const preCommit: FieldCrashPoint[] = [
      'after_effect_processed',
      'after_effect_outgoing',
      'after_applied_before_version',
      'after_versionIncremented_before_committed',
    ];
    for (const crashAt of preCommit) {
      const seeded = await seedEdit();
      try {
        await runFieldCommandPipeline(seeded.mem.stores, seeded.fs.txn, {
          receiptPath: 'field_command_receipts/r1',
          lockPath: 'field_command_locks/l1',
        }, {
          type: 'edit',
          packetId: `edit_${original}`,
          originalPacketId: original,
          stamped: { ...pull, tankLevelFeet: 8, bblsTaken: 40 },
          driver,
          manager: false,
          receiptKey: 'r1',
          attemptToken: newAttemptToken(),
          nowMs: 1_000,
          crashAt,
        });
      } catch {
        /* expected */
      }
      const row = seeded.mem.processed[original];
      expect(row.wasEdited).toBeUndefined();
      expect(row.editedAt).toBeUndefined();
      expect(row.editedByPacketId).toBeUndefined();
      expect(row.editCommitted).toBeUndefined();
      expect(row.isEdit).toBeUndefined();
      expect(row.requestType).toBe('pull');
      const out = Object.values(seeded.mem.outgoing)[0];
      if (out) expect(out.isEdit).toBe(false);
    }
    void mem;
    void fs;
  });
});

describe('P0-4 linked-resource saga', () => {
  const original = '20260816_110000_WellA_saga';

  it('invoice deleted after preflight leaves recoverable non-committed state and no badge', async () => {
    const mem = memStores({
      processed: {
        [original]: {
          driverId: 'drv-a',
          companyId: 'liquid-gold',
          wellName: 'Gab 1',
          requestType: 'pull',
          invoiceDocId: 'INV_GONE',
          tankLevelFeet: 12,
        },
      },
      invoices: { INV_GONE: { companyId: 'liquid-gold', lastPullPacketId: original } },
    });
    const fs = createSemanticFirestore();
    fs.docs['field_command_receipts/r1'] = { status: 'leased', doneEffects: {}, targetPacketId: original };

    mem.stores.getLinkedInvoice = async (id) => {
      if ((mem.processed[original] as { tankLevelFeet?: number }).tankLevelFeet === 8) {
        return null;
      }
      return mem.invoices[id] || null;
    };

    const first = await runFieldCommandPipeline(mem.stores, fs.txn, {
      receiptPath: 'field_command_receipts/r1',
      lockPath: 'field_command_locks/l1',
    }, {
      type: 'edit',
      packetId: `edit_${original}`,
      originalPacketId: original,
      stamped: { ...pull, tankLevelFeet: 8, bblsTaken: 40 },
      driver,
      manager: false,
      receiptKey: 'r1',
      attemptToken: 'a1',
      nowMs: 1000,
    });

    expect(first.recoverable).toBe(true);
    expect(first.committed).toBe(false);
    expect(mem.processed[original].editCommitted).toBeUndefined();
    expect(mem.processed[original].wasEdited).toBeUndefined();
    expect(fs.docs['field_command_receipts/r1'].status).toBe('recoverable');
  });

  it('dispatch ownership change after preflight is recoverable', async () => {
    const mem = memStores({
      processed: {
        [original]: {
          driverId: 'drv-a',
          companyId: 'liquid-gold',
          wellName: 'Gab 1',
          requestType: 'pull',
          dispatchId: 'DSP_1',
          tankLevelFeet: 12,
        },
      },
      dispatches: { DSP_1: { companyId: 'liquid-gold', lastPullPacketId: original } },
    });
    mem.stores.getLinkedDispatch = async () => {
      if (mem.processed[original].tankLevelFeet === 8) {
        return { companyId: 'acme-other', lastPullPacketId: original };
      }
      return mem.dispatches.DSP_1;
    };
    const fs = createSemanticFirestore();
    fs.docs['field_command_receipts/r1'] = { status: 'leased', doneEffects: {}, targetPacketId: original };
    const r = await runFieldCommandPipeline(mem.stores, fs.txn, {
      receiptPath: 'field_command_receipts/r1',
      lockPath: 'field_command_locks/l1',
    }, {
      type: 'edit',
      packetId: `edit_${original}`,
      originalPacketId: original,
      stamped: { ...pull, tankLevelFeet: 8, bblsTaken: 40 },
      driver,
      manager: false,
      receiptKey: 'r1',
      attemptToken: 'a1',
      nowMs: 1000,
    });
    expect(r.recoverable).toBe(true);
    expect(r.healCode).toBe('linked_mismatch');
    expect(mem.processed[original].editCommitted).toBeUndefined();
  });

  it('ticket deleted after processed effect is recoverable and later recovers to one commit', async () => {
    const mem = memStores({
      processed: {
        [original]: {
          driverId: 'drv-a',
          companyId: 'liquid-gold',
          wellName: 'Gab 1',
          requestType: 'pull',
          ticketId: 'T_1',
          tankLevelFeet: 12,
        },
      },
      tickets: { T_1: { companyId: 'liquid-gold', lastPullPacketId: original } },
    });
    let gone = false;
    const origGet = mem.stores.getLinkedTicket!;
    mem.stores.getLinkedTicket = async (id) => {
      if (gone) return null;
      return origGet(id);
    };
    const fs = createSemanticFirestore();
    fs.docs['field_command_receipts/r1'] = { status: 'leased', doneEffects: {}, targetPacketId: original };

    gone = true;
    const blocked = await runFieldCommandPipeline(mem.stores, fs.txn, {
      receiptPath: 'field_command_receipts/r1',
      lockPath: 'field_command_locks/l1',
    }, {
      type: 'edit',
      packetId: `edit_${original}`,
      originalPacketId: original,
      stamped: { ...pull, tankLevelFeet: 8, bblsTaken: 40 },
      driver,
      manager: false,
      receiptKey: 'r1',
      attemptToken: 'a1',
      nowMs: 1000,
    });
    expect(blocked.recoverable).toBe(true);
    expect(mem.processed[original].editCommitted).toBeUndefined();

    gone = false;
    const recovered = await runFieldCommandPipeline(mem.stores, fs.txn, {
      receiptPath: 'field_command_receipts/r1',
      lockPath: 'field_command_locks/l1',
    }, {
      type: 'edit',
      packetId: `edit_${original}`,
      originalPacketId: original,
      stamped: { ...pull, tankLevelFeet: 8, bblsTaken: 40 },
      driver,
      manager: false,
      receiptKey: 'r1',
      attemptToken: 'a2',
      nowMs: 1000 + FIELD_COMMAND_LEASE_MS + 1,
    });
    expect(recovered.committed).toBe(true);
    expect(mem.processed[original].editCommitted).toBe(true);
    expect(mem.tickets.T_1.tankLevelFeet).toBe(8);
  });

  it('publishCommittedEditMarkers is the only confirmation write', async () => {
    const mem = memStores({
      processed: {
        [original]: {
          driverId: 'drv-a',
          companyId: 'liquid-gold',
          wellName: 'Gab 1',
          requestType: 'pull',
          tankLevelFeet: 12,
        },
      },
    });
    await applyFieldCommandMutation(mem.stores, {
      type: 'edit',
      packetId: `edit_${original}`,
      originalPacketId: original,
      stamped: { ...pull, tankLevelFeet: 8 },
      driver,
      manager: false,
      skipVersionIncrement: true,
    });
    expect(mem.processed[original].editCommitted).toBeUndefined();
    await publishCommittedEditMarkers(mem.stores, {
      targetId: original,
      receiptKey: 'abc123receiptkeyxxxx',
      fenceGeneration: 2,
      driverId: 'drv-a',
    });
    expect(mem.processed[original].editCommitted).toBe(true);
    expect(mem.processed[original].editCommittedReceiptKey).toBe('abc123receiptkeyxxxx');
    expect(mem.processed[original].editCommittedGeneration).toBe(2);
  });
});

describe('callable lease path (not pipeline-only)', () => {
  const original = '20260816_110000_WellA_callable';

  it('committed-without-markers resumes through decideLease then publishes markers', async () => {
    const mem = memStores({
      processed: {
        [original]: {
          driverId: 'drv-a',
          companyId: 'liquid-gold',
          wellName: 'Gab 1',
          requestType: 'pull',
          tankLevelFeet: 12,
        },
      },
    });
    const fs = createSemanticFirestore();
    const intended = {
      driverId: 'drv-a',
      companyId: 'liquid-gold',
      type: 'edit',
      targetPacketId: original,
      digest: 'd1',
      nowMs: Date.now(),
    };
    fs.docs['field_command_receipts/r1'] = {
      exists: true,
      ...intended,
      status: 'leased',
      doneEffects: {},
      markersPublished: false,
    };
    const input = {
      type: 'edit' as const,
      packetId: `edit_${original}`,
      originalPacketId: original,
      stamped: { ...pull, tankLevelFeet: 8, bblsTaken: 40 },
      driver,
      manager: false,
      receiptKey: 'r1',
    };
    try {
      await runFieldCommandPipeline(mem.stores, fs.txn, {
        receiptPath: 'field_command_receipts/r1',
        lockPath: 'field_command_locks/l1',
      }, { ...input, attemptToken: 'first', crashAt: 'after_committed_before_markers' });
    } catch {
      /* crash after commit */
    }
    const afterCrash = fs.docs['field_command_receipts/r1'];
    expect(afterCrash.status).toBe('committed');
    expect(afterCrash.markersPublished).not.toBe(true);
    expect(mem.processed[original].editCommitted).toBeUndefined();
    const lease = decideLease(
      { exists: true, ...(afterCrash as any) },
      { ...intended, nowMs: Date.now() },
    );
    expect(lease.action).toBe('resume');
    const lock = fs.docs['field_command_locks/l1'];
    if (lock) lock.leaseUntil = Date.now() - 1;
    const retry = await runFieldCommandPipeline(mem.stores, fs.txn, {
      receiptPath: 'field_command_receipts/r1',
      lockPath: 'field_command_locks/l1',
    }, { ...input, attemptToken: 'second' });
    expect(retry.committed).toBe(true);
    expect(mem.processed[original].editCommitted).toBe(true);
    expect(fs.docs['field_command_receipts/r1'].markersPublished).toBe(true);
  });

  it('transactional acquire: concurrent invocations yield exactly one owner', async () => {
    const fs = createSemanticFirestore();
    const results = await Promise.allSettled([
      acquireExclusiveTargetLock(fs.txn, 'locks/x', {
        attemptToken: 'a',
        leaseMs: 90_000,
        receiptKey: 'r-a',
        ownerDriverId: 'drv-a',
        companyId: 'liquid-gold',
        targetPacketId: 'orig',
      }),
      acquireExclusiveTargetLock(fs.txn, 'locks/x', {
        attemptToken: 'b',
        leaseMs: 90_000,
        receiptKey: 'r-b',
        ownerDriverId: 'drv-b',
        companyId: 'liquid-gold',
        targetPacketId: 'orig',
      }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((fs.docs['locks/x'].attemptToken === 'a') || (fs.docs['locks/x'].attemptToken === 'b')).toBe(true);
  });

  it('stale release cannot delete a newer fence', async () => {
    const fs = createSemanticFirestore();
    const first = await acquireExclusiveTargetLock(fs.txn, 'locks/x', {
      attemptToken: 'old',
      nowMs: 1,
      leaseMs: 10,
      receiptKey: 'r1',
      ownerDriverId: 'drv-a',
      companyId: 'liquid-gold',
      targetPacketId: 'orig',
    });
    const second = await acquireExclusiveTargetLock(fs.txn, 'locks/x', {
      attemptToken: 'new',
      nowMs: 100,
      leaseMs: 90_000,
      receiptKey: 'r2',
      ownerDriverId: 'drv-b',
      companyId: 'liquid-gold',
      targetPacketId: 'orig',
    });
    const released = await releaseTargetLockIfOwner(fs.txn, 'locks/x', first);
    expect(released).toBe('refused');
    expect(fs.docs['locks/x'].attemptToken).toBe('new');
    expect(fs.docs['locks/x'].fenceGeneration).toBe(second.fenceGeneration);
  });

  it('does not let a retry steal a live same-receipt lock', () => {
    const live = {
      exists: true,
      attemptToken: 'first',
      fenceGeneration: 1,
      receiptKey: 'r1',
      leaseUntil: Date.now() + 60_000,
    };
    expect(
      decideTargetLock(live, {
        attemptToken: 'retry',
        nowMs: Date.now(),
        receiptKey: 'r1',
        resumeSameReceipt: true,
      }),
    ).toBe('collision');
  });

  it('marker generation is monotonic; stale owner cannot overwrite', () => {
    expect(decideMarkerWrite(2, 1)).toBe('stale');
    expect(decideMarkerWrite(2, 2)).toBe('skip');
    expect(decideMarkerWrite(2, 3)).toBe('write');
  });

  it('atomic marker CAS: old read then new write then old write loses', async () => {
    const mem = memStores({
      processed: {
        pkt: {
          companyId: 'liquid-gold',
          wellName: 'Gab 1',
          packetId: 'pkt',
          dateTimeUTC: '2026-08-16T12:00:00.000Z',
          bblsTaken: 10,
          tankLevelFeet: 8,
        },
      },
    });
    mem.outgoing.out1 = {
      wellName: 'Gab 1',
      companyId: 'liquid-gold',
      currentLevel: 8,
      status: 'success',
      lastPullPacketId: 'pkt',
      lastPullDateTimeUTC: '2026-08-16T12:00:00.000Z',
      lastPullBbls: '10',
      processedBy: 'submitFieldCommand',
    };
    const old = await publishCommittedEditMarkers(mem.stores, {
      targetId: 'pkt',
      receiptKey: 'old',
      fenceGeneration: 1,
      driverId: 'drv-a',
      outgoingId: 'out1',
    });
    expect(old.complete).toBe(true);
    const newer = await publishCommittedEditMarkers(mem.stores, {
      targetId: 'pkt',
      receiptKey: 'new',
      fenceGeneration: 2,
      driverId: 'drv-a',
      outgoingId: 'out1',
    });
    expect(newer.complete).toBe(true);
    const stale = await publishCommittedEditMarkers(mem.stores, {
      targetId: 'pkt',
      receiptKey: 'old',
      fenceGeneration: 1,
      driverId: 'drv-a',
      outgoingId: 'out1',
    });
    expect(stale).toMatchObject({ complete: false, reason: 'stale' });
    expect(mem.processed.pkt.editCommittedGeneration).toBe(2);
    expect(mem.outgoing.out1.editCommittedGeneration).toBe(2);
  });

  it('equal generation heals a missing outgoing companion', async () => {
    const mem = memStores({
      processed: {
        pkt: {
          companyId: 'liquid-gold',
          wellName: 'Gab 1',
          packetId: 'pkt',
          dateTimeUTC: '2026-08-16T12:00:00.000Z',
          bblsTaken: 10,
          tankLevelFeet: 8,
          editCommitted: true,
          editCommittedGeneration: 4,
        },
      },
    });
    expect(decideAtomicMarkerWrite({
      processedGeneration: 4,
      incomingGeneration: 4,
      outgoingRequired: true,
      outgoingPresent: false,
    })).toBe('heal_outgoing');
    const healed = await publishCommittedEditMarkers(mem.stores, {
      targetId: 'pkt',
      receiptKey: 'r4',
      fenceGeneration: 4,
      driverId: 'drv-a',
      outgoingId: 'out-missing',
    });
    expect(healed.complete).toBe(true);
    expect(mem.outgoing['out-missing'].editCommittedGeneration).toBe(4);
    expect(mem.outgoing['out-missing'].wellName).toBe('Gab 1');
    expect(mem.outgoing['out-missing'].lastPullPacketId).toBe('pkt');
    expect(mem.outgoing['out-missing'].status).toBe('success');
  });

  it('does not treat a processed-only write as published', async () => {
    const mem = memStores({
      processed: { pkt: { companyId: 'liquid-gold' } },
    });
    const stores = {
      ...mem.stores,
      transactOutgoing: async () => ({ committed: false, snapshot: null }),
      patchOutgoing: async () => {
        throw new Error('outgoing_down');
      },
    };
    const r = await publishCommittedEditMarkers(stores, {
      targetId: 'pkt',
      receiptKey: 'r1',
      fenceGeneration: 3,
      driverId: 'drv-a',
      outgoingId: 'out1',
    });
    expect(r.complete).toBe(false);
  });

  it('overlapping second pipeline collides while the first still holds the lock', async () => {
    const { mem, fs } = await (async () => {
      const original = '20260816_110000_WellA_overlap';
      const mem = memStores({
        processed: {
          [original]: {
            driverId: 'drv-a',
            companyId: 'liquid-gold',
            wellName: 'Gab 1',
            requestType: 'pull',
            tankLevelFeet: 12,
          },
        },
      });
      const fs = createSemanticFirestore();
      fs.docs['field_command_receipts/r1'] = {
        status: 'applied',
        versionIncremented: false,
        doneEffects: { processed: true, outgoing: true },
        targetPacketId: original,
      };
      return { mem, fs, original };
    })();
    const input = {
      type: 'edit' as const,
      packetId: 'edit_overlap',
      originalPacketId: '20260816_110000_WellA_overlap',
      stamped: { ...pull, tankLevelFeet: 8, bblsTaken: 40 },
      driver,
      manager: false,
      receiptKey: 'r1',
    };
    const first = runFieldCommandPipeline(mem.stores, fs.txn, {
      receiptPath: 'field_command_receipts/r1',
      lockPath: 'field_command_locks/l1',
    }, { ...input, attemptToken: 'first', crashAt: 'after_applied_before_version' });
    await expect(first).rejects.toBeTruthy();
    await expect(runFieldCommandPipeline(mem.stores, fs.txn, {
      receiptPath: 'field_command_receipts/r1',
      lockPath: 'field_command_locks/l1',
    }, { ...input, attemptToken: 'second' })).rejects.toMatchObject({ code: 'target_locked' });
  });
});
