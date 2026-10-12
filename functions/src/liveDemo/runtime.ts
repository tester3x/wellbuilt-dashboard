import * as admin from 'firebase-admin';
import * as httpsV2 from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { randomUUID } from 'crypto';
import {
  CLAIM_COLLECTION, INDEX_COLLECTION, REVISION_COLLECTION,
  type ImmutableRevisionEnvelope,
} from '../security/operational/jobPacketRevisionStore';
import {
  RECEIPT_COLLECTION, runPublishJobPacketRevision, type PublishStoreTx,
} from '../security/operational/jobPacketPublish';
import { loadVerifiedRevision } from '../security/operational/dispatchPinRuntime';
import { stampDispatchBinding } from '../security/operational/dispatchPacketPin';
import { DEMO_PACKET_DRAFT } from './packetDraft';
import {
  DEMO_BATCH_SIZE, DEMO_COMPANY_ID, DEMO_COMPANY_NAME, DEMO_DRIVERS, DEMO_WELLS,
  buildDemoScenario, type DemoLoad, type DemoScenario, type DemoStage,
} from './plan';

const fs = () => admin.firestore();
const rt = () => admin.database();
const root = 'live_demo';
const stageOrder: DemoStage[] = ['planning', 'pending', 'accepted', 'at_pickup', 'departed', 'at_dropoff', 'closed'];
const STAGE_MS = 15_000;
const VIEWER_WINDOW_MS = 120_000;
const LOCK_MS = 90_000;
const FIRST_DEMO_TICKET = 900_000_000;

type Active = { scenario: DemoScenario; stage: DemoStage; dueAt: number; startedAt: number };
type RunSummary = { id: string; kind: DemoScenario['kind']; driverName: string; startedAt: number; closedAt: number };
type DemoState = {
  schemaVersion: 1;
  companyId: typeof DEMO_COMPANY_ID;
  sequence: number;
  day: string;
  startedToday: number;
  active: Active | null;
  history: RunSummary[];
  lastCompleted?: DemoScenario;
  lastClosedAt?: number;
  error?: string;
};

function blankState(now: number): DemoState {
  return {
    schemaVersion: 1, companyId: DEMO_COMPANY_ID, sequence: 0,
    day: new Date(now).toISOString().slice(0, 10), startedToday: 0,
    active: null, history: [],
  };
}

function assertDemoRecord(value: unknown, label: string): void {
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>).isDemo !== true
    || (value as Record<string, unknown>).companyId !== DEMO_COMPANY_ID) {
    throw new Error(`demo_namespace_conflict:${label}`);
  }
}

async function createDemoFirestore(collection: string, id: string, record: Record<string, unknown>): Promise<void> {
  assertDemoRecord(record, `${collection}/${id}`);
  const ref = fs().collection(collection).doc(id);
  await fs().runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (existing.exists) {
      assertDemoRecord(existing.data(), `${collection}/${id}`);
      return;
    }
    tx.create(ref, record);
  });
}

async function mergeDemoFirestore(collection: string, id: string, patch: Record<string, unknown>): Promise<void> {
  const ref = fs().collection(collection).doc(id);
  await fs().runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (!existing.exists) throw new Error(`demo_record_missing:${collection}/${id}`);
    assertDemoRecord(existing.data(), `${collection}/${id}`);
    tx.update(ref, patch);
  });
}

async function createDemoRtdb(path: string, record: Record<string, unknown>): Promise<void> {
  assertDemoRecord(record, path);
  const ref = rt().ref(path);
  const result = await ref.transaction(current => {
    if (current !== null) {
      assertDemoRecord(current, path);
      return;
    }
    return record;
  }, undefined, false);
  if (!result.committed) assertDemoRecord(result.snapshot.val(), path);
}

