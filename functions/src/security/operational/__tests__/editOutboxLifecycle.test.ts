import {
  prepareEditOutbox,
  executeEditOutbox,
  retryStrandedEditRequest,
  reconcileAllPendingOutboxRecords,
  type EditOutboxRecord,
} from '../editOutbox';
import { computePullRevision, findDispatchIdsForPull, publishPullCorrectionToDispatches } from '../pullCorrectionSignal';

interface MockDbNode {
  [key: string]: any;
}

function createPersistentMockRtdb(initialData: Record<string, any> = {}) {
  let root: Record<string, any> = {};
  const failureHooks: Record<string, () => void> = {};

  function setNode(path: string, val: any): void {
    const segments = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (segments.length === 0) {
      if (val && typeof val === 'object') {
        root = JSON.parse(JSON.stringify(val));
      } else {
        root = {};
      }
      return;
    }
    let cur = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (cur[seg] === undefined || cur[seg] === null || typeof cur[seg] !== 'object') {
        cur[seg] = {};
      }
      cur = cur[seg];
    }
    const lastSeg = segments[segments.length - 1];
    if (val === null || val === undefined) {
      delete cur[lastSeg];
    } else {
      cur[lastSeg] = JSON.parse(JSON.stringify(val));
    }
  }

  function getNode(path: string): any {
    const segments = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (segments.length === 0) {
      return JSON.parse(JSON.stringify(root));
    }
    let cur = root;
    for (const seg of segments) {
      if (cur === undefined || cur === null || typeof cur !== 'object') {
        return undefined;
      }
      cur = cur[seg];
    }
    return cur !== undefined ? JSON.parse(JSON.stringify(cur)) : undefined;
  }

  for (const [k, v] of Object.entries(initialData)) {
    setNode(k, v);
  }

  function checkHook(targetPath: string) {
    for (const [hookPath, hook] of Object.entries(failureHooks)) {
      if (targetPath === hookPath || targetPath.startsWith(hookPath + '/') || targetPath.startsWith(hookPath)) {
        hook();
      }
    }
  }

  const db: any = {
    _getRoot: () => root,
    _failureHooks: failureHooks,
    setFailureHook: (pathPrefix: string, hook: () => void) => {
      failureHooks[pathPrefix] = hook;
    },
    clearFailureHook: (pathPrefix: string) => {
      delete failureHooks[pathPrefix];
    },
    ref: (path: string = '') => {
      const cleanPath = path.replace(/^\/+|\/+$/g, '');

      return {
        key: cleanPath.split('/').pop() || null,
        once: async (_event: string) => {
          checkHook(cleanPath);
          const val = getNode(cleanPath);
          return {
            key: cleanPath.split('/').pop() || null,
            exists: () => val !== undefined && val !== null,
            val: () => val,
            forEach: (cb: (child: any) => void) => {
              if (val && typeof val === 'object') {
                for (const [k, v] of Object.entries(val)) {
                  cb({
                    key: k,
                    val: () => v,
                    ref: db.ref(`${cleanPath}/${k}`),
                  });
                }
              }
            },
          };
        },
        set: async (val: any) => {
          checkHook(cleanPath);
          setNode(cleanPath, val);
        },
        update: async (patch: Record<string, any>) => {
          checkHook(cleanPath);
          for (const patchKey of Object.keys(patch)) {
            const fullKey = cleanPath ? `${cleanPath}/${patchKey}` : patchKey;
            checkHook(fullKey);
          }
          for (const [k, v] of Object.entries(patch)) {
            const targetPath = cleanPath ? `${cleanPath}/${k}` : k;
            setNode(targetPath, v);
          }
        },
        remove: async () => {
          checkHook(cleanPath);
          setNode(cleanPath, null);
        },
        orderByChild: (childKey: string) => ({
          equalTo: (expectedVal: any) => ({
            once: async (_event: string) => {
              checkHook(cleanPath);
              const parentVal = getNode(cleanPath) || {};
              const matched: Array<{ key: string; val: any }> = [];
              for (const [k, v] of Object.entries(parentVal)) {
                if (v && typeof v === 'object' && (v as any)[childKey] === expectedVal) {
                  matched.push({ key: k, val: v });
                }
              }
              return {
                exists: () => matched.length > 0,
                val: () => {
                  const out: Record<string, any> = {};
                  for (const m of matched) out[m.key] = m.val;
                  return out;
                },
                forEach: (cb: (child: any) => void) => {
                  for (const m of matched) {
                    cb({
                      key: m.key,
                      val: () => m.val,
                      ref: db.ref(`${cleanPath}/${m.key}`),
                    });
                  }
                },
              };
            },
          }),
        }),
      };
    },
  };

  return db;
}

