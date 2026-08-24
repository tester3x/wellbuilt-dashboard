/**
 * Incident-bound unclaimed recovery — production-shaped query engine.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AdminCallError, type AdminDocSnapshot } from '../../../admin/adminDeps';
import { ADMIN_AUDIT_COLLECTION } from '../../../admin/adminAudit';
import { ADMIN_POLICY_VERSION, PLATFORM_ADMINS_COLLECTION } from '../../../admin/authority';
import { SERVER_AUTHORABLE_EVENT_TYPES, shiftAuthorityPath, shiftDayPath } from '../shiftAuthority';
import {
  AUTHORITY_RECOVERED_EVENT_TYPE,
  INCIDENT,
  computeInspectFingerprint,
  credentialsPath,
  nameIndexPath,
  recoveryAuditDocId,
  type RecoveryQueryResult,
  type RecoveryQuerySpec,
} from '../unclaimedShiftRecovery';
import {
  recoverUnclaimedDriverShiftHandler,
  type RecoveryTx,
  type UnclaimedRecoveryDeps,
} from '../unclaimedShiftRecoveryHandler';

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

function fieldGet(data: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = data;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function applySpec(store: Store, spec: RecoveryQuerySpec): RecoveryQueryResult {
  const docs: Array<{ id: string; data: Record<string, unknown> }> = [];
  if (spec.kind === 'minted_diagnostics') {
    for (const [path, data] of Object.entries(store)) {
      if (!path.startsWith('wb_diagnostics/')) continue;
      if (data.shiftId === spec.periodId && data.event === 'shiftId.minted') {
        docs.push({ id: path.slice('wb_diagnostics/'.length), data });
      }
    }
  } else if (spec.kind === 'sync_post_trip_inspections') {
    const prefix = `companies/${spec.companyId}/dvir_inspections/`;
    for (const [path, data] of Object.entries(store)) {
      if (!path.startsWith(prefix)) continue;
      if (data.inspectionType === 'post_trip' && data.shiftId === spec.periodId) {
        docs.push({ id: path.slice(prefix.length), data });
      }
    }
  } else {
    const prefix = `organizations/${spec.companyId}/dvirReports/`;
    for (const [path, data] of Object.entries(store)) {
      if (!path.startsWith(prefix)) continue;
      const type = data.inspectionType ?? fieldGet(data, 'summary.inspectionType');
      const shift = data.shiftId ?? fieldGet(data, 'summary.shiftId');
      if (type === 'post_trip' && shift === spec.periodId) {
        docs.push({ id: path.slice(prefix.length), data });
      }
    }
  }
  return { readable: true, docs, matchingCount: docs.length };
}

function buildDeps(seed: Store, opts: {
  hashMap?: Record<string, string | null>;
  queryError?: RecoveryQueryResult['error'];
  abortOnceWithPostTrip?: string;
} = {}): { deps: UnclaimedRecoveryDeps; store: Store; writes: string[]; attempts: { n: number } } {
  const store: Store = JSON.parse(JSON.stringify(seed));
  const writes: string[] = [];
  const attempts = { n: 0 };
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
      async getQuery(spec) {
        if (opts.abortOnceWithPostTrip && attempts.n === 1 && spec.kind === 'sync_post_trip_inspections') {
          store[opts.abortOnceWithPostTrip] = {
            inspectionType: 'post_trip', shiftId: PERIOD,
          };
          const err = new Error('aborted');
          (err as { code?: string }).code = 'aborted';
          throw err;
        }
        return qrun(spec);
      },
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
      for (let i = 0; i < 5; i++) {
        attempts.n += 1;
        try {
          return await runOnce(fn);
        } catch (e) {
          if ((e as { code?: string }).code === 'aborted') continue;
          throw e;
        }
      }
      throw new Error('retry_exhausted');
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
  return { deps, store, writes, attempts };
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

describe('production-shaped queries — Mike incident', () => {
  it('valid exact Mike-shaped diagnostic permits inspect with zero writes', async () => {
    const { deps, writes } = buildDeps(mikeSeed());
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.recoverable).toBe(true);
    expect(out.changed).toBe(false);
    expect(writes).toEqual([]);
    expect(out.evidence?.diagnosticBound).toBe('anonymous');
    expect(out.evidence?.nameIndexMatch).toBe(true);
  });

  it('anonymous diagnostic that is not the reviewed shape denies', async () => {
    const seed = mikeSeed();
    seed['wb_diagnostics/mint-1'] = { ...INCIDENT_DIAG, source: 'spoof', reason: 'legacy path local mint' };
    const { deps, writes } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.recoverable).toBe(false);
    expect(out.reason).toBe('diagnostic_mismatch');
    expect(writes).toEqual([]);
  });

  it('diagnostic for another driver denies', async () => {
    const seed = mikeSeed();
    seed['wb_diagnostics/mint-1'] = { ...INCIDENT_DIAG, driverHash: OTHER_HASH };
    const { deps } = buildDeps(seed, { hashMap: { [OTHER_HASH]: OTHER_DRIVER } });
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.reason).toBe('foreign_diagnostic');
  });

  it('diagnostic for another company denies', async () => {
    const { deps } = buildDeps(mikeSeed());
    const out = await recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ companyId: 'acme-trucking' }),
    );
    expect(out.reason).toBe('not_incident_company');
  });

  it('wrong app/source/result/reason denies', async () => {
    for (const over of [
      { app: 'wbt' }, { source: 'other' }, { result: 'error' }, { reason: 'enforced claim' },
    ]) {
      const seed = mikeSeed();
      seed['wb_diagnostics/mint-1'] = { ...INCIDENT_DIAG, ...over };
      const { deps } = buildDeps(seed);
      const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
      expect(out.recoverable).toBe(false);
    }
  });

  it('same period collision across two drivers denies the foreign hash', async () => {
    const seed = mikeSeed();
    seed['wb_diagnostics/mint-other'] = { ...INCIDENT_DIAG, driverHash: OTHER_HASH };
    const { deps } = buildDeps(seed, { hashMap: { [OTHER_HASH]: OTHER_DRIVER } });
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.reason).toBe('foreign_diagnostic');
  });
});

describe('fingerprint binding', () => {
  it('cross-driver fingerprint replay denies without writes', async () => {
    const { deps, store, writes } = buildDeps(mikeSeed());
    const inspected = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    store[nameIndexPath('mikezfold')] = { driverId: OTHER_DRIVER };
    store[credentialsPath(OTHER_DRIVER)] = { active: true };
    store[shiftAuthorityPath(OTHER_DRIVER)] = { ...store[shiftAuthorityPath(DRIVER)], driverId: OTHER_DRIVER };
    const writesBefore = writes.length;
    await expect(recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({
        mode: 'execute',
        driverId: OTHER_DRIVER,
        inspectStateFingerprint: inspected.fingerprint,
      }),
    )).rejects.toMatchObject({ adminCode: expect.stringMatching(/fingerprint_mismatch|identity_mismatch/) });
    expect(writes.length).toBe(writesBefore);
  });

  it('cross-company fingerprint replay denies', async () => {
    const { deps } = buildDeps(mikeSeed());
    const inspected = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    await expect(recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({
        mode: 'execute',
        companyId: 'other-co',
        inspectStateFingerprint: inspected.fingerprint,
      }),
    )).rejects.toBeInstanceOf(AdminCallError);
  });

  it('cross-period fingerprint replay denies', async () => {
    const { deps } = buildDeps(mikeSeed());
    const inspected = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    await expect(recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({
        mode: 'execute',
        periodId: '2026-08-22_070000',
        inspectStateFingerprint: inspected.fingerprint,
      }),
    )).rejects.toBeInstanceOf(AdminCallError);
  });

  it('fingerprint includes driver, company, diagnostic, and completion fields', () => {
    const snap = {
      driverId: DRIVER, companyId: COMPANY, periodId: PERIOD, originLocalDate: ORIGIN,
      expectedAuthorityVersion: 5, initialized: true, authorityState: 'none' as const,
      openPeriodId: null, authorityOriginLocalDate: null, lastClosedPeriodId: LAST_CLOSED,
      authorityVersion: 5, originDayPresent: false, originDayCurrentShiftId: null,
      originDayReadable: true, identityMatch: true, nameIndexMatch: true, credentialsActive: true,
      diagnosticBound: 'anonymous' as const, diagnosticSource: INCIDENT.diagnostic.source,
      diagnosticResult: 'ok', diagnosticReason: INCIDENT.diagnostic.reason, diagnosticApp: 'wbs',
      inspectionsPostTripMatching: 0, reportsPostTripMatching: 0, completionReadable: true,
    };
    const a = computeInspectFingerprint(snap, sha);
    const b = computeInspectFingerprint({ ...snap, driverId: OTHER_DRIVER }, sha);
    const c = computeInspectFingerprint({ ...snap, companyId: 'x' }, sha);
    const d = computeInspectFingerprint({ ...snap, diagnosticSource: 'nope' }, sha);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});

describe('completion stores', () => {
  it('target Post-Trip beyond 50 other records still denies', async () => {
    const seed = mikeSeed();
    for (let i = 0; i < 60; i++) {
      seed[`companies/${COMPANY}/dvir_inspections/other-${i}`] = {
        inspectionType: 'post_trip', shiftId: `2026-01-01_${String(i).padStart(6, '0')}`,
      };
    }
    seed[`companies/${COMPANY}/dvir_inspections/target`] = {
      inspectionType: 'post_trip', shiftId: PERIOD,
    };
    const { deps } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.reason).toBe('post_trip_exists');
    expect(out.evidence?.postTripInspectionsMatching).toBe(1);
  });

  it('receipt present in dvirReports store denies', async () => {
    const seed = mikeSeed();
    seed[`organizations/${COMPANY}/dvirReports/r1`] = {
      inspectionType: 'post_trip', shiftId: PERIOD, summary: { inspectionType: 'post_trip', shiftId: PERIOD },
    };
    const { deps } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.reason).toBe('post_trip_exists');
  });

  it('query denial / missing index / unreadable store denies', async () => {
    for (const error of ['denied', 'missing_index', 'unreadable'] as const) {
      const { deps } = buildDeps(mikeSeed(), { queryError: error });
      const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
      expect(['completion_unreadable', 'insufficient_evidence', 'diagnostic_mismatch']).toContain(out.reason);
    }
  });

  it('Post-Trip appearing between inspect and execute denies with zero recovery writes', async () => {
    const { deps, store, writes } = buildDeps(mikeSeed());
    const inspected = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    store[`companies/${COMPANY}/dvir_inspections/late`] = { inspectionType: 'post_trip', shiftId: PERIOD };
    const writesBefore = writes.length;
    await expect(recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ mode: 'execute', inspectStateFingerprint: inspected.fingerprint }),
    )).rejects.toMatchObject({ adminCode: expect.stringContaining('post_trip_exists') });
    expect(writes.length).toBe(writesBefore);
    expect(store[shiftAuthorityPath(DRIVER)].openPeriodId).toBeNull();
  });

  it('transaction retry rechecks all evidence and denies a late Post-Trip', async () => {
    const path = `companies/${COMPANY}/dvir_inspections/racy`;
    const { deps, store } = buildDeps(mikeSeed(), { abortOnceWithPostTrip: path });
    const inspected = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    await expect(recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ mode: 'execute', inspectStateFingerprint: inspected.fingerprint }),
    )).rejects.toMatchObject({ adminCode: expect.stringContaining('post_trip_exists') });
    expect(store[shiftAuthorityPath(DRIVER)].openPeriodId).toBeNull();
  });
});

describe('execute writes and idempotency', () => {
  it('successful execute writes exactly pointer, origin-day, event, audit', async () => {
    const { deps, store, writes } = buildDeps(mikeSeed());
    const inspected = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    const out = await recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ mode: 'execute', inspectStateFingerprint: inspected.fingerprint }),
    );
    expect(out.changed).toBe(true);
    expect(writes.filter((w) => w.startsWith('update '))).toHaveLength(1);
    expect(writes.filter((w) => w.startsWith('create '))).toHaveLength(2);
    expect(store[shiftAuthorityPath(DRIVER)].openPeriodId).toBe(PERIOD);
    const events = store[shiftDayPath(DRIVER, ORIGIN)].events as Array<{ type: string }>;
    expect(events).toEqual([expect.objectContaining({ type: AUTHORITY_RECOVERED_EVENT_TYPE })]);
    expect(events[0].type).not.toBe('login');
    const audit = store[`${ADMIN_AUDIT_COLLECTION}/${recoveryAuditDocId(PERIOD, sha(DRIVER).slice(0, 12))}`];
    expect(audit.operation).toBe('driverShift.recoverUnclaimedLocalPeriod');
  });

  it('duplicate exact execution remains idempotent', async () => {
    const { deps, store } = buildDeps(mikeSeed());
    const inspected = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    const fp = inspected.fingerprint!;
    await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload({ mode: 'execute', inspectStateFingerprint: fp }));
    const n = (store[shiftDayPath(DRIVER, ORIGIN)].events as unknown[]).length;
    const second = await recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ mode: 'execute', inspectStateFingerprint: fp }),
    );
    expect(second.alreadyRecovered).toBe(true);
    expect((store[shiftDayPath(DRIVER, ORIGIN)].events as unknown[]).length).toBe(n);
  });
});

describe('classic refusals still hold', () => {
  it('rejects unauthenticated callers with zero writes', async () => {
    const { deps, writes } = buildDeps(mikeSeed());
    await expect(recoverUnclaimedDriverShiftHandler(deps, null, payload()))
      .rejects.toBeInstanceOf(AdminCallError);
    expect(writes).toEqual([]);
  });
  it('last-closed match refuses', async () => {
    const seed = mikeSeed();
    seed[shiftAuthorityPath(DRIVER)].lastClosedPeriodId = PERIOD;
    const { deps } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.reason).toBe('last_closed_match');
  });
  it('name-index mismatch refuses', async () => {
    const seed = mikeSeed();
    seed[nameIndexPath('mikezfold')] = { driverId: OTHER_DRIVER };
    const { deps } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.reason).toBe('identity_mismatch');
  });
  it('conflicting origin-day marker refuses', async () => {
    const seed = mikeSeed();
    seed[shiftDayPath(DRIVER, ORIGIN)] = { currentShiftId: '2026-08-21_000000' };
    const { deps } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.reason).toBe('origin_day_conflict');
  });
  it('missing minted diagnostic is insufficient', async () => {
    const seed = mikeSeed();
    delete seed['wb_diagnostics/mint-1'];
    const { deps } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    expect(out.reason).toBe('insufficient_evidence');
  });
  it('version race refuses without writes', async () => {
    const { deps, store, writes } = buildDeps(mikeSeed());
    const inspected = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload());
    store[shiftAuthorityPath(DRIVER)].version = 9;
    const n = writes.length;
    await expect(recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ mode: 'execute', inspectStateFingerprint: inspected.fingerprint }),
    )).rejects.toMatchObject({ adminCode: expect.stringContaining('version_mismatch') });
    expect(writes.length).toBe(n);
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
