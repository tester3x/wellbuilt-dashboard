/**
 * Incident-bound unclaimed recovery.
 *
 * Handler tests use an in-memory store for wellbuilt-sync authority /
 * diagnostic reads. They do not stand in for the dedicated WB-E
 * Firestore project. Schema and Admin-SDK query construction are
 * covered separately; emulator coverage is in
 * unclaimedShiftRecovery.query.emulator.e2e.test.ts.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AdminCallError, type AdminDocSnapshot } from '../../../admin/adminDeps';
import { ADMIN_AUDIT_COLLECTION } from '../../../admin/adminAudit';
import { ADMIN_POLICY_VERSION, PLATFORM_ADMINS_COLLECTION } from '../../../admin/authority';
import { SERVER_AUTHORABLE_EVENT_TYPES, shiftAuthorityPath, shiftDayPath } from '../shiftAuthority';
import {
  INCIDENT,
  WB_E_COMPLETION_AUTHORITY,
  computeInspectFingerprint,
  credentialsPath,
  dedicatedEquipmentPostTripQuerySpec,
  dedicatedPostTripDocumentMatches,
  nameIndexPath,
  recoveryAuditDocId,
  snapshotFromEvidence,
  type RecoveryQueryResult,
  type RecoveryQuerySpec,
  type RedactedDiagnosticTuple,
  type UnclaimedInspectSnapshot,
} from '../unclaimedShiftRecovery';
import {
  recoverUnclaimedDriverShiftHandler,
  type RecoveryTx,
  type UnclaimedRecoveryDeps,
} from '../unclaimedShiftRecoveryHandler';
import { applyDedicatedEquipmentPostTripQuery, assertDedicatedEquipmentProject } from '../unclaimedShiftRecoveryQueries';

const DRIVER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_DRIVER = '11111111-2222-3333-4444-555555555555';
const COMPANY = INCIDENT.companyId;
const PERIOD = INCIDENT.periodId;
const ORIGIN = INCIDENT.originLocalDate;
const LAST_CLOSED = INCIDENT.lastClosedPeriodId;
const NOW_MS = Date.parse('2026-08-23T21:00:00-05:00');
const ADMIN_UID = 'admin-uid-1';
const ADMIN_AUTH = {
  uid: ADMIN_UID,
  token: { wellbuiltAdmin: true, email: 'admin@example.com', email_verified: true },
};
const OTHER_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const INCIDENT_DIAG = {
  app: 'wbs',
  area: 'shift',
  event: 'shiftId.minted',
  result: 'ok',
  reason: 'legacy path local mint',
  source: 'AuthContext.startShift',
  shiftId: PERIOD,
  clientTimestamp: '2026-08-21T16:24:21.855Z',
};

interface Store { [path: string]: Record<string, unknown> }

function applySpec(store: Store, spec: RecoveryQuerySpec): RecoveryQueryResult {
  const docs: Array<{ id: string; data: Record<string, unknown> }> = [];
  if (spec.kind === 'minted_diagnostics') {
    for (const [path, data] of Object.entries(store)) {
      if (!path.startsWith('wb_diagnostics/')) continue;
      if (data.shiftId === spec.periodId && data.event === 'shiftId.minted') {
        docs.push({ id: path.slice('wb_diagnostics/'.length), data });
      }
    }
  }
  return { readable: true, docs, matchingCount: docs.length };
}

function buildDeps(seed: Store, opts: {
  hashMap?: Record<string, string | null>;
  queryError?: RecoveryQueryResult['error'];
} = {}): { deps: UnclaimedRecoveryDeps; store: Store; writes: string[] } {
  const store: Store = JSON.parse(JSON.stringify(seed));
  const writes: string[] = [];
  const snap = (p: string): AdminDocSnapshot => ({ exists: p in store, data: store[p] });
  const qrun = (spec: RecoveryQuerySpec): RecoveryQueryResult => {
    if (opts.queryError) {
      return { readable: false, error: opts.queryError, docs: [], matchingCount: 0 };
    }
    return applySpec(store, spec);
  };
  const runOnce = async <T>(fn: (tx: RecoveryTx) => Promise<T>): Promise<T> => {
    const staged: Array<() => void> = [];
    const tx: RecoveryTx = {
      async get(p) { return snap(p); },
      async getQuery(spec) { return qrun(spec); },
      update(p, fields) {
        staged.push(() => {
          if (!(p in store)) throw new Error(`update_on_missing:${p}`);
          store[p] = { ...store[p], ...fields };
          writes.push(`update ${p}`);
        });
      },
      create(p, data) {
        staged.push(() => {
          if (p in store) throw new Error(`create_on_existing:${p}`);
          store[p] = { ...data };
          writes.push(`create ${p}`);
        });
      },
    };
    const result = await fn(tx);
    staged.forEach((w) => w());
    return result;
  };
  const deps: UnclaimedRecoveryDeps = {
    async getDoc(p) { return snap(p); },
    async getQuery(spec) { return qrun(spec); },
    async runTransaction(fn) {
      return runOnce(fn as never);
    },
    async runRecoveryTransaction(fn) {
      return runOnce(fn);
    },
    async listDocsById() { return []; },
    newAuditId: () => 'unused',
    serverTimestamp: () => '__ts__',
    nowMs: () => NOW_MS,
    async resolveApprovedHash(hash) {
      if (!opts.hashMap) return null;
      return Object.prototype.hasOwnProperty.call(opts.hashMap, hash) ? opts.hashMap[hash] : null;
    },
  };
  return { deps, store, writes };
}

const mikeSeed = (): Store => ({
  [`${PLATFORM_ADMINS_COLLECTION}/${ADMIN_UID}`]: {
    enabled: true, policyVersion: ADMIN_POLICY_VERSION,
  },
  [nameIndexPath('mikezfold')]: { driverId: DRIVER },
  [credentialsPath(DRIVER)]: { active: true },
  [shiftAuthorityPath(DRIVER)]: {
    driverId: DRIVER, companyId: COMPANY, initialized: true,
    openPeriodId: null, originLocalDate: null, lastClosedPeriodId: LAST_CLOSED, version: 5,
  },
  'wb_diagnostics/mint-1': { ...INCIDENT_DIAG },
});

function payload(over: Record<string, unknown> = {}) {
  return {
    driverId: DRIVER,
    companyId: COMPANY,
    periodId: PERIOD,
    expectedAuthorityVersion: 5,
    mode: 'inspect',
    reason: 'incident recover 2026-08-21_112421',
    inspectStateFingerprint: '',
    ...over,
  };
}

function writerShapedPostTrip(periodId: string, orgId: string): Record<string, unknown> {
  return {
    inspectionId: 'insp-post-1',
    reportId: 'insp-post-1',
    orgId,
    report: {
      schemaVersion: 'dvir-report/2',
      inspectionId: 'insp-post-1',
      reportId: 'insp-post-1',
      shiftId: periodId,
      companyId: orgId,
      inspectionType: 'post_trip',
      driver: { driverHash: 'hhhh' },
      noDefects: true,
      issues: [],
      version: 1,
      completedAt: '2026-08-21T20:00:00.000Z',
    },
    summary: {
      completedAt: '2026-08-21T20:00:00.000Z',
      inspectionType: 'post_trip',
      driverHash: 'hhhh',
      noDefects: true,
      issueCount: 0,
      version: 1,
    },
    localCreatedAt: '2026-08-21T20:00:00.000Z',
    syncedAt: '2026-08-21T20:00:00.000Z',
  };
}

function assertZeroRecoveryWrites(store: Store, writes: string[], opts: {
  originDayMayExist?: boolean;
} = {}) {
  expect(writes).toEqual([]);
  expect(store[shiftAuthorityPath(DRIVER)]?.openPeriodId ?? null).toBeNull();
  if (!opts.originDayMayExist) {
    expect(store[shiftDayPath(DRIVER, ORIGIN)]).toBeUndefined();
  } else {
    const events = store[shiftDayPath(DRIVER, ORIGIN)]?.events as unknown[] | undefined;
    expect(events ?? []).toEqual([]);
  }
  expect(store[`${ADMIN_AUDIT_COLLECTION}/${recoveryAuditDocId(PERIOD, sha(DRIVER).slice(0, 12))}`])
    .toBeUndefined();
}

function baseSnap(over: Partial<UnclaimedInspectSnapshot> = {}): UnclaimedInspectSnapshot {
  const tuples: RedactedDiagnosticTuple[] = over.diagnosticTuples ?? [{
    id: 'mint-1',
    app: 'wbs',
    area: 'shift',
    event: 'shiftId.minted',
    result: 'ok',
    reason: INCIDENT.diagnostic.reason,
    source: INCIDENT.diagnostic.source,
    shiftId: PERIOD,
    clientTimestamp: '2026-08-21T16:24:21.855Z',
  }];
  return {
    driverId: DRIVER,
    companyId: COMPANY,
    periodId: PERIOD,
    originLocalDate: ORIGIN,
    expectedAuthorityVersion: 5,
    initialized: true,
    authorityState: 'none',
    openPeriodId: null,
    authorityOriginLocalDate: null,
    lastClosedPeriodId: LAST_CLOSED,
    authorityVersion: 5,
    originDayPresent: false,
    originDayCurrentShiftId: null,
    originDayReadable: true,
    identityMatch: true,
    nameIndexMatch: true,
    credentialsActive: true,
    diagnosticBound: 'anonymous',
    diagnosticMatchingCount: tuples.length,
    diagnosticTuples: tuples,
    diagnosticSource: tuples[0]?.source ?? null,
    diagnosticResult: tuples[0]?.result ?? null,
    diagnosticReason: tuples[0]?.reason ?? null,
    diagnosticApp: tuples[0]?.app ?? null,
    diagnosticArea: tuples[0]?.area ?? null,
    diagnosticEvent: tuples[0]?.event ?? null,
    diagnosticShiftId: tuples[0]?.shiftId ?? null,
    diagnosticClientTimestamp: tuples[0]?.clientTimestamp ?? null,
    completionStoreKind: 'none_authoritative_server',
    writerSha: WB_E_COMPLETION_AUTHORITY.writerSha,
    dedicatedProjectProd: WB_E_COMPLETION_AUTHORITY.dedicatedProject.prod,
    productionCloudWritesEnabled: false,
    productionAuthoritativeServerStore: false,
    productionCompletion: 'device_local',
    crossProjectAtomicExclusion: false,
    ...over,
  };
}

describe('production WB-E completion authority pin', () => {
  it('pins the audited writer SHA, dedicated projects, and hard-disabled production writes', () => {
    expect(WB_E_COMPLETION_AUTHORITY.writerSha).toBe('994ddcee146194874bd8fa1b97b4990eb3193831');
    expect(WB_E_COMPLETION_AUTHORITY.namedApp).toBe('dvir');
    expect(WB_E_COMPLETION_AUTHORITY.dedicatedProject.prod).toBe('wellbuilt-equipment-prod');
    expect(WB_E_COMPLETION_AUTHORITY.dedicatedProject.dev).toBe('wellbuilt-equipment-dev');
    expect(WB_E_COMPLETION_AUTHORITY.forbiddenHostProject).toBe('wellbuilt-sync');
    expect(WB_E_COMPLETION_AUTHORITY.productionCloudWritesEnabled).toBe(false);
    expect(WB_E_COMPLETION_AUTHORITY.productionAuthoritativeServerStore).toBe(false);
    expect(WB_E_COMPLETION_AUTHORITY.productionCompletion).toBe('device_local');
    expect(WB_E_COMPLETION_AUTHORITY.crossProjectAtomicExclusion).toBe(false);
    expect(WB_E_COMPLETION_AUTHORITY.query.inspectionTypeField).toBe('summary.inspectionType');
    expect(WB_E_COMPLETION_AUTHORITY.query.shiftIdField).toBe('report.shiftId');
  });

  it('refuses wellbuilt-sync as the dedicated query project', () => {
    expect(() => assertDedicatedEquipmentProject('wellbuilt-sync')).toThrow(/wellbuilt-sync/);
    expect(() => assertDedicatedEquipmentProject('wellbuilt-equipment-prod')).not.toThrow();
    expect(() => applyDedicatedEquipmentPostTripQuery(
      {} as never, COMPANY, PERIOD, 'wellbuilt-sync',
    )).toThrow(/wellbuilt-sync/);
  });
});

describe('Mike incident — no authoritative server completion store', () => {
  it('inspect of otherwise-valid evidence is not recoverable and writes nothing', async () => {
    const { deps, store, writes } = buildDeps(mikeSeed());
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.recoverable).toBe(false);
    expect(out.reason).toBe('no_authoritative_server_completion_store');
    expect(out.changed).toBe(false);
    expect(out.evidence?.diagnosticBound).toBe('anonymous');
    expect(out.evidence?.nameIndexMatch).toBe(true);
    expect(out.evidence?.productionAuthoritativeServerStore).toBe(false);
    expect(out.evidence?.completionStoreKind).toBe('none_authoritative_server');
    expect(out.evidence?.writerSha).toBe(WB_E_COMPLETION_AUTHORITY.writerSha);
    expect(out.evidence?.crossProjectAtomicExclusion).toBe(false);
    expect(out.completionStores?.wellbuiltSyncOrganizationsDvirReports).toMatch(/NOT the WB-E store/);
    assertZeroRecoveryWrites(store, writes);
  });

  it('execute with a matching inspect fingerprint still refuses and writes nothing', async () => {
    const { deps, store, writes } = buildDeps(mikeSeed());
    const inspected = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(inspected.fingerprint).toEqual(expect.any(String));
    const writesBefore = writes.length;
    await expect(recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({
        mode: 'execute',
        inspectStateFingerprint: inspected.fingerprint,
      }),
    )).rejects.toMatchObject({
      adminCode: 'recover_unclaimed_refused:no_authoritative_server_completion_store',
    });
    expect(writes.length).toBe(writesBefore);
    assertZeroRecoveryWrites(store, writes);
  });
});

describe('diagnostic shape — Mike incident', () => {
  it('anonymous diagnostic that is not the reviewed shape denies with zero writes', async () => {
    const seed = mikeSeed();
    seed['wb_diagnostics/mint-1'] = { ...INCIDENT_DIAG, source: 'spoof', reason: 'legacy path local mint' };
    const { deps, store, writes } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.recoverable).toBe(false);
    expect(out.reason).toBe('diagnostic_mismatch');
    assertZeroRecoveryWrites(store, writes);
  });

  it('diagnostic for another driver denies', async () => {
    const seed = mikeSeed();
    seed['wb_diagnostics/mint-1'] = { ...INCIDENT_DIAG, driverHash: OTHER_HASH };
    const { deps, store, writes } = buildDeps(seed, { hashMap: { [OTHER_HASH]: OTHER_DRIVER } });
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.reason).toBe('foreign_diagnostic');
    assertZeroRecoveryWrites(store, writes);
  });

  it('diagnostic for another company denies', async () => {
    const { deps, store, writes } = buildDeps(mikeSeed());
    const out = await recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ companyId: 'acme-trucking' }),
    );
    expect(out.reason).toBe('not_incident_company');
    assertZeroRecoveryWrites(store, writes);
  });

  it('wrong app/source/result/reason denies', async () => {
    for (const over of [
      { app: 'wbt' }, { source: 'other' }, { result: 'error' }, { reason: 'enforced claim' },
    ]) {
      const seed = mikeSeed();
      seed['wb_diagnostics/mint-1'] = { ...INCIDENT_DIAG, ...over };
      const { deps, store, writes } = buildDeps(seed);
      const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
      expect(out.recoverable).toBe(false);
      assertZeroRecoveryWrites(store, writes);
    }
  });

  it('same period collision across two drivers denies the foreign hash', async () => {
    const seed = mikeSeed();
    seed['wb_diagnostics/mint-other'] = { ...INCIDENT_DIAG, driverHash: OTHER_HASH };
    const { deps, store, writes } = buildDeps(seed, { hashMap: { [OTHER_HASH]: OTHER_DRIVER } });
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.reason).toBe('foreign_diagnostic');
    assertZeroRecoveryWrites(store, writes);
  });
});

describe('fingerprint binds the complete redacted diagnostic evidence set', () => {
  it('changes when diagnostic document id is replaced with a matching-shaped twin', () => {
    const a = computeInspectFingerprint(baseSnap(), sha);
    const b = computeInspectFingerprint(baseSnap({
      diagnosticTuples: [{
        id: 'mint-replaced',
        app: 'wbs',
        area: 'shift',
        event: 'shiftId.minted',
        result: 'ok',
        reason: INCIDENT.diagnostic.reason,
        source: INCIDENT.diagnostic.source,
        shiftId: PERIOD,
        clientTimestamp: '2026-08-21T16:24:21.855Z',
      }],
      diagnosticMatchingCount: 1,
    }), sha);
    expect(a).not.toBe(b);
  });

  it('changes when matching count, clientTimestamp, area, event, or shiftId change', () => {
    const a = computeInspectFingerprint(baseSnap(), sha);
    const extra = computeInspectFingerprint(baseSnap({
      diagnosticMatchingCount: 2,
      diagnosticTuples: [
        ...(baseSnap().diagnosticTuples),
        {
          id: 'mint-2',
          app: 'wbs',
          area: 'shift',
          event: 'shiftId.minted',
          result: 'ok',
          reason: INCIDENT.diagnostic.reason,
          source: INCIDENT.diagnostic.source,
          shiftId: PERIOD,
          clientTimestamp: '2026-08-21T16:24:22.100Z',
        },
      ],
    }), sha);
    const ts = computeInspectFingerprint(baseSnap({
      diagnosticClientTimestamp: '2026-08-21T16:24:22.900Z',
      diagnosticTuples: [{
        ...baseSnap().diagnosticTuples[0],
        clientTimestamp: '2026-08-21T16:24:22.900Z',
      }],
    }), sha);
    const area = computeInspectFingerprint(baseSnap({ diagnosticArea: 'other' }), sha);
    const event = computeInspectFingerprint(baseSnap({ diagnosticEvent: 'other.event' }), sha);
    const shift = computeInspectFingerprint(baseSnap({ diagnosticShiftId: '2026-08-21_000000' }), sha);
    expect(a).not.toBe(extra);
    expect(a).not.toBe(ts);
    expect(a).not.toBe(area);
    expect(a).not.toBe(event);
    expect(a).not.toBe(shift);
  });

  it('changes across driver and company and does not embed raw driver hashes', () => {
    const a = computeInspectFingerprint(baseSnap(), sha);
    const b = computeInspectFingerprint(baseSnap({ driverId: OTHER_DRIVER }), sha);
    const c = computeInspectFingerprint(baseSnap({ companyId: 'x' }), sha);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    const payloadJson = JSON.stringify(baseSnap());
    expect(payloadJson).not.toMatch(/driverHash/);
  });

  it('inspect fingerprints differ after replacing the public diagnostic document', async () => {
    const { deps, store } = buildDeps(mikeSeed());
    const first = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    const original = store['wb_diagnostics/mint-1'];
    delete store['wb_diagnostics/mint-1'];
    store['wb_diagnostics/mint-replaced'] = original;
    const second = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(first.evidence?.diagnosticMatchingCount).toBe(1);
    expect(second.evidence?.diagnosticMatchingCount).toBe(1);
  });
});

describe('writer schema query construction', () => {
  it('dedicated query uses summary.inspectionType and report.shiftId on the equipment project', () => {
    const spec = dedicatedEquipmentPostTripQuerySpec(COMPANY, PERIOD);
    expect(spec.projectId).toBe('wellbuilt-equipment-prod');
    expect(spec.forbiddenProjectId).toBe('wellbuilt-sync');
    expect(spec.namedApp).toBe('dvir');
    expect(spec.collectionPath).toBe(`organizations/${COMPANY}/dvirReports`);
    expect(spec.filters).toEqual([
      { field: 'summary.inspectionType', op: '==', value: 'post_trip' },
      { field: 'report.shiftId', op: '==', value: PERIOD },
    ]);
  });

  it('matches FirebaseDvirTransport / buildCloudDocument documents only', () => {
    const writer = writerShapedPostTrip(PERIOD, COMPANY);
    expect(dedicatedPostTripDocumentMatches(writer, PERIOD)).toBe(true);
    expect(dedicatedPostTripDocumentMatches({
      inspectionType: 'post_trip',
      shiftId: PERIOD,
    }, PERIOD)).toBe(false);
    expect(dedicatedPostTripDocumentMatches({
      summary: { inspectionType: 'post_trip', shiftId: PERIOD },
      report: {},
    }, PERIOD)).toBe(false);
    expect(dedicatedPostTripDocumentMatches({
      summary: { inspectionType: 'post_trip' },
      report: { shiftId: '2026-08-22_000000' },
    }, PERIOD)).toBe(false);
    expect(writer.summary).not.toHaveProperty('shiftId');
  });

  it('production callable source does not query wellbuilt-sync organizations/dvirReports', () => {
    const callables = readFileSync(join(__dirname, '../../../admin/callables.ts'), 'utf8');
    expect(callables).toMatch(/applyMintedDiagnosticsQuery/);
    expect(callables).not.toMatch(/applyDedicatedEquipmentPostTripQuery/);
    expect(callables).not.toMatch(/organizations\/\$\{spec\.companyId\}\/dvirReports/);
    expect(callables).not.toMatch(/sync_post_trip_inspections/);
    expect(callables).not.toMatch(/sync_dvir_reports/);
    const handler = readFileSync(join(__dirname, '../unclaimedShiftRecoveryHandler.ts'), 'utf8');
    expect(handler).not.toMatch(/summary\?\.shiftId/);
    expect(handler).not.toMatch(/sync_dvir_reports/);
    expect(handler).not.toMatch(/sync_post_trip_inspections/);
    expect(handler).toMatch(/no_authoritative_server_completion_store/);
  });
});

describe('refusal paths write nothing', () => {
  it('rejects unauthenticated callers with zero writes', async () => {
    const { deps, store, writes } = buildDeps(mikeSeed());
    await expect(recoverUnclaimedDriverShiftHandler(deps, null, payload()))
      .rejects.toBeInstanceOf(AdminCallError);
    assertZeroRecoveryWrites(store, writes);
  });

  it('last-closed match refuses with zero writes', async () => {
    const seed = mikeSeed();
    seed[shiftAuthorityPath(DRIVER)].lastClosedPeriodId = PERIOD;
    const { deps, store, writes } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.reason).toBe('last_closed_match');
    assertZeroRecoveryWrites(store, writes);
  });

  it('name-index mismatch refuses with zero writes', async () => {
    const seed = mikeSeed();
    seed[nameIndexPath('mikezfold')] = { driverId: OTHER_DRIVER };
    const { deps, store, writes } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.reason).toBe('identity_mismatch');
    assertZeroRecoveryWrites(store, writes);
  });

  it('conflicting origin-day marker refuses with zero writes', async () => {
    const seed = mikeSeed();
    seed[shiftDayPath(DRIVER, ORIGIN)] = { currentShiftId: '2026-08-21_000000' };
    const { deps, store, writes } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.reason).toBe('origin_day_conflict');
    assertZeroRecoveryWrites(store, writes, { originDayMayExist: true });
  });

  it('missing minted diagnostic is insufficient with zero writes', async () => {
    const seed = mikeSeed();
    delete seed['wb_diagnostics/mint-1'];
    const { deps, store, writes } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.reason).toBe('insufficient_evidence');
    assertZeroRecoveryWrites(store, writes);
  });

  it('version race refuses execute with zero writes', async () => {
    const { deps, store, writes } = buildDeps(mikeSeed());
    const inspected = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    store[shiftAuthorityPath(DRIVER)].version = 9;
    const n = writes.length;
    await expect(recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ mode: 'execute', inspectStateFingerprint: inspected.fingerprint }),
    )).rejects.toMatchObject({
      adminCode: expect.stringMatching(/version_mismatch|no_authoritative_server_completion_store/),
    });
    expect(writes.length).toBe(n);
    assertZeroRecoveryWrites(store, writes);
  });

  it('unreadable diagnostics refuse execute with zero writes', async () => {
    const { deps, store, writes } = buildDeps(mikeSeed(), { queryError: 'unreadable' });
    const inspected = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(inspected.reason).toBe('insufficient_evidence');
    await expect(recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ mode: 'execute', inspectStateFingerprint: inspected.fingerprint || '' }),
    )).rejects.toMatchObject({
      adminCode: expect.stringContaining('insufficient_evidence'),
    });
    assertZeroRecoveryWrites(store, writes);
  });

  it('already-recovered execute is idempotent and does not add writes', async () => {
    const seed = mikeSeed();
    seed[shiftAuthorityPath(DRIVER)] = {
      ...seed[shiftAuthorityPath(DRIVER)],
      openPeriodId: PERIOD,
      originLocalDate: ORIGIN,
    };
    seed[shiftDayPath(DRIVER, ORIGIN)] = {
      currentShiftId: PERIOD,
      events: [{ type: 'authority_recovered' }],
    };
    const { deps, store, writes } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ mode: 'execute', inspectStateFingerprint: 'any' }),
    );
    expect(out.alreadyRecovered).toBe(true);
    expect(out.changed).toBe(false);
    expect(writes).toEqual([]);
    expect((store[shiftDayPath(DRIVER, ORIGIN)].events as unknown[]).length).toBe(1);
  });
});

describe('snapshot pins the no-store fact', () => {
  it('snapshotFromEvidence never claims an authoritative server completion store', () => {
    const snap = snapshotFromEvidence({
      request: payload() as never,
      authority: {
        driverId: DRIVER,
        companyId: COMPANY,
        initialized: true,
        openPeriodId: null,
        originLocalDate: null,
        lastClosedPeriodId: LAST_CLOSED,
        version: 5,
      },
      originDay: { readable: true, present: false },
      nameIndexDriverId: DRIVER,
      credentialsActive: true,
      diagnosticBound: 'anonymous',
      diagnosticTuples: baseSnap().diagnosticTuples,
    });
    expect(snap.productionAuthoritativeServerStore).toBe(false);
    expect(snap.completionStoreKind).toBe('none_authoritative_server');
    expect(snap.diagnosticMatchingCount).toBe(1);
    expect(snap.diagnosticTuples[0].id).toBe('mint-1');
    expect(snap.diagnosticArea).toBe('shift');
    expect(snap.diagnosticEvent).toBe('shiftId.minted');
    expect(snap.diagnosticShiftId).toBe(PERIOD);
    expect(snap.diagnosticClientTimestamp).toBe('2026-08-21T16:24:21.855Z');
  });
});

describe('invariants', () => {
  it('does not author login/logout via ordinary claim types', () => {
    expect(SERVER_AUTHORABLE_EVENT_TYPES).toEqual(['login', 'logout', 'depart_return']);
  });
  it('claimDriverShift still uses isPlausibleLocalDate', () => {
    const src = readFileSync(join(__dirname, '..', 'shiftAuthorityCallables.ts'), 'utf8');
    expect(src).toMatch(/isPlausibleLocalDate\(originLocalDate, serverIsoNow\)/);
  });
});