async function publishDemoPacket(): Promise<ImmutableRevisionEnvelope> {
  const result = await fs().runTransaction(async tx => {
    const store: PublishStoreTx = {
      async getRevision(id) { const s = await tx.get(fs().collection(REVISION_COLLECTION).doc(id)); return s.exists ? s.data() as Record<string, unknown> : null; },
      async getClaim(id) { const s = await tx.get(fs().collection(CLAIM_COLLECTION).doc(id)); return s.exists ? s.data() as Record<string, unknown> : null; },
      async getHead(id) { const s = await tx.get(fs().collection(INDEX_COLLECTION).doc(id)); return s.exists ? s.data() as Record<string, unknown> : null; },
      async getReceipt(id) { const s = await tx.get(fs().collection(RECEIPT_COLLECTION).doc(id)); return s.exists ? s.data() as Record<string, unknown> : null; },
      createRevision(id, value) { tx.create(fs().collection(REVISION_COLLECTION).doc(id), value); },
      createClaim(id, value) { tx.create(fs().collection(CLAIM_COLLECTION).doc(id), value); },
      createHead(id, value) { tx.create(fs().collection(INDEX_COLLECTION).doc(id), value); },
      updateHead(id, value) { tx.update(fs().collection(INDEX_COLLECTION).doc(id), value); },
      createReceipt(id, value) { tx.create(fs().collection(RECEIPT_COLLECTION).doc(id), value); },
    };
    return runPublishJobPacketRevision({
      caller: { uid: 'demo-service', companyId: DEMO_COMPANY_ID },
      request: { requestId: 'demo-bootstrap-r1', expectedLatestRevision: 0, packetDraft: DEMO_PACKET_DRAFT },
      store,
      publishedAt: new Date().toISOString(),
    });
  });
  if (!result.ok) throw new Error(`demo_packet_publish:${result.reason}`);
  const loaded = await loadVerifiedRevision(DEMO_COMPANY_ID, { packageId: 'water-hauling', revision: 1 });
  if (!loaded.ok) throw new Error(`demo_packet_verify:${loaded.reason}`);
  return loaded.envelope;
}

async function ensureDemoTenant(): Promise<ImmutableRevisionEnvelope> {
  await createDemoFirestore('companies', DEMO_COMPANY_ID, {
    companyId: DEMO_COMPANY_ID, name: DEMO_COMPANY_NAME, status: 'active',
    isDemo: true, invoicingMode: 'ticket_only', wellMonitoring: true,
    requirePhotos: false, minPhotoCount: 0, ticketStartNumber: FIRST_DEMO_TICKET,
    ticketBookEra: 'post_cutover', createdAt: new Date().toISOString(),
  });
  await Promise.all(DEMO_WELLS.map(name =>
    createDemoRtdb(`well_config/${name}`, {
      companyId: DEMO_COMPANY_ID, isDemo: true, name, route: 'Demo Route',
      tanks: 1, bottomLevel: 24, pullBbls: 140, bblPerFoot: 20,
      tankHeight: 240, recoveryCeilingFeet: 20,
      lat: 0.1, lng: 0.1 + DEMO_WELLS.indexOf(name) * 0.01,
    })
  ));
  await Promise.all(DEMO_DRIVERS.map(({ id, name, truck }) =>
    createDemoRtdb(`drivers/profiles/${id}`, {
      companyId: DEMO_COMPANY_ID, isDemo: true, driverId: id,
      legalName: name, displayName: name, active: true,
      truckNumber: truck,
    })
  ));
  return publishDemoPacket();
}

function dispatchIds(load: DemoLoad): string[] {
  return load.stops.length > 1
    ? [0, ...load.stops.map((_, i) => i + 1)].map(n => `${load.id}-leg-${n + 1}`)
    : [`${load.id}-leg-1`];
}

function ticketNumber(scenario: DemoScenario, loadIndex: number, stopIndex: number): number {
  return FIRST_DEMO_TICKET + scenario.sequence * 10 + loadIndex * 3 + stopIndex;
}

function allDispatches(scenario: DemoScenario): string[] {
  return scenario.loads.flatMap(dispatchIds);
}

