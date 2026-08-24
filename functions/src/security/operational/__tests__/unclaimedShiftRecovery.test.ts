/**
 * Unclaimed local-period recovery — Mike-shaped initialized-none pointer.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AdminCallError, type AdminDeps, type AdminTransaction } from '../../../admin/adminDeps';
import { ADMIN_AUDIT_COLLECTION } from '../../../admin/adminAudit';
import { ADMIN_POLICY_VERSION, PLATFORM_ADMINS_COLLECTION } from '../../../admin/authority';
import { shiftAuthorityPath, shiftDayPath, SERVER_AUTHORABLE_EVENT_TYPES } from '../shiftAuthority';
import {
  AUTHORITY_RECOVERED_EVENT_TYPE,
  computeInspectFingerprint,
  decideUnclaimedRecovery,
  recoveryAuditDocId,
  snapshotFromEvidence,
  type UnclaimedInspectSnapshot,
  type UnclaimedRecoveryRequest,
} from '../unclaimedShiftRecovery';
import {
  recoverUnclaimedDriverShiftHandler,
  type UnclaimedRecoveryReaders,
} from '../unclaimedShiftRecoveryHandler';

const DRIVER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_DRIVER = '11111111-2222-3333-4444-555555555555';
const COMPANY = 'liquid-gold';
const OTHER_COMPANY = 'other-co';
const PERIOD = '2026-08-21_112421';
const ORIGIN = '2026-08-21';
const LAST_CLOSED = '2026-08-17_004824';
const NOW_MS = Date.parse('2026-08-23T21:00:00-05:00');

const ADMIN_UID = 'admin-uid-1';
const ADMIN_AUTH = {
  uid: ADMIN_UID,
  token: { wellbuiltAdmin: true, email: 'admin@example.com', email_verified: true },
};

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const mintedOk = { found: true, reason: 'legacy path local mint', source: 'AuthContext.startShift' };
const mintedMissing = { found: false, reason: null, source: null };

function readers(over: Partial<UnclaimedRecoveryReaders> = {}): UnclaimedRecoveryReaders {
  return {
    async findMintedDiagnostic() { return mintedOk; },
    async hasPostTripReceipt() { return false; },
    ...over,
  };
}

interface Store { [path: string]: Record<string, unknown> }

function buildDeps(seed: Store): { deps: AdminDeps; store: Store; writes: string[] } {
  const store: Store = JSON.parse(JSON.stringify(seed));
  const writes: string[] = [];
  const snap = (p: string) => ({ exists: p in store, data: store[p] });
  const deps: AdminDeps = {
    async getDoc(p) { return snap(p); },
    async runTransaction(fn) {
      const staged: Array<() => void> = [];
      const tx: AdminTransaction = {
        async get(p) { return snap(p); },
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
    },
    async listDocsById() { return []; },
    newAuditId: () => 'audit-should-not-be-used',
    serverTimestamp: () => '__ts__',
    nowMs: () => NOW_MS,
  };
  return { deps, store, writes };
}

const mikeSeed = (): Store => ({
  [`${PLATFORM_ADMINS_COLLECTION}/${ADMIN_UID}`]: {
    enabled: true, policyVersion: ADMIN_POLICY_VERSION,
  },
  [shiftAuthorityPath(DRIVER)]: {
    driverId: DRIVER,
    companyId: COMPANY,
    initialized: true,
    openPeriodId: null,
    originLocalDate: null,
    lastClosedPeriodId: LAST_CLOSED,
    version: 5,
  },
});

function payload(over: Record<string, unknown> = {}) {
  return {
    driverId: DRIVER,
    companyId: COMPANY,
    periodId: PERIOD,
    expectedAuthorityVersion: 5,
    mode: 'inspect',
    reason: 'recover unclaimed local mint 2026-08-21_112421',
    inspectStateFingerprint: '',
    ...over,
  };
}

describe('Mike-shaped inspect/execute', () => {
  it('inspect is zero-write and recoverable', async () => {
    const { deps, writes } = buildDeps(mikeSeed());
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload(), readers());
    expect(out.mode).toBe('inspect');
    expect(out.changed).toBe(false);
    expect(out.recoverable).toBe(true);
    expect(out.evidence?.authorityState).toBe('none');
    expect(out.evidence?.openPeriodId).toBeNull();
    expect(out.evidence?.lastClosedPeriodId).toBe(LAST_CLOSED);
    expect(out.evidence?.mintedLegacyLocal).toBe(true);
    expect(writes).toEqual([]);
  });

  it('execute atomically sets pointer, origin-day, audit, and recovered event', async () => {
    const { deps, store } = buildDeps(mikeSeed());
    const inspected = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload(), readers());
    const out = await recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ mode: 'execute', inspectStateFingerprint: inspected.fingerprint }), readers(),
    );
    expect(out.changed).toBe(true);
    const auth = store[shiftAuthorityPath(DRIVER)];
    expect(auth.openPeriodId).toBe(PERIOD);
    expect(auth.originLocalDate).toBe(ORIGIN);
    expect(auth.version).toBe(6);
    expect(auth.lastClosedPeriodId).toBe(LAST_CLOSED);
    const day = store[shiftDayPath(DRIVER, ORIGIN)];
    expect(day.currentShiftId).toBe(PERIOD);
    expect(day.date).toBe(ORIGIN);
    const events = day.events as Array<{ type: string; source: string; timestamp: string; shiftId: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(AUTHORITY_RECOVERED_EVENT_TYPE);
    expect(events[0].source).toBe('admin_recover_unclaimed');
    expect(events[0].shiftId).toBe(PERIOD);
    expect(events[0].timestamp).toBe(new Date(NOW_MS).toISOString());
    expect(events[0].type).not.toBe('login');
    expect(events[0].type).not.toBe('logout');
    const auditId = recoveryAuditDocId(PERIOD, sha(DRIVER).slice(0, 12));
    const audit = store[`${ADMIN_AUDIT_COLLECTION}/${auditId}`];
    expect(audit.operation).toBe('driverShift.recoverUnclaimedLocalPeriod');
    expect(JSON.stringify(store)).not.toMatch(/dvir|receipt|authorization_code|sso_authorization/);
  });

  it('duplicate execute is idempotent and does not duplicate the event', async () => {
    const { deps, store } = buildDeps(mikeSeed());
    const inspected = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload(), readers());
    const fp = inspected.fingerprint!;
    await recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ mode: 'execute', inspectStateFingerprint: fp }), readers(),
    );
    const eventsAfterFirst = (store[shiftDayPath(DRIVER, ORIGIN)].events as unknown[]).length;
    const second = await recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ mode: 'execute', inspectStateFingerprint: fp }), readers(),
    );
    expect(second.alreadyRecovered).toBe(true);
    expect(second.changed).toBe(false);
    expect((store[shiftDayPath(DRIVER, ORIGIN)].events as unknown[]).length).toBe(eventsAfterFirst);
    expect(store[shiftAuthorityPath(DRIVER)].version).toBe(6);
  });
});

describe('refusals', () => {
  it('rejects unauthenticated callers with zero writes', async () => {
    const { deps, writes } = buildDeps(mikeSeed());
    await expect(recoverUnclaimedDriverShiftHandler(deps, null, payload(), readers()))
      .rejects.toBeInstanceOf(AdminCallError);
    expect(writes).toEqual([]);
  });

  it('rejects unknown keys', async () => {
    const { deps } = buildDeps(mikeSeed());
    await expect(recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, { ...payload(), extra: true }, readers(),
    )).rejects.toMatchObject({ adminCode: 'unknown_fields:extra' });
  });

  it('authority version race refuses without writes', async () => {
    const { deps, store, writes } = buildDeps(mikeSeed());
    const inspected = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload(), readers());
    store[shiftAuthorityPath(DRIVER)].version = 6;
    const writesBefore = writes.length;
    await expect(recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ mode: 'execute', inspectStateFingerprint: inspected.fingerprint }), readers(),
    )).rejects.toMatchObject({ adminCode: expect.stringContaining('version_mismatch') });
    expect(writes.length).toBe(writesBefore);
    expect(store[shiftAuthorityPath(DRIVER)].openPeriodId).toBeNull();
  });

  it('different open period refuses', async () => {
    const seed = mikeSeed();
    seed[shiftAuthorityPath(DRIVER)].openPeriodId = '2026-08-22_070000';
    seed[shiftAuthorityPath(DRIVER)].originLocalDate = '2026-08-22';
    const { deps } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload(), readers());
    expect(out.recoverable).toBe(false);
    expect(out.reason).toBe('different_open_period');
  });

  it('last-closed match refuses', async () => {
    const seed = mikeSeed();
    seed[shiftAuthorityPath(DRIVER)].lastClosedPeriodId = PERIOD;
    const { deps } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload(), readers());
    expect(out.reason).toBe('last_closed_match');
    expect(out.recoverable).toBe(false);
  });

  it('wrong driver refuses', async () => {
    const seed = mikeSeed();
    seed[shiftAuthorityPath(DRIVER)].driverId = OTHER_DRIVER;
    const { deps } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload(), readers());
    expect(out.reason).toBe('identity_mismatch');
  });

  it('wrong company refuses', async () => {
    const seed = mikeSeed();
    seed[shiftAuthorityPath(DRIVER)].companyId = OTHER_COMPANY;
    const { deps } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload(), readers());
    expect(out.reason).toBe('identity_mismatch');
  });

  it('malformed period refuses', async () => {
    const { deps } = buildDeps(mikeSeed());
    const out = await recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ periodId: 'not-a-period' }), readers(),
    );
    expect(out.reason).toBe('malformed_period');
  });

  it('conflicting origin-day marker refuses', async () => {
    const seed = mikeSeed();
    seed[shiftDayPath(DRIVER, ORIGIN)] = {
      currentShiftId: '2026-08-21_000000', driverId: DRIVER, companyId: COMPANY, date: ORIGIN,
    };
    const { deps } = buildDeps(seed);
    const out = await recoverUnclaimedDriverShiftHandler(deps, ADMIN_AUTH, payload(), readers());
    expect(out.reason).toBe('origin_day_conflict');
  });

  it('existing Post-Trip/receipt refuses', async () => {
    const { deps } = buildDeps(mikeSeed());
    const out = await recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload(), readers({ async hasPostTripReceipt() { return true; } }),
    );
    expect(out.reason).toBe('post_trip_exists');
  });

  it('insufficient recovery evidence (no minted diagnostic) refuses', async () => {
    const { deps } = buildDeps(mikeSeed());
    const out = await recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload(), readers({ async findMintedDiagnostic() { return mintedMissing; } }),
    );
    expect(out.reason).toBe('insufficient_evidence');
    expect(out.changed).toBe(false);
  });

  it('fingerprint mismatch on execute refuses without writes', async () => {
    const { deps, store } = buildDeps(mikeSeed());
    await expect(recoverUnclaimedDriverShiftHandler(
      deps, ADMIN_AUTH, payload({ mode: 'execute', inspectStateFingerprint: 'deadbeef' }), readers(),
    )).rejects.toMatchObject({ adminCode: expect.stringContaining('fingerprint_mismatch') });
    expect(store[shiftAuthorityPath(DRIVER)].openPeriodId).toBeNull();
  });
});

describe('invariants', () => {
  it('does not add authority_recovered to ordinary claim/close authorable types', () => {
    expect(SERVER_AUTHORABLE_EVENT_TYPES).not.toContain(AUTHORITY_RECOVERED_EVENT_TYPE);
    expect(SERVER_AUTHORABLE_EVENT_TYPES).toEqual(['login', 'logout', 'depart_return']);
  });

  it('claimDriverShift still uses isPlausibleLocalDate', () => {
    const src = readFileSync(join(__dirname, '..', 'shiftAuthorityCallables.ts'), 'utf8');
    expect(src).toMatch(/isPlausibleLocalDate\(originLocalDate, serverIsoNow\)/);
    expect(src).toMatch(/claimDriverShift/);
  });

  it('pure snapshot fingerprint is stable for Mike-shaped none', () => {
    const req: UnclaimedRecoveryRequest = {
      driverId: DRIVER, companyId: COMPANY, periodId: PERIOD,
      expectedAuthorityVersion: 5, mode: 'inspect', reason: 'x'.repeat(10),
      inspectStateFingerprint: '',
    };
    const snap: UnclaimedInspectSnapshot = snapshotFromEvidence({
      request: req,
      authority: {
        driverId: DRIVER, companyId: COMPANY, initialized: true,
        openPeriodId: null, originLocalDate: null, lastClosedPeriodId: LAST_CLOSED, version: 5,
      },
      originDay: { readable: true, present: false },
      postTripPresent: false,
      minted: mintedOk,
    });
    const fp = computeInspectFingerprint(snap, sha);
    const d = decideUnclaimedRecovery({ request: req, snapshot: snap, fingerprint: fp });
    expect(d).toEqual({ action: 'inspect', fingerprint: fp, recoverable: true });
  });
});
