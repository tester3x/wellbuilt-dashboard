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
import { demoScenariosToPrune, MAX_COMPLETED_DEMO_JOBS } from './retention';
import {
  DEMO_BATCH_SIZE, DEMO_COMPANY_ID, DEMO_COMPANY_NAME, DEMO_DRIVERS, DEMO_WELLS,
  buildDemoScenario, type DemoLoad, type DemoScenario, type DemoStage,
} from './plan';

const fs = () => admin.firestore();
const rt = () => admin.database();
const root = 'live_demo';
const stageOrder: DemoStage[] = ['planning', 'pending', 'accepted', 'at_pickup', 'departed', 'at_dropoff', 'closed'];
const STAGE_MS = 15_000;
const BUILD_MS = 60_000;
const BUILDER_PRESENCE_GRACE_MS = 12_000;
const LOCK_MS = 130_000; // longer than either function's maximum execution time
const FIRST_DEMO_TICKET = 900_000_000;
const DEMO_LOGO_URL = 'https://wellbuilt-sync.web.app/live-demo/logo.svg';
const DEMO_VIEWER_UID = 'wellbuilt-demo-shared-viewer';

type Active = { scenario: DemoScenario; stage: DemoStage; dueAt: number; startedAt: number; loadIndex?: number };
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
  lastPrunedAt?: number;
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

async function ensureDemoCompany(): Promise<void> {
  await createDemoFirestore('companies', DEMO_COMPANY_ID, {
    companyId: DEMO_COMPANY_ID, name: DEMO_COMPANY_NAME, status: 'active',
    isDemo: true, invoicingMode: 'ticket_only', wellMonitoring: true,
    logoUrl: DEMO_LOGO_URL, primaryColor: '#0891b2',
    splitTickets: true, liveDispatchSync: false,
    activePackages: ['water-hauling'], assignedOperators: ['Demo Operator'],
    requirePhotos: false, minPhotoCount: 0, ticketStartNumber: FIRST_DEMO_TICKET,
    ticketBookEra: 'post_cutover', createdAt: new Date().toISOString(),
  });
  const companyRef = fs().collection('companies').doc(DEMO_COMPANY_ID);
  await fs().runTransaction(async tx => {
    const current = await tx.get(companyRef);
    assertDemoRecord(current.data(), `companies/${DEMO_COMPANY_ID}`);
    if (current.get('logoUrl') !== DEMO_LOGO_URL || current.get('primaryColor') !== '#0891b2'
      || current.get('splitTickets') !== true || current.get('liveDispatchSync') !== false
      || !Array.isArray(current.get('activePackages')) || !Array.isArray(current.get('assignedOperators'))) {
      tx.update(companyRef, {
        logoUrl: DEMO_LOGO_URL, primaryColor: '#0891b2',
        splitTickets: true, liveDispatchSync: false,
        activePackages: ['water-hauling'], assignedOperators: ['Demo Operator'],
      });
    }
  });
}

async function existingDemoTenant(): Promise<ImmutableRevisionEnvelope | null> {
  const [packet, company, ...records] = await Promise.all([
    loadVerifiedRevision(DEMO_COMPANY_ID, { packageId: 'water-hauling', revision: 1 }),
    fs().collection('companies').doc(DEMO_COMPANY_ID).get(),
    ...DEMO_WELLS.map(name => rt().ref(`well_config/${name}`).once('value')),
    ...DEMO_DRIVERS.map(driver => rt().ref(`drivers/profiles/${driver.id}`).once('value')),
  ]);
  if (!packet.ok || !company.exists || records.some(record => !record.exists())) return null;
  assertDemoRecord(company.data(), `companies/${DEMO_COMPANY_ID}`);
  for (const [index, record] of records.entries()) {
    const path = index < DEMO_WELLS.length
      ? `well_config/${DEMO_WELLS[index]}`
      : `drivers/profiles/${DEMO_DRIVERS[index - DEMO_WELLS.length].id}`;
    assertDemoRecord(record.val(), path);
  }
  return packet.envelope;
}

async function ensureDemoTenant(): Promise<ImmutableRevisionEnvelope> {
  const existing = await existingDemoTenant();
  if (existing) return existing;
  await ensureDemoCompany();
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

function scenarioFromId(id: string): DemoScenario | null {
  if (!/^demo-\d{6}$/.test(id)) return null;
  const sequence = Number(id.slice(5));
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  return buildDemoScenario(sequence);
}

function performanceRowKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error('invalid_demo_pull_time');
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
}