async function completedRunProof(id: string): Promise<{
  id: string; dispatchesCompleted: number; dispatchCount: number;
  closedInvoices: number; invoiceCount: number; ticketCount: number;
  processedPulls: number; pullCount: number; totalBBL: number;
}> {
  const sequence = Number(id.replace(/^demo-/, ''));
  if (!Number.isSafeInteger(sequence) || buildDemoScenario(sequence).id !== id) {
    throw new Error('invalid_demo_history_id');
  }
  const scenario = buildDemoScenario(sequence);
  const loads = await Promise.all(scenario.loads.map(async load => {
    const [invoice, pull, ...tickets] = await Promise.all([
      fs().collection('invoices').doc(`${load.id}-invoice`).get(),
      rt().ref(`packets/processed/${load.id}-pull`).once('value'),
      ...load.stops.map((_, i) => fs().collection('tickets').doc(`${load.id}-ticket-${i + 1}`).get()),
    ]);
    if (invoice.exists) assertDemoRecord(invoice.data(), `invoices/${load.id}-invoice`);
    for (const [i, ticket] of tickets.entries()) {
      if (ticket.exists) assertDemoRecord(ticket.data(), `tickets/${load.id}-ticket-${i + 1}`);
    }
    if (pull.exists() && pull.val()?.companyId !== DEMO_COMPANY_ID) throw new Error('demo_pull_company_conflict');
    return {
      invoiceClosed: invoice.data()?.status === 'closed',
      bbls: Number(invoice.data()?.totalBBL || 0),
      processedPull: pull.exists(),
      ticketCount: tickets.filter(ticket => ticket.exists).length,
    };
  }));
  const dispatches = await Promise.all(allDispatches(scenario).map(id => fs().collection('dispatches').doc(id).get()));
  for (const [i, dispatch] of dispatches.entries()) {
    if (dispatch.exists) assertDemoRecord(dispatch.data(), `dispatches/${allDispatches(scenario)[i]}`);
  }
  return {
    id, dispatchesCompleted: dispatches.filter(dispatch => dispatch.data()?.status === 'completed').length,
    dispatchCount: dispatches.length,
    closedInvoices: loads.filter(load => load.invoiceClosed).length,
    invoiceCount: loads.length,
    ticketCount: loads.reduce((sum, load) => sum + load.ticketCount, 0),
    processedPulls: loads.filter(load => load.processedPull).length,
    pullCount: loads.length,
    totalBBL: loads.reduce((sum, load) => sum + load.bbls, 0),
  };
}

async function writePending(scenario: DemoScenario, packet: ImmutableRevisionEnvelope, now: number): Promise<void> {
  const binding = stampDispatchBinding(packet);
  await Promise.all(scenario.loads.map(async load => {
    const ids = dispatchIds(load);
    await Promise.all(ids.map(async (id, index) => {
      const isSplit = load.stops.length > 1;
      const name = index === 0 ? load.pickup : load.stops[index - 1].name;
      const record: Record<string, unknown> = {
        companyId: DEMO_COMPANY_ID, isDemo: true, demoScenarioId: scenario.id,
        driverId: scenario.driverId, driverHash: scenario.driverId, driverName: scenario.driverName,
        wellName: name, ndicWellName: '', operator: 'Demo Operator', route: 'Demo Route',
        disposal: load.stops[load.stops.length - 1].name,
        jobType: isSplit ? 'service' : 'pw', jobTypeId: isSplit ? 'service-work' : 'pw',
        ...binding, status: 'pending', assignedAt: new Date(now).toISOString(),
        assignedBy: 'WellBuilt live demo', loadCount: 1, loadsCompleted: 0,
        bbls: index === 0 ? load.bbls : load.stops[index - 1].bbls,
        notes: 'Synthetic demo data', priority: 3,
        ...(load.haulGroupId ? { haulGroupId: load.haulGroupId } : {}),
        ...(isSplit ? { splitGroupId: load.familyId, splitSequence: index + 1, splitTotal: ids.length } : {}),
      };
      await createDemoFirestore('dispatches', id, record);
    }));
  }));
}

async function writeDispatchStage(scenario: DemoScenario, stage: 'accepted' | 'at_pickup' | 'departed' | 'at_dropoff', now: number): Promise<void> {
  const status = stage === 'accepted' ? 'accepted' : 'in_progress';
  const driverStage = stage === 'accepted' ? 'en_route_pickup'
    : stage === 'at_pickup' ? 'on_site_pickup'
      : stage === 'departed' ? 'en_route_dropoff' : 'on_site_dropoff';
  await Promise.all(scenario.loads.flatMap(load => dispatchIds(load).map(id =>
    mergeDemoFirestore('dispatches', id, {
        status, driverStage, loadsCompleted: 0,
        driverDest: stage === 'accepted' || stage === 'at_pickup'
          ? load.pickup : load.stops[load.stops.length - 1].name,
        [`demoStageTimes.${stage}`]: new Date(now).toISOString(),
    })
  )));
}