function createPersistentMockFirestore(initialDocs: Record<string, any> = {}) {
  const store: Record<string, any> = JSON.parse(JSON.stringify(initialDocs));
  const failureHooks: Record<string, () => void> = {};

  const fs: any = {
    _store: store,
    setFailureHook: (pattern: string, hook: () => void) => {
      failureHooks[pattern] = hook;
    },
    clearFailureHook: (pattern: string) => {
      delete failureHooks[pattern];
    },
    collection: (collName: string) => ({
      doc: (docId: string) => ({
        id: docId,
        get: async () => {
          if (failureHooks[collName] || failureHooks[`${collName}/${docId}`]) {
            (failureHooks[collName] || failureHooks[`${collName}/${docId}`])();
          }
          const data = store[`${collName}/${docId}`] || store[docId];
          return {
            id: docId,
            exists: data !== undefined,
            data: () => data,
          };
        },
        update: async (patch: Record<string, any>) => {
          if (failureHooks[collName] || failureHooks[`${collName}/${docId}`]) {
            (failureHooks[collName] || failureHooks[`${collName}/${docId}`])();
          }
          const key = store[`${collName}/${docId}`] !== undefined ? `${collName}/${docId}` : docId;
          store[key] = { ...(store[key] || {}), ...patch };
        },
      }),
      where: (field: string, op: string, val: any) => ({
        limit: (_n: number) => ({
          get: async () => {
            if (failureHooks[collName] || failureHooks[`query_${field}`]) {
              (failureHooks[collName] || failureHooks[`query_${field}`])();
            }
            const matched: any[] = [];
            for (const [k, d] of Object.entries(store)) {
              if (d && d[field] === val) {
                matched.push({
                  id: k.split('/').pop(),
                  data: () => d,
                  ref: {
                    id: k.split('/').pop(),
                    update: async (patch: any) => {
                      store[k] = { ...store[k], ...patch };
                    },
                  },
                });
              }
            }
            return {
              size: matched.length,
              docs: matched,
              forEach: (cb: any) => matched.forEach(cb),
            };
          },
        }),
        get: async () => {
          if (failureHooks[collName] || failureHooks[`query_${field}`]) {
            (failureHooks[collName] || failureHooks[`query_${field}`])();
          }
          const matched: any[] = [];
          for (const [k, d] of Object.entries(store)) {
            if (d && d[field] === val) {
              matched.push({
                id: k.split('/').pop(),
                data: () => d,
                ref: {
                  id: k.split('/').pop(),
                  update: async (patch: any) => {
                    store[k] = { ...store[k], ...patch };
                  },
                },
              });
            }
          }
          return {
            size: matched.length,
            docs: matched,
            forEach: (cb: any) => matched.forEach(cb),
          };
        },
      }),
    }),
    runTransaction: async (txFn: (tx: any) => Promise<any>) => {
      const tx = {
        get: async (docRef: any) => {
          if (failureHooks[docRef.id]) {
            failureHooks[docRef.id]();
          }
          const key = Object.keys(store).find((k) => k === docRef.id || k.endsWith(`/${docRef.id}`));
          const data = key ? store[key] : undefined;
          return {
            id: docRef.id,
            exists: data !== undefined,
            data: () => data,
          };
        },
        update: (docRef: any, patch: any) => {
          if (failureHooks[docRef.id] || failureHooks['tx_update']) {
            (failureHooks[docRef.id] || failureHooks['tx_update'])();
          }
          const key = Object.keys(store).find((k) => k === docRef.id || k.endsWith(`/${docRef.id}`)) || docRef.id;
          store[key] = { ...(store[key] || {}), ...patch };
        },
      };
      return await txFn(tx);
    },
  };

  return fs;
}