async function deleteCompletedDemoScenario(scenario: DemoScenario): Promise<void> {
  const documentRefs = [
    ...allDispatches(scenario).map(id => fs().collection('dispatches').doc(id)),
    ...scenario.loads.flatMap(load => [
      fs().collection('invoices').doc(`${load.id}-invoice`),
      ...load.stops.map((_, index) => fs().collection('tickets').doc(`${load.id}-ticket-${index + 1}`)),
    ]),
  ];
  const docs = await Promise.all(documentRefs.map(ref => ref.get()));
  for (const doc of docs) {
    if (!doc.exists) continue; // Idempotent after a partial cleanup.
    assertDemoRecord(doc.data(), doc.ref.path);
    if (doc.get('demoScenarioId') !== scenario.id) throw new Error(`demo_scenario_conflict:${doc.ref.path}`);
    if (doc.ref.parent.id === 'dispatches' && doc.get('status') !== 'completed') {
      throw new Error(`demo_dispatch_not_complete:${doc.ref.path}`);
    }
  }

  // Remove RTDB records first. If the Firestore delete fails, the completed
  // dispatches remain discoverable and this cleanup is safely retried.
  const updates: Record<string, null> = {};
  for (const load of scenario.loads) {
    const packetId = `${load.id}-pull`;
    const paths = [`packets/incoming/${packetId}`, `packets/processed/${packetId}`];
    const [incoming, processed, config] = await Promise.all([
      rt().ref(paths[0]).once('value'), rt().ref(paths[1]).once('value'),
      rt().ref(`well_config/${load.pickup}`).once('value'),
    ]);
    assertDemoRecord(config.val(), `well_config/${load.pickup}`);
    for (const [index, packet] of [incoming, processed].entries()) {
      if (!packet.exists()) continue;
      assertDemoRecord(packet.val(), paths[index]);
      if (packet.val()?.packetId !== packetId) throw new Error(`demo_packet_conflict:${paths[index]}`);
      updates[paths[index]] = null;
    }
    if (processed.exists() && processed.val()?.dateTimeUTC) {
      const wellKey = load.pickup.replace(/\s+/g, '_');
      updates[`performance/${wellKey}/rows/${performanceRowKey(processed.val().dateTimeUTC)}`] = null;
    }
  }
  if (Object.keys(updates).length) await rt().ref().update(updates);
  const batch = fs().batch();
  for (const doc of docs) if (doc.exists) batch.delete(doc.ref);
  await batch.commit();
}

/** Cap the real Dispatch Completed list, tickets, invoices and pull records.
 * Only exact synthetic records for the dedicated demo company are eligible. */