function localDateTime(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date).replace(',', '');
}

async function writePullPackets(scenario: DemoScenario, now: number): Promise<void> {
  await Promise.all(scenario.loads.map(async load => {
    const packetId = `${load.id}-pull`;
    const packet = {
      packetId, idempotencyKey: packetId, requestType: 'pull',
      wellName: load.pickup, dateTimeUTC: new Date(now).toISOString(),
      dateTime: localDateTime(new Date(now)), timezone: 'America/Chicago',
      tankLevelFeet: 10, bblsTaken: load.bbls,
      driverName: scenario.driverName, driverId: scenario.driverId,
      jobType: 'Production Water', jobOrigin: 'dispatch',
      companyId: DEMO_COMPANY_ID, invoicingMode: 'ticket_only',
      originAppContext: 'wbt', invoiceDocId: `${load.id}-invoice`,
      dispatchId: dispatchIds(load)[0], isDemo: true,
    };
    await createDemoRtdb(`packets/incoming/${packetId}`, packet);
  }));
}

async function writeClosed(scenario: DemoScenario, now: number): Promise<void> {
  for (let loadIndex = 0; loadIndex < scenario.loads.length; loadIndex += 1) {
    const load = scenario.loads[loadIndex];
    const ids = dispatchIds(load);
    const tickets: string[] = [];
    for (let stopIndex = 0; stopIndex < load.stops.length; stopIndex += 1) {
      const stop = load.stops[stopIndex];
      const number = ticketNumber(scenario, loadIndex, stopIndex);
      const id = `${load.id}-ticket-${stopIndex + 1}`;
      tickets.push(String(number));
      await createDemoFirestore('tickets', id, {
        companyId: DEMO_COMPANY_ID, isDemo: true, demoScenarioId: scenario.id,
        ticketNumber: number, wellName: load.pickup, location: load.pickup,
        hauledTo: stop.name, qty: String(stop.bbls), top: '10',
        type: scenario.kind === 'split_ticket' ? 'Service Work' : 'Production Water',
        driver: scenario.driverName, driverId: scenario.driverId,
        invoiceDocId: `${load.id}-invoice`, dispatchId: ids[Math.min(stopIndex + 1, ids.length - 1)],
        packetId: `${load.id}-pull`, truckNumber: DEMO_DRIVERS.find(driver => driver.id === scenario.driverId)?.truck,
        splitChainId: load.familyId, splitChainSeq: stopIndex + 1,
        ...(load.haulGroupId ? { haulGroupId: load.haulGroupId } : {}),
        createdAt: new Date(now).toISOString(),
      });
    }
    await createDemoFirestore('invoices', `${load.id}-invoice`, {
      companyId: DEMO_COMPANY_ID, isDemo: true, demoScenarioId: scenario.id,
      status: 'closed', invoicingMode: 'ticket_only',
      driver: scenario.driverName, driverId: scenario.driverId, driverHash: scenario.driverId,
      wellName: load.pickup, hauledTo: load.stops[load.stops.length - 1].name,
      operator: 'Demo Operator', commodityType: 'Production Water',
      jobType: scenario.kind === 'split_ticket' ? 'service' : 'pw',
      dispatchId: ids[0], packetId: `${load.id}-pull`, tickets,
      ticketNumber: tickets[0], ticketSummaries: load.stops.map((stop, i) => ({
        ticketNumber: tickets[i], qty: String(stop.bbls), wellName: load.pickup,
      })),
      totalBBL: load.bbls, totalHours: 0.25, jobDurationMs: 15 * 60_000,
      date: new Date(now).toISOString().slice(0, 10),
      createdAt: new Date(now - 15 * 60_000).toISOString(), closedAt: new Date(now).toISOString(),
      requirePhotos: false, minPhotoCount: 0,
      ...(load.haulGroupId ? { haulGroupId: load.haulGroupId } : {}),
      ...(scenario.kind === 'split_ticket' ? { splitGroupId: load.familyId } : {}),
    });
  }
  await Promise.all(allDispatches(scenario).map(id =>
    mergeDemoFirestore('dispatches', id, {
      status: 'completed', driverStage: 'completed', loadsCompleted: 1,
      completedAt: new Date(now).toISOString(),
    })
  ));
}