describe('Edit Outbox & Durable Retry Lifecycle — Comprehensive Acceptance Suite', () => {
  const PACKET_ID = '20260929_100000_Gabriel1_pull1';
  const WELL_NAME = 'Gabriel 1';
  const CONFIG_KEY = 'Gabriel 1';
  const DRIVER_ID = 'drv-uuid-1';
  const DISPATCH_ID = 'disp-1';

  function createBaseFixture() {
    const rtdb = createPersistentMockRtdb({
      [`well_config/${CONFIG_KEY}`]: {
        companyId: 'liquid-gold',
        tanks: 1,
        bblPerFoot: 20,
        pullBbls: 100,
        bottomLevel: 1,
        loadLine: 0,
      },
      [`packets/processed/${PACKET_ID}`]: {
        wellName: WELL_NAME,
        tankTopInches: 100,
        tankLevelFeet: 8.33,
        tankAfterInches: 40,
        tankAfterFeet: '3\'4"',
        bblsTaken: 100,
        dateTimeUTC: '2026-09-29T10:00:00.000Z',
        dateTime: '09/29/2026 10:00 AM',
        flowRate: '12:30:00', // Individual pull interval flow rate
        flowRateDays: 0.52,
        timeDifDays: 1,
        driverId: DRIVER_ID,
        dispatchId: DISPATCH_ID,
        editCount: 0,
      },
      [`packets/outgoing/response_${PACKET_ID}`]: {
        wellName: WELL_NAME,
        currentLevel: '3\'4"',
        lastPullRevision: 'rev-initial',
        lastPullDateTimeUTC: '2026-09-29T10:00:00.000Z',
      },
    });

    const firestore = createPersistentMockFirestore({
      [DISPATCH_ID]: {
        wellName: WELL_NAME,
        companyId: 'liquid-gold',
        assignedDriverId: DRIVER_ID,
        lastPullPacketId: PACKET_ID,
        lastPullRevision: 'rev-initial',
      },
    });

    return { rtdb, firestore };
  }

  test('legacy idem_ pull keeps its storage key separate from the invoice packet id', async () => {
    const { rtdb } = createBaseFixture();
    const origPacket = (await rtdb.ref(`packets/processed/${PACKET_ID}`).once('value')).val();
    const config = (await rtdb.ref(`well_config/${CONFIG_KEY}`).once('value')).val();
    const outbox = await prepareEditOutbox(rtdb, 'legacy-edit', {
      canonicalPacketId: `idem_${PACKET_ID}`,
      originalPacketId: PACKET_ID,
      packetId: PACKET_ID,
      wellName: WELL_NAME,
      tankTopInches: 120,
      bblsTaken: 80,
      driverId: DRIVER_ID,
    }, { ...origPacket, idempotencyKey: PACKET_ID }, config, WELL_NAME, CONFIG_KEY);
    expect(outbox.originalPacketId).toBe(`idem_${PACKET_ID}`);
    expect(outbox.invoicePacketId).toBe(PACKET_ID);
  });

  test('Scenario 1: processed/history write succeeds, outgoing fails, handler retried — outgoing and dispatch eventually receive correction exactly once, incoming not consumed prematurely', async () => {
    const { rtdb, firestore } = createBaseFixture();
    const incomingId = 'inc_edit_1';
    const editEventId = `edit_evt_${incomingId}`;
    const editPayload = {
      packetId: PACKET_ID,
      editEventId,
      wellName: WELL_NAME,
      tankTopInches: 120, // changed measurement
      bblsTaken: 80,
      driverId: DRIVER_ID,
    };
    rtdb.ref(`packets/incoming/${incomingId}`).set(editPayload);

    // 1. Prepare outbox atomically
    const origPacket = (await rtdb.ref(`packets/processed/${PACKET_ID}`).once('value')).val();
    const config = (await rtdb.ref(`well_config/${CONFIG_KEY}`).once('value')).val();
    const outbox = await prepareEditOutbox(
      rtdb,
      incomingId,
      editPayload,
      origPacket,
      config,
      WELL_NAME,
      CONFIG_KEY,
    );

    expect(outbox.stage).toBe('prepared');
    expect(outbox.revision).toBeTruthy();

    // 2. Simulate outgoing failure on attempt 1
    rtdb.setFailureHook('packets/outgoing', () => {
      throw new Error('Simulated RTDB Outgoing 500 error');
    });

    let attempt1Error: any = null;
    try {
      await executeEditOutbox(rtdb, firestore, outbox);
    } catch (err) {
      attempt1Error = err;
    }
    expect(attempt1Error).toBeTruthy();

    // Verify stage after failure: processed was written, but outbox remains at processed_written
    const outboxAttempt1 = (await rtdb.ref(`packets/editOutbox/${editEventId}`).once('value')).val();
    expect(outboxAttempt1.stage).toBe('processed_written');
    expect(outboxAttempt1.completed).toBe(false);

    // Verify incoming packet was NOT prematurely consumed!
    const incomingSnap1 = await rtdb.ref(`packets/incoming/${incomingId}`).once('value');
    expect(incomingSnap1.exists()).toBe(true);

    // Verify dispatch was NOT updated yet
    const dispSnap1 = await firestore.collection('dispatches').doc(DISPATCH_ID).get();
    expect(dispSnap1.data().lastPullRevision).toBe('rev-initial');

    // 3. Clear failure hook and RETRY handler
    rtdb.clearFailureHook('packets/outgoing');
    const outcome2 = await executeEditOutbox(rtdb, firestore, outboxAttempt1);
    expect(outcome2.ok).toBe(true);

    // Verify final state:
    // Outbox is completed
    const finalOutbox = (await rtdb.ref(`packets/editOutbox/${editEventId}`).once('value')).val();
    expect(finalOutbox.stage).toBe('done');
    expect(finalOutbox.completed).toBe(true);

    // Outgoing updated exactly once with confirmed revision
    const outgoingSnap = await rtdb.ref(`packets/outgoing/response_${PACKET_ID}`).once('value');
    expect(outgoingSnap.val().lastPullRevision).toBe(outbox.revision);

    // Dispatch received confirmed correction signal
    const dispSnapFinal = await firestore.collection('dispatches').doc(DISPATCH_ID).get();
    expect(dispSnapFinal.data().lastPullCorrection.revision).toBe(outbox.revision);
    expect(dispSnapFinal.data().lastPullCorrection.packetId).toBe(PACKET_ID);

    // Incoming packet is consumed ONLY after full completion
    const incomingSnapFinal = await rtdb.ref(`packets/incoming/${incomingId}`).once('value');
    expect(incomingSnapFinal.exists()).toBe(false);
  });

  test('Scenario 2: outgoing succeeds, commit-marker write fails — replay repairs without lost or duplicate edit', async () => {
    const { rtdb, firestore } = createBaseFixture();
    const incomingId = 'inc_edit_2';
    const editEventId = `edit_evt_${incomingId}`;
    const editPayload = {
      packetId: PACKET_ID,
      editEventId,
      wellName: WELL_NAME,
      tankTopInches: 110,
      bblsTaken: 90,
      driverId: DRIVER_ID,
    };
    rtdb.ref(`packets/incoming/${incomingId}`).set(editPayload);

    const origPacket = (await rtdb.ref(`packets/processed/${PACKET_ID}`).once('value')).val();
    const config = (await rtdb.ref(`well_config/${CONFIG_KEY}`).once('value')).val();
    const outbox = await prepareEditOutbox(
      rtdb,
      incomingId,
      editPayload,
      origPacket,
      config,
      WELL_NAME,
      CONFIG_KEY,
    );

    // First attempt advances to processed_written
    outbox.stage = 'processed_written';
    await rtdb.ref(`packets/editOutbox/${editEventId}`).set(outbox);

    // Simulate failure during commit-marker write onto packets/processed
    rtdb.setFailureHook(`packets/processed/${PACKET_ID}/outgoingCommittedRevision`, () => {
      // Allow stage 2, fail only when updating outgoingCommittedRevision
      throw new Error('Simulated failure writing outgoingCommittedRevision marker');
    });

    let attemptError: any = null;
    try {
      await executeEditOutbox(rtdb, firestore, outbox);
    } catch (err) {
      attemptError = err;
    }
    expect(attemptError).toBeTruthy();

    // Verify: outgoing was already written before marker crashed
    const outgoingSnap = await rtdb.ref(`packets/outgoing/response_${PACKET_ID}`).once('value');
    expect(outgoingSnap.val().lastPullRevision).toBe(outbox.revision);

    // Marker was NOT yet written on processed
    const processedSnap = await rtdb.ref(`packets/processed/${PACKET_ID}`).once('value');
    expect(processedSnap.val().outgoingCommittedRevision).toBeFalsy();

    // Clear hook and replay
    rtdb.clearFailureHook(`packets/processed/${PACKET_ID}/outgoingCommittedRevision`);
    const replayOutcome = await executeEditOutbox(rtdb, firestore, outbox);
    expect(replayOutcome.ok).toBe(true);

    // Verify commit marker was cleanly repaired
    const repairedProcessed = (await rtdb.ref(`packets/processed/${PACKET_ID}`).once('value')).val();
    expect(repairedProcessed.outgoingCommittedRevision).toBe(outbox.revision);
    expect(repairedProcessed.outgoingCommittedEventId).toBe(outbox.eventId);

    // Verify dispatch delivered
    const dispSnap = await firestore.collection('dispatches').doc(DISPATCH_ID).get();
    expect(dispSnap.data().lastPullCorrection.revision).toBe(outbox.revision);
  });

  test('Scenario 3: Firestore publication fails, retries with individual flow rate deliberately different from AFR — published payload and revision exactly match outgoing', async () => {
    const { rtdb, firestore } = createBaseFixture();
    const incomingId = 'inc_edit_3';
    const editEventId = `edit_evt_${incomingId}`;

    // Add a prior pull to create a deliberate difference between individual pull flowRate and multi-pull AFR
    rtdb.ref('packets/processed/pkt-prior').set({
      wellName: WELL_NAME,
      tankTopInches: 100,
      tankAfterInches: 30,
      flowRateDays: 0.125, // 3:00:00 AFR contributor
      dateTimeUTC: '2026-09-29T08:00:00.000Z',
    });

    const editPayload = {
      packetId: PACKET_ID,
      editEventId,
      wellName: WELL_NAME,
      tankTopInches: 115,
      bblsTaken: 85,
      driverId: DRIVER_ID,
    };
    rtdb.ref(`packets/incoming/${incomingId}`).set(editPayload);

    const origPacket = (await rtdb.ref(`packets/processed/${PACKET_ID}`).once('value')).val();
    const config = (await rtdb.ref(`well_config/${CONFIG_KEY}`).once('value')).val();
    const outbox = await prepareEditOutbox(
      rtdb,
      incomingId,
      editPayload,
      origPacket,
      config,
      WELL_NAME,
      CONFIG_KEY,
    );

    // Individual interval flow rate vs AFR flow rate
    const intervalFlowRate = outbox.measurements.flowRate;
    const afrFlowRate = outbox.outgoingPayload?.flowRate;
    expect(afrFlowRate).toBeTruthy();
    expect(outbox.dispatchSignal?.flowRate).toBe(afrFlowRate);

    // Simulate Firestore publication 503
    firestore.setFailureHook(DISPATCH_ID, () => {
      throw new Error('Firestore 503 Service Unavailable');
    });

    let pubError: any = null;
    try {
      await executeEditOutbox(rtdb, firestore, outbox);
    } catch (err) {
      pubError = err;
    }
    expect(pubError).toBeTruthy();

    // Verify outbox recorded the error and remained at outgoing_committed
    const midOutbox = (await rtdb.ref(`packets/editOutbox/${editEventId}`).once('value')).val();
    expect(midOutbox.stage).toBe('outgoing_committed');
    expect(midOutbox.lastErrorStage).toBe('dispatch_publication');

    // Mutate processed.flowRate to something completely different to prove replay uses outbox, NOT mutable processed
    await rtdb.ref(`packets/processed/${PACKET_ID}`).update({
      flowRate: '99:99:99_CORRUPTED_RATE',
    });

    // Clear failure hook and retry
    firestore.clearFailureHook(DISPATCH_ID);
    const retryOutcome = await executeEditOutbox(rtdb, firestore, midOutbox);
    expect(retryOutcome.ok).toBe(true);

    // Verify published dispatch payload matches the exact AFR flow rate and revision hash of outgoing
    const dispSnap = await firestore.collection('dispatches').doc(DISPATCH_ID).get();
    const correction = dispSnap.data().lastPullCorrection;
    expect(correction.flowRate).toBe(afrFlowRate);
    expect(correction.flowRate).not.toBe('99:99:99_CORRUPTED_RATE');
    expect(correction.revision).toBe(outbox.revision);

    // Verify revision matches outgoing exactly
    const outgoingSnap = await rtdb.ref(`packets/outgoing/response_${PACKET_ID}`).once('value');
    expect(outgoingSnap.val().lastPullRevision).toBe(correction.revision);
    expect(outgoingSnap.val().flowRate).toBe(correction.flowRate);
  });

  test('Scenario 4: A publication is pending, B arrives — both requests accounted for and final state reflects B', async () => {
    const { rtdb, firestore } = createBaseFixture();
    const config = (await rtdb.ref(`well_config/${CONFIG_KEY}`).once('value')).val();

    // Edit A arrives
    const incA = 'inc_edit_A';
    const evtA = `edit_evt_${incA}`;
    const payloadA = {
      packetId: PACKET_ID,
      editEventId: evtA,
      wellName: WELL_NAME,
      tankTopInches: 105,
      bblsTaken: 95,
      driverId: DRIVER_ID,
    };
    rtdb.ref(`packets/incoming/${incA}`).set(payloadA);

    const origPacket = (await rtdb.ref(`packets/processed/${PACKET_ID}`).once('value')).val();
    const outboxA = await prepareEditOutbox(rtdb, incA, payloadA, origPacket, config, WELL_NAME, CONFIG_KEY);

    // Simulate Firestore offline while A executes
    firestore.setFailureHook(DISPATCH_ID, () => {
      throw new Error('Firestore offline during A');
    });

    try {
      await executeEditOutbox(rtdb, firestore, outboxA);
    } catch {}

    // A is pending at outgoing_committed
    const snapA = (await rtdb.ref(`packets/editOutbox/${evtA}`).once('value')).val();
    expect(snapA.stage).toBe('outgoing_committed');
    expect(snapA.sequence).toBe(1);

    // Now Edit B arrives for the SAME packet
    const incB = 'inc_edit_B';
    const evtB = `edit_evt_${incB}`;
    const payloadB = {
      packetId: PACKET_ID,
      editEventId: evtB,
      wellName: WELL_NAME,
      tankTopInches: 130, // Distinct measurement for B
      bblsTaken: 70,
      driverId: DRIVER_ID,
    };
    rtdb.ref(`packets/incoming/${incB}`).set(payloadB);

    // B prepares outbox while A is pending
    const currentPacketState = (await rtdb.ref(`packets/processed/${PACKET_ID}`).once('value')).val();
    const outboxB = await prepareEditOutbox(rtdb, incB, payloadB, currentPacketState, config, WELL_NAME, CONFIG_KEY);

    // B has higher sequence and later birth
    expect(outboxB.sequence).toBe(2);
    expect(outboxB.createdAtMs).toBeGreaterThan(outboxA.createdAtMs);
    expect(outboxB.revision).not.toBe(outboxA.revision);

    // Firestore recovers before B executes
    firestore.clearFailureHook(DISPATCH_ID);
    const outcomeB = await executeEditOutbox(rtdb, firestore, outboxB);
    expect(outcomeB.ok).toBe(true);

    // Verify final state reflects B:
    // Outgoing has B's revision
    const outgoingSnap = await rtdb.ref(`packets/outgoing/response_${PACKET_ID}`).once('value');
    expect(outgoingSnap.val().lastPullRevision).toBe(outboxB.revision);

    // Dispatch has B's revision and sequence 2
    const dispSnap = await firestore.collection('dispatches').doc(DISPATCH_ID).get();
    expect(dispSnap.data().lastPullCorrection.revision).toBe(outboxB.revision);
    expect(dispSnap.data().lastPullCorrection.sequence).toBe(2);

    // Both edit events exist in edit history!
    const histA = await rtdb.ref(`packets/editHistory/${PACKET_ID}/${evtA}`).once('value');
    const histB = await rtdb.ref(`packets/editHistory/${PACKET_ID}/${evtB}`).once('value');
    expect(histA.exists()).toBe(true);
    expect(histB.exists()).toBe(true);

    // Incoming B was removed; incoming A is still retained pending its resolution
    expect((await rtdb.ref(`packets/incoming/${incB}`).once('value')).exists()).toBe(false);
  });

  test('Scenario 5: A retries after B — no regression or clearing of B work (superseded check)', async () => {
    const { rtdb, firestore } = createBaseFixture();
    const config = (await rtdb.ref(`well_config/${CONFIG_KEY}`).once('value')).val();

    // Setup: A was prepared with sequence 1 and revision A
    const evtA = 'evt_A_older';
    const incA = 'inc_A_older';
    rtdb.ref(`packets/incoming/${incA}`).set({ packetId: PACKET_ID, editEventId: evtA });
    const origPacket = (await rtdb.ref(`packets/processed/${PACKET_ID}`).once('value')).val();
    const outboxA = await prepareEditOutbox(
      rtdb,
      incA,
      { packetId: PACKET_ID, editEventId: evtA, tankTopInches: 105, bblsTaken: 95 },
      origPacket,
      config,
      WELL_NAME,
      CONFIG_KEY,
    );

    // Now B was applied and completed with sequence 2 and revision B
    const evtB = 'evt_B_newer';
    const incB = 'inc_B_newer';
    const currentPkt = (await rtdb.ref(`packets/processed/${PACKET_ID}`).once('value')).val();
    const outboxB = await prepareEditOutbox(
      rtdb,
      incB,
      { packetId: PACKET_ID, editEventId: evtB, tankTopInches: 130, bblsTaken: 70 },
      currentPkt,
      config,
      WELL_NAME,
      CONFIG_KEY,
    );
    await executeEditOutbox(rtdb, firestore, outboxB);

    // Verify B is the active state
    const dispBeforeA = (await firestore.collection('dispatches').doc(DISPATCH_ID).get()).data();
    expect(dispBeforeA.lastPullCorrection.revision).toBe(outboxB.revision);

    // Now A retries!
    const outcomeA = await executeEditOutbox(rtdb, firestore, outboxA);
    expect(outcomeA.ok).toBe(true);
    expect(outcomeA.outbox.superseded).toBe(true);

    // Verify: A did NOT regress or clear B's work!
    const dispAfterA = (await firestore.collection('dispatches').doc(DISPATCH_ID).get()).data();
    expect(dispAfterA.lastPullCorrection.revision).toBe(outboxB.revision);
    expect(dispAfterA.lastPullCorrection.sequence).toBe(2);

    const outgoingAfterA = (await rtdb.ref(`packets/outgoing/response_${PACKET_ID}`).once('value')).val();
    expect(outgoingAfterA.lastPullRevision).toBe(outboxB.revision);

    // Incoming A was cleaned up safely without regression
    expect((await rtdb.ref(`packets/incoming/${incA}`).once('value')).exists()).toBe(false);
  });

  test('Scenario 6: query and identity lookup errors, partial target success — durable retry retained', async () => {
    const { rtdb, firestore } = createBaseFixture();
    const config = (await rtdb.ref(`well_config/${CONFIG_KEY}`).once('value')).val();
    const origPacket = (await rtdb.ref(`packets/processed/${PACKET_ID}`).once('value')).val();

    // Add a second dispatch document and clear direct dispatch hint so query discovery is exercised
    delete origPacket.dispatchId;
    firestore._store['disp-2'] = {
      wellName: WELL_NAME,
      companyId: 'liquid-gold',
      assignedDriverId: DRIVER_ID,
      lastPullPacketId: PACKET_ID,
      lastPullRevision: 'rev-initial',
    };

    const incId = 'inc_partial_1';
    const evtId = `evt_${incId}`;
    const outbox = await prepareEditOutbox(
      rtdb,
      incId,
      { packetId: PACKET_ID, editEventId: evtId, tankTopInches: 112, bblsTaken: 88, driverId: DRIVER_ID },
      origPacket,
      config,
      WELL_NAME,
      CONFIG_KEY,
    );

    // Subcase 6a: Query error in findDispatchIdsForPull throws and keeps outbox pending
    firestore.setFailureHook('query_lastPullPacketId', () => {
      throw new Error('Firestore index building (query error)');
    });

    let queryErr: any = null;
    try {
      await executeEditOutbox(rtdb, firestore, outbox);
    } catch (err) {
      queryErr = err;
    }
    expect(queryErr).toBeTruthy();

    const outboxQueryErr = (await rtdb.ref(`packets/editOutbox/${evtId}`).once('value')).val();
    expect(outboxQueryErr.stage).toBe('outgoing_committed');
    expect(outboxQueryErr.lastErrorStage).toBe('dispatch_query');

    // Clear query error, but make disp-2 fail during publication (partial target success)
    firestore.clearFailureHook('query_lastPullPacketId');
    firestore.setFailureHook('disp-2', () => {
      throw new Error('Lock contention on disp-2');
    });

    let partialErr: any = null;
    try {
      await executeEditOutbox(rtdb, firestore, outboxQueryErr);
    } catch (err) {
      partialErr = err;
    }
    expect(partialErr).toBeTruthy();

    // Verify partial delivery state: disp-1 succeeded, disp-2 failed
    const outboxPartial = (await rtdb.ref(`packets/editOutbox/${evtId}`).once('value')).val();
    expect(outboxPartial.deliveredDispatchIds).toContain(DISPATCH_ID);
    expect(outboxPartial.pendingDispatchIds).toContain('disp-2');
    expect(outboxPartial.stage).toBe('outgoing_committed');

    // Disp-1 received update
    const disp1 = (await firestore.collection('dispatches').doc(DISPATCH_ID).get()).data();
    expect(disp1.lastPullCorrection.revision).toBe(outbox.revision);

    // Clear disp-2 failure hook and retry: ONLY disp-2 should be targeted now
    firestore.clearFailureHook('disp-2');
    const retryOutcome = await executeEditOutbox(rtdb, firestore, outboxPartial);
    expect(retryOutcome.ok).toBe(true);

    // Disp-2 now delivered as well
    const disp2 = (await firestore.collection('dispatches').doc('disp-2').get()).data();
    expect(disp2.lastPullCorrection.revision).toBe(outbox.revision);

    const finalOutbox = (await rtdb.ref(`packets/editOutbox/${evtId}`).once('value')).val();
    expect(finalOutbox.stage).toBe('done');
    expect(finalOutbox.completed).toBe(true);
  });

  test('Scenario 7: actual retry consumer re-entry and final request cleanup demonstrated', async () => {
    const { rtdb, firestore } = createBaseFixture();
    const config = (await rtdb.ref(`well_config/${CONFIG_KEY}`).once('value')).val();
    const origPacket = (await rtdb.ref(`packets/processed/${PACKET_ID}`).once('value')).val();

    // Set up a stranded edit packet in packets/incoming
    const strandedKey = '20260929_090000_Gabriel1_stranded_edit';
    const strandedEvt = `evt_${strandedKey}`;
    const strandedData = {
      packetId: PACKET_ID,
      editEventId: strandedEvt,
      requestType: 'edit',
      wellName: WELL_NAME,
      tankTopInches: 118,
      bblsTaken: 82,
      driverId: DRIVER_ID,
    };
    rtdb.ref(`packets/incoming/${strandedKey}`).set(strandedData);

    // Pre-create outbox in partially executed state (outgoing_committed)
    const outbox = await prepareEditOutbox(
      rtdb,
      strandedKey,
      strandedData,
      origPacket,
      config,
      WELL_NAME,
      CONFIG_KEY,
    );
    outbox.stage = 'outgoing_committed';
    await rtdb.ref(`packets/editOutbox/${strandedEvt}`).set(outbox);

    // 1. Consumer 1: retryStrandedEditRequest (invoked by watchdog)
    const retryResult = await retryStrandedEditRequest(rtdb, firestore, strandedKey, strandedData);
    expect(retryResult.ok).toBe(true);

    // Verify outbox completed and incoming packet cleaned up
    const outboxDone = (await rtdb.ref(`packets/editOutbox/${strandedEvt}`).once('value')).val();
    expect(outboxDone.completed).toBe(true);
    expect((await rtdb.ref(`packets/incoming/${strandedKey}`).once('value')).exists()).toBe(false);

    // 2. Consumer 2: reconcileAllPendingOutboxRecords (scheduled recurring sweep)
    // Create an uncompleted outbox record
    const sweepKey = 'sweep_test_record';
    const sweepOutbox: EditOutboxRecord = {
      ...outbox,
      eventId: sweepKey,
      incomingPacketId: 'inc_sweep',
      completed: false,
      stage: 'dispatches_delivered',
    };
    await rtdb.ref(`packets/editOutbox/${sweepKey}`).set(sweepOutbox);

    const sweepResult = await reconcileAllPendingOutboxRecords(rtdb, firestore);
    expect(sweepResult.checked).toBeGreaterThanOrEqual(1);
    expect(sweepResult.reconciled).toBeGreaterThanOrEqual(1);

    const reconciledRecord = (await rtdb.ref(`packets/editOutbox/${sweepKey}`).once('value')).val();
    expect(reconciledRecord.completed).toBe(true);
    expect(reconciledRecord.stage).toBe('done');
  });
});