async function pruneCompletedDemoJobs(): Promise<Set<string>> {
  const snap = await fs().collection('dispatches').where('companyId', '==', DEMO_COMPANY_ID).get();
  const byScenario = new Map<string, Set<string>>();
  for (const doc of snap.docs) {
    const value = doc.data();
    if (value.isDemo !== true || value.status !== 'completed') continue;
    const scenario = scenarioFromId(value.demoScenarioId);
    if (!scenario || !allDispatches(scenario).includes(doc.id)) continue;
    const ids = byScenario.get(scenario.id) || new Set<string>();
    ids.add(doc.id);
    byScenario.set(scenario.id, ids);
  }
  const completed = [...byScenario].flatMap(([id, ids]) => {
    const scenario = scenarioFromId(id)!;
    return ids.size === allDispatches(scenario).length
      ? [{ id, jobCount: ids.size }] : [];
  });
  const removeIds = demoScenariosToPrune(completed);
  for (let offset = 0; offset < removeIds.length; offset += 5) {
    await Promise.all(removeIds.slice(offset, offset + 5).map(id =>
      deleteCompletedDemoScenario(scenarioFromId(id)!)
    ));
  }
  if (removeIds.length) {
    console.log('[live-demo] completed retention', {
      maxJobs: MAX_COMPLETED_DEMO_JOBS, completedJobsBefore: completed.reduce((sum, run) => sum + run.jobCount, 0),
      removedScenarios: removeIds.length,
    });
  }
  return new Set(removeIds);
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

async function writePending(scenario: DemoScenario, packet: ImmutableRevisionEnvelope, now: number, loadIndex: number): Promise<void> {
  const binding = stampDispatchBinding(packet);
  await Promise.all(scenario.loads.slice(loadIndex, loadIndex + 1).map(async load => {
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

async function writeDispatchStage(scenario: DemoScenario, stage: 'accepted' | 'at_pickup' | 'departed' | 'at_dropoff', now: number, loadIndex: number): Promise<void> {
  const status = stage === 'accepted' ? 'accepted' : 'in_progress';
  const driverStage = stage === 'accepted' ? 'en_route_pickup'
    : stage === 'at_pickup' ? 'on_site_pickup'
      : stage === 'departed' ? 'en_route_dropoff' : 'on_site_dropoff';
  await Promise.all(scenario.loads.slice(loadIndex, loadIndex + 1).flatMap(load => dispatchIds(load).map(id =>
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

function localDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric',
  }).format(date);
}

async function writePullPackets(scenario: DemoScenario, now: number, loadIndex: number): Promise<void> {
  await Promise.all(scenario.loads.slice(loadIndex, loadIndex + 1).map(async load => {
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

async function writeClosed(scenario: DemoScenario, now: number, loadIndex: number): Promise<void> {
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
        company: 'Demo Operator', operator: 'Demo Operator', date: localDate(new Date(now)),
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
  await Promise.all(dispatchIds(scenario.loads[loadIndex]).map(id =>
    mergeDemoFirestore('dispatches', id, {
      status: 'completed', driverStage: 'completed', loadsCompleted: 1,
      completedAt: new Date(now).toISOString(),
    })
  ));
}

async function applyStage(active: Active, now: number): Promise<void> {
  const scenario = active.scenario;
  const loadIndex = active.loadIndex || 0;
  if (active.stage === 'planning') {
    // The public walkthrough may show the draft here. No job exists in the
    // driver's drawer or Dispatch until the next, pending, step commits it.
    return;
  } else if (active.stage === 'pending') {
    const packet = await ensureDemoTenant();
    await writePending(scenario, packet, now, loadIndex);
  } else if (active.stage === 'departed') {
    await writePullPackets(scenario, now, loadIndex);
    await writeDispatchStage(scenario, active.stage, now, loadIndex);
  } else if (active.stage === 'closed') {
    await writeClosed(scenario, now, loadIndex);
  } else {
    await writeDispatchStage(scenario, active.stage, now, loadIndex);
  }
}

async function withLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const holder = randomUUID();
  const ref = rt().ref(`${root}/lock`);
  // Snapshot viewers poll around a stage boundary. Do not queue a write
  // transaction for every viewer while the current worker owns the lease;
  // contention here can delay the owner's release and stretch a 15s step.
  const existing = (await ref.once('value')).val();
  if (existing && typeof existing.until === 'number' && existing.until > Date.now()) return null;
  const claimed = await ref.transaction(current => {
    if (current && typeof current.until === 'number' && current.until > Date.now()) return;
    return { holder, until: Date.now() + LOCK_MS };
  }, undefined, false);
  if (!claimed.committed) return null;
  try { return await fn(); }
  finally {
    // Admin RTDB transactions can invoke the updater with an empty local value
    // and abort on `undefined`, leaving this lease in place until it expires.
    // The callable/scheduler timeout is 60s/120s; a worker only removes its
    // own still-current lease. A later holder is never removed.
    const current = (await ref.once('value')).val();
    if (current?.holder === holder) await ref.remove();
  }
}

async function advance(now: number): Promise<void> {
  const control = (await rt().ref(`${root}/control`).once('value')).val() || {};
  const stateRef = rt().ref(`${root}/state`);
  const raw = (await stateRef.once('value')).val();
  const state: DemoState = raw || blankState(now);
  if (state.companyId !== DEMO_COMPANY_ID || state.schemaVersion !== 1) throw new Error('demo_state_conflict');
  if (!state.lastPrunedAt || now - state.lastPrunedAt > 6 * 60 * 60_000) {
    const removed = await pruneCompletedDemoJobs();
    state.history = (state.history || []).filter(run => !removed.has(run.id));
    state.lastPrunedAt = now;
    await stateRef.set(state);
  }
  if (control.killSwitch === true || control.enabled === false) return;
  const day = new Date(now).toISOString().slice(0, 10);
  if (state.day !== day) { state.day = day; state.startedToday = 0; }
  if (!state.active) {
    const viewerAt = Number((await rt().ref(`${root}/viewerAt`).once('value')).val() || 0);
    if (now - viewerAt > BUILDER_PRESENCE_GRACE_MS || (state.lastClosedAt && now - state.lastClosedAt < 25_000)) {
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
  if (!active) return;
  if (active.stage === 'planning') {
    const builderAt = Number((await rt().ref(`${root}/viewerAt`).once('value')).val() || 0);
    if (now - builderAt > BUILDER_PRESENCE_GRACE_MS) {
      // No job has been dispatched yet. Drop only the unwritten draft when
      // every browser leaves the Build Job tab; later stages are independent.
      state.active = null;
      await stateRef.set(state);
      return;
    }
  }
  if (active.dueAt > now) return;
  try {
    await applyStage(active, now);
    const index = stageOrder.indexOf(active.stage);
    if (index < 0) throw new Error('unknown_demo_stage');
    if (active.stage === 'closed' && (active.loadIndex || 0) + 1 < active.scenario.loads.length) {
      // A multi-haul's next physical pickup starts only after the prior load closes.
      state.active = { ...active, loadIndex: (active.loadIndex || 0) + 1, stage: 'pending', dueAt: now + STAGE_MS };
    } else if (active.stage === 'closed') {
      state.lastCompleted = active.scenario;
      state.lastClosedAt = now;
      state.history = [{
        id: active.scenario.id, kind: active.scenario.kind,
        driverName: active.scenario.driverName, startedAt: active.startedAt, closedAt: now,
      }, ...(state.history || [])].slice(0, 20);
      const removed = await pruneCompletedDemoJobs();
      state.history = state.history.filter(run => !removed.has(run.id));
      state.lastPrunedAt = now;
      state.active = null;
    } else {
      state.active = { ...active, stage: stageOrder[index + 1], dueAt: now + (active.stage === 'planning' ? BUILD_MS : STAGE_MS) };
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

/** One shared, company-scoped viewer identity for public demo visitors. */
export const demoViewerSession = httpsV2.onCall(
  { memory: '256MiB', timeoutSeconds: 30, enforceAppCheck: false },
  async () => {
    await ensureDemoCompany();
    try {
      await admin.auth().getUser(DEMO_VIEWER_UID);
    } catch (error) {
      if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
      try {
        await admin.auth().createUser({ uid: DEMO_VIEWER_UID, displayName: 'WellBuilt Demo Viewer' });
      } catch (createError) {
        if ((createError as { code?: string }).code !== 'auth/uid-already-exists') throw createError;
      }
    }
    const profileRef = rt().ref(`users/${DEMO_VIEWER_UID}`);
    const profile = await profileRef.transaction(current => {
      if (current !== null) {
        if (current.companyId !== DEMO_COMPANY_ID
          || !['viewer', 'demo_viewer'].includes(current.role)
          || current.isDemo !== true) return;
        if (current.role === 'demo_viewer') return;
        return { ...current, role: 'demo_viewer', roles: ['demo_viewer'] };
      }
      return {
        companyId: DEMO_COMPANY_ID, companyName: DEMO_COMPANY_NAME,
        role: 'demo_viewer', roles: ['demo_viewer'], displayName: 'WellBuilt Demo Viewer',
        status: 'active', isDemo: true,
      };
    }, undefined, false);
    const saved = profile.snapshot.val();
    if (!saved || saved.companyId !== DEMO_COMPANY_ID || saved.role !== 'demo_viewer' || saved.isDemo !== true) {
      throw new Error('demo_viewer_identity_conflict');
    }
    const customToken = await admin.auth().createCustomToken(DEMO_VIEWER_UID, {
      staffCompanyId: DEMO_COMPANY_ID, staffRole: 'demo_viewer', isDemo: true,
    });
    return { customToken, companyId: DEMO_COMPANY_ID, role: 'demo_viewer' as const };
  },
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
  async request => {
    if (request.auth?.uid !== DEMO_VIEWER_UID
      || request.auth.token.staffCompanyId !== DEMO_COMPANY_ID
      || !['viewer', 'demo_viewer'].includes(request.auth.token.staffRole as string)
      || request.auth.token.isDemo !== true) {
      throw new httpsV2.HttpsError('permission-denied', 'demo_viewer_required');
    }
    const now = Date.now();
    if (request.data?.watchBuilder === true) {
      await rt().ref(`${root}/viewerAt`).set(now);
    }
    const [beforeState, beforeControl] = await Promise.all([
      rt().ref(`${root}/state`).once('value'), rt().ref(`${root}/control`).once('value'),
    ]);
    const pending: DemoState | null = beforeState.val();
    const settings = beforeControl.val() || {};
    if (settings.enabled !== false && settings.killSwitch !== true
      && (!pending?.active || pending.active.dueAt <= now)) {
      await withLock(() => advance(now));
    }
    const [stateSnap, controlSnap, companySnap] = await Promise.all([
      rt().ref(`${root}/state`).once('value'), rt().ref(`${root}/control`).once('value'),
      fs().collection('companies').doc(DEMO_COMPANY_ID).get(),
    ]);
    const state: DemoState = stateSnap.val() || blankState(now);
    const control = controlSnap.val() || {};
    const companyConfig = companySnap.data();
    if (companyConfig) assertDemoRecord(companyConfig, `companies/${DEMO_COMPANY_ID}`);
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
      companyProfile: {
        name: companyConfig?.name || DEMO_COMPANY_NAME,
        logoUrl: companyConfig?.logoUrl || DEMO_LOGO_URL,
        primaryColor: companyConfig?.primaryColor || '#0891b2',
        invoicingMode: companyConfig?.invoicingMode || 'ticket_only',
        wellMonitoring: companyConfig?.wellMonitoring === true,
        splitTickets: companyConfig?.splitTickets === true,
        liveDispatchSync: companyConfig?.liveDispatchSync === true,
      },
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