async function applyStage(active: Active, now: number): Promise<void> {
  const scenario = active.scenario;
  if (active.stage === 'planning') {
    // The public walkthrough may show the draft here. No job exists in the
    // driver's drawer or Dispatch until the next, pending, step commits it.
    return;
  } else if (active.stage === 'pending') {
    const packet = await ensureDemoTenant();
    await writePending(scenario, packet, now);
  } else if (active.stage === 'departed') {
    await writePullPackets(scenario, now);
    await writeDispatchStage(scenario, active.stage, now);
  } else if (active.stage === 'closed') {
    await writeClosed(scenario, now);
  } else {
    await writeDispatchStage(scenario, active.stage, now);
  }
}

async function withLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const holder = randomUUID();
  const ref = rt().ref(`${root}/lock`);
  const claimed = await ref.transaction(current => {
    if (current && typeof current.until === 'number' && current.until > Date.now()) return;
    return { holder, until: Date.now() + LOCK_MS };
  }, undefined, false);
  if (!claimed.committed) return null;
  try { return await fn(); }
  finally {
    await ref.transaction(current => current?.holder === holder ? null : undefined, undefined, false);
  }
}

async function advance(now: number): Promise<void> {
  const control = (await rt().ref(`${root}/control`).once('value')).val() || {};
  if (control.killSwitch === true || control.enabled === false) return;
  const stateRef = rt().ref(`${root}/state`);
  const raw = (await stateRef.once('value')).val();
  const state: DemoState = raw || blankState(now);
  if (state.companyId !== DEMO_COMPANY_ID || state.schemaVersion !== 1) throw new Error('demo_state_conflict');
  const day = new Date(now).toISOString().slice(0, 10);
  if (state.day !== day) { state.day = day; state.startedToday = 0; }
  if (!state.active) {
    const viewerAt = Number((await rt().ref(`${root}/viewerAt`).once('value')).val() || 0);
    if (now - viewerAt > VIEWER_WINDOW_MS || (state.lastClosedAt && now - state.lastClosedAt < 25_000)) {
      await stateRef.set(state);
      return;
    }
    const next = state.sequence + 1;
    state.active = { scenario: buildDemoScenario(next), stage: 'planning', dueAt: now, startedAt: now };
    state.sequence = next;
    state.startedToday += 1;
    await stateRef.set(state);
  }
  const active = state.active;
  if (!active || active.dueAt > now) return;
  try {
    await applyStage(active, now);
    const index = stageOrder.indexOf(active.stage);
    if (index < 0) throw new Error('unknown_demo_stage');
    if (active.stage === 'closed') {
      state.lastCompleted = active.scenario;
      state.lastClosedAt = now;
      state.history = [{
        id: active.scenario.id, kind: active.scenario.kind,
        driverName: active.scenario.driverName, startedAt: active.startedAt, closedAt: now,
      }, ...(state.history || [])].slice(0, 20);
      state.active = null;
    } else {
      state.active = { ...active, stage: stageOrder[index + 1], dueAt: now + STAGE_MS };
    }
    delete state.error;
    await stateRef.set(state);
  } catch (error) {
    state.error = error instanceof Error ? error.message.slice(0, 120) : 'demo_step_failed';
    await stateRef.set(state);
    throw error;
  }
}

export const advanceLiveDemo = onSchedule(
  { schedule: 'every 1 minutes', timeZone: 'UTC', memory: '256MiB', timeoutSeconds: 120 },
  async () => { await withLock(() => advance(Date.now())); },
);

/** Emulator-only entry for the end-to-end test; never a deployed callable. */
export async function advanceLiveDemoForEmulator(now: number): Promise<void> {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    throw new Error('demo_emulator_only');
  }
  await withLock(() => advance(now));
}

export const liveDemoSnapshot = httpsV2.onCall(
  { memory: '256MiB', timeoutSeconds: 60, enforceAppCheck: false },
  async () => {
    const now = Date.now();
    await rt().ref(`${root}/viewerAt`).set(now);
    const [beforeState, beforeControl] = await Promise.all([
      rt().ref(`${root}/state`).once('value'), rt().ref(`${root}/control`).once('value'),
    ]);
    const pending: DemoState | null = beforeState.val();
    const settings = beforeControl.val() || {};
    if (settings.enabled !== false && settings.killSwitch !== true
      && (!pending?.active || pending.active.dueAt <= now)) {
      await withLock(() => advance(now));
    }
    const [stateSnap, controlSnap] = await Promise.all([
      rt().ref(`${root}/state`).once('value'), rt().ref(`${root}/control`).once('value'),
    ]);
    const state: DemoState = stateSnap.val() || blankState(now);
    const control = controlSnap.val() || {};
    const active = state.active;
    const featured = active?.scenario || state.lastCompleted || null;
    const ids = featured ? allDispatches(featured) : [];
    const dispatches = await Promise.all(ids.map(async id => {
      const snap = await fs().collection('dispatches').doc(id).get();
      const value = snap.data();
      if (value) assertDemoRecord(value, `dispatches/${id}`);
      return { id, exists: snap.exists, status: value?.status || null,
        driverStage: value?.driverStage || null, driverDest: value?.driverDest || null,
        wellName: value?.wellName || null,
        disposal: value?.disposal || null, bbls: value?.bbls || null,
        jobType: value?.jobType || null, operator: value?.operator || null,
        route: value?.route || null, currentLevel: value?.currentLevel || null,
        flowRate: value?.flowRate || null, assignedAt: value?.assignedAt || null,
        splitGroupId: value?.splitGroupId || null, splitSequence: value?.splitSequence || null,
        ticketNumber: value?.ticketNumber || null, notes: value?.notes || null };
    }));
    const loads = featured ? await Promise.all(featured.loads.map(async load => {
      const [incoming, processed, invoice, ...tickets] = await Promise.all([
        rt().ref(`packets/incoming/${load.id}-pull`).once('value'),
        rt().ref(`packets/processed/${load.id}-pull`).once('value'),
        fs().collection('invoices').doc(`${load.id}-invoice`).get(),
        ...load.stops.map((_, i) => fs().collection('tickets').doc(`${load.id}-ticket-${i + 1}`).get()),
      ]);
      if (incoming.exists()) assertDemoRecord(incoming.val(), `packets/incoming/${load.id}-pull`);
      if (processed.exists()) assertDemoRecord(processed.val(), `packets/processed/${load.id}-pull`);
      if (invoice.exists) assertDemoRecord(invoice.data(), `invoices/${load.id}-invoice`);
      return {
        id: load.id, pickup: load.pickup, bbls: load.bbls,
        pullStatus: processed.exists() ? 'processed' : incoming.exists() ? 'queued' : 'awaiting pickup',
        tickets: tickets.map((ticket, i) => {
          const value = ticket.data();
          if (value) assertDemoRecord(value, `tickets/${load.id}-ticket-${i + 1}`);
          return { id: `${load.id}-ticket-${i + 1}`, exists: ticket.exists,
            number: value?.ticketNumber || null, qty: value?.qty || null,
            destination: value?.hauledTo || load.stops[i].name,
            familyId: value?.splitChainId || load.familyId };
        }),
        invoice: { exists: invoice.exists, status: invoice.data()?.status || null,
          totalBBL: invoice.data()?.totalBBL || null,
          ticketNumbers: invoice.data()?.tickets || [] },
      };
    })) : [];
    const latestProof = state.history?.[0] ? await completedRunProof(state.history[0].id) : null;
    return {
      company: DEMO_COMPANY_NAME, companyId: DEMO_COMPANY_ID,
      synthetic: true, enabled: control.enabled !== false && control.killSwitch !== true,
      active, featured, featuredStage: active?.stage || (featured ? 'complete' : null),
      history: state.history || [], dispatches, loads, latestProof,
      sequence: state.sequence, startedToday: state.startedToday,
      batchSize: DEMO_BATCH_SIZE, batchNumber: Math.floor((Math.max(1, state.sequence) - 1) / DEMO_BATCH_SIZE) + 1,
      runInBatch: state.sequence ? (state.sequence - 1) % DEMO_BATCH_SIZE + 1 : 0,
      nextRunAt: state.lastClosedAt ? state.lastClosedAt + 25_000 : null,
      error: state.error || null,
      observedAt: now,
    };
  },
);
