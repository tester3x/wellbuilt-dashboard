/**
 * Targeted retro-close migration + driver/company authority hardening.
 *
 * Two properties are worth the test weight here:
 *
 *  1. The migration REFUSES on anything but the exact reviewed evidence. A
 *     migration that "helpfully" proceeds when the world moved would close a
 *     shift a driver is currently working — strictly worse than the stale
 *     marker it repairs.
 *  2. The driver callables derive driver AND company from canonical records,
 *     never from the token claim, so a stale or forged claim cannot reach
 *     another tenant's authority record.
 *
 * The migration handler runs against an in-memory AdminDeps that models
 * Firestore's real constraints — update fails on a missing document, create
 * fails on an existing one — so "writes only what it says" is demonstrated
 * rather than asserted.
 */
import { AdminCallError, type AdminDeps, type AdminTransaction } from '../../admin/adminDeps';
import { ADMIN_AUDIT_COLLECTION } from '../../admin/adminAudit';
import { ADMIN_POLICY_VERSION, PLATFORM_ADMINS_COLLECTION } from '../../admin/authority';
import { decideRetroClose, describeRetroClose } from '../operational/shiftAuthorityMigration';
import {
  retroCloseDryRunHandler,
  retroCloseExecuteHandler,
} from '../operational/shiftAuthorityMigrationHandler';
import { resolveSubject } from '../operational/shiftAuthorityCallables';
import {
  decideClaim,
  decideClose,
  decideResolve,
  shiftAuthorityPath,
  shiftDayPath,
  type ShiftAuthorityRecord,
} from '../operational/shiftAuthority';
import type { CanonicalDriverRecordReaders } from '../canonicalDriverAuthority';

const DRIVER = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
const OTHER_DRIVER = '11111111-2222-3333-4444-555555555555';
const COMPANY = 'liquid-gold';
const OTHER_COMPANY = 'some-other-co';
const PERIOD = '2026-08-08_211725';
const ORIGIN = '2026-08-08';
const CLOSE_DAY = '2026-08-09';

const REQUEST = {
  driverId: DRIVER,
  companyId: COMPANY,
  periodId: PERIOD,
  originLocalDate: ORIGIN,
  closeLocalDate: CLOSE_DAY,
};

/** The live shape: origin day still names the period, close day carries the
 *  authoritative logout and is itself closed. */
const staleOriginDay = () => ({ readable: true, present: true, currentShiftId: PERIOD, eventTypes: ['login'] });
const authoritativeCloseDay = () => ({
  readable: true, present: true, currentShiftId: '',
  eventTypes: ['depart_return', 'logout'],
});

// ── decision core ─────────────────────────────────────────────────────────

describe('decideRetroClose — the live 2026-08-08_211725 shape', () => {
  it('migrates: clears only the origin marker and initializes as closed', () => {
    const d = decideRetroClose({
      request: REQUEST,
      originDay: staleOriginDay(),
      closeDay: authoritativeCloseDay(),
      authority: null,
    });
    expect(d.action).toBe('migrate');
    if (d.action !== 'migrate') return;
    expect(d.clearOriginMarkerAt).toBe(ORIGIN);
    expect(d.initializeAuthority).toEqual({
      initialized: true,
      openPeriodId: null,
      originLocalDate: null,
      lastClosedPeriodId: PERIOD,
    });
  });

  it('records the period as CLOSED, not as a new open shift', () => {
    const d = decideRetroClose({
      request: REQUEST, originDay: staleOriginDay(), closeDay: authoritativeCloseDay(), authority: null,
    });
    if (d.action !== 'migrate') throw new Error('expected migrate');
    // The whole decision: this shift ended. openPeriodId must be null.
    expect(d.initializeAuthority.openPeriodId).toBeNull();
    expect(d.initializeAuthority.lastClosedPeriodId).toBe(PERIOD);
  });
});

describe('decideRetroClose — refusals', () => {
  const refuse = (over: Partial<Parameters<typeof decideRetroClose>[0]>) =>
    decideRetroClose({
      request: REQUEST, originDay: staleOriginDay(), closeDay: authoritativeCloseDay(),
      authority: null, ...over,
    });

  it('refuses when the origin marker now names a DIFFERENT period', () => {
    const d = refuse({ originDay: { ...staleOriginDay(), currentShiftId: '2026-08-20_080000' } });
    expect(d).toEqual({ action: 'refuse', reason: 'origin_marker_mismatch' });
  });

  it('refuses when the origin day document is absent', () => {
    const d = refuse({ originDay: { readable: true, present: false, eventTypes: [] } });
    expect(d).toEqual({ action: 'refuse', reason: 'origin_absent' });
  });

  it('refuses when a document could not be read — absence of evidence is not evidence', () => {
    expect(refuse({ originDay: { readable: false, present: false, eventTypes: [] } }))
      .toEqual({ action: 'refuse', reason: 'origin_unreadable' });
    expect(refuse({ closeDay: { readable: false, present: false, eventTypes: [] } }))
      .toEqual({ action: 'refuse', reason: 'close_day_unreadable' });
  });

  it('refuses when the close day carries no logout — it never invents one', () => {
    const d = refuse({
      closeDay: { readable: true, present: true, currentShiftId: '', eventTypes: ['depart_return'] },
    });
    expect(d).toEqual({ action: 'refuse', reason: 'close_evidence_missing' });
  });

  it('refuses when the close day is itself still open', () => {
    const d = refuse({
      closeDay: { ...authoritativeCloseDay(), currentShiftId: '2026-08-09_060000' },
    });
    expect(d).toEqual({ action: 'refuse', reason: 'close_day_still_open' });
  });

  it('refuses when the authority already reports an OPEN period', () => {
    const open: ShiftAuthorityRecord = {
      driverId: DRIVER, companyId: COMPANY, initialized: true,
      openPeriodId: '2026-08-20_080000', originLocalDate: '2026-08-20', version: 4,
    };
    expect(refuse({ authority: open })).toEqual({ action: 'refuse', reason: 'authority_already_open' });
  });

  it('refuses a period id whose day disagrees with the stated origin date', () => {
    const d = decideRetroClose({
      request: { ...REQUEST, originLocalDate: '2026-08-07' },
      originDay: staleOriginDay(), closeDay: authoritativeCloseDay(), authority: null,
    });
    expect(d).toEqual({ action: 'refuse', reason: 'period_date_mismatch' });
  });

  it('refuses malformed input', () => {
    expect(decideRetroClose({
      request: { ...REQUEST, periodId: 'not-a-period' },
      originDay: staleOriginDay(), closeDay: authoritativeCloseDay(), authority: null,
    })).toEqual({ action: 'refuse', reason: 'invalid_request' });
  });
});

describe('decideRetroClose — idempotency', () => {
  it('is a no-op once the origin marker is already clear', () => {
    const d = decideRetroClose({
      request: REQUEST,
      originDay: { readable: true, present: true, currentShiftId: '', eventTypes: ['login'] },
      closeDay: authoritativeCloseDay(), authority: null,
    });
    expect(d).toEqual({ action: 'already_migrated', reason: 'origin_marker_clear' });
  });

  it('is a no-op once the authority is initialized and closed', () => {
    const done: ShiftAuthorityRecord = {
      driverId: DRIVER, companyId: COMPANY, initialized: true,
      openPeriodId: null, originLocalDate: null, lastClosedPeriodId: PERIOD, version: 2,
    };
    const d = decideRetroClose({
      request: REQUEST, originDay: staleOriginDay(), closeDay: authoritativeCloseDay(), authority: done,
    });
    expect(d).toEqual({ action: 'already_migrated', reason: 'authority_initialized' });
  });
});

describe('describeRetroClose — nonsecret projection', () => {
  it('names the two intended writes and nothing else', () => {
    const d = decideRetroClose({
      request: REQUEST, originDay: staleOriginDay(), closeDay: authoritativeCloseDay(), authority: null,
    });
    const out = describeRetroClose(d);
    expect(out.classification).toBe('migrate:stale_origin_marker');
    expect(out.willWrite).toHaveLength(2);
    const text = out.willWrite.join('\n');
    // No events, no timestamps, no driver identity in the projection.
    expect(text).not.toContain(DRIVER);
    expect(text).not.toMatch(/logout|login|depart_return/);
  });

  it('promises no writes for refusals and no-ops', () => {
    expect(describeRetroClose({ action: 'refuse', reason: 'origin_absent' }).willWrite).toEqual([]);
    expect(describeRetroClose({ action: 'already_migrated', reason: 'origin_marker_clear' }).willWrite)
      .toEqual([]);
  });
});

// ── handler against a Firestore-modelling AdminDeps ───────────────────────

const ADMIN_UID = 'admin-uid-1';
const ADMIN_AUTH = {
  uid: ADMIN_UID,
  token: { wellbuiltAdmin: true, email: 'admin@example.com', email_verified: true },
};

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
            // Firestore's real rule: update on a missing document fails.
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
    newAuditId: () => 'audit-1',
    serverTimestamp: () => '__ts__',
    nowMs: () => 0,
  };
  return { deps, store, writes };
}

const liveSeed = (): Store => ({
  // The real record shape — authorizeAdminCall requires both fields and the
  // exact policy version, so seeding a shortcut would have tested nothing.
  [`${PLATFORM_ADMINS_COLLECTION}/${ADMIN_UID}`]: {
    enabled: true, policyVersion: ADMIN_POLICY_VERSION,
  },
  [shiftDayPath(DRIVER, ORIGIN)]: {
    driverId: DRIVER, companyId: COMPANY, date: ORIGIN, currentShiftId: PERIOD,
    events: [{ type: 'login', timestamp: '2026-08-08T21:17:25.000Z' }],
  },
  [shiftDayPath(DRIVER, CLOSE_DAY)]: {
    driverId: DRIVER, companyId: COMPANY, date: CLOSE_DAY, currentShiftId: '',
    events: [
      { type: 'depart_return', timestamp: '2026-08-09T19:40:00.000Z' },
      { type: 'logout', timestamp: '2026-08-09T20:02:11.000Z' },
    ],
  },
});

describe('retroClose handler — admin authorization', () => {
  it('rejects an unauthenticated caller', async () => {
    const { deps } = buildDeps(liveSeed());
    await expect(retroCloseExecuteHandler(deps, null, REQUEST)).rejects.toBeInstanceOf(AdminCallError);
  });

  it('rejects a caller with the claim but no enabled platform_admins record', async () => {
    const seed = liveSeed();
    delete seed[`${PLATFORM_ADMINS_COLLECTION}/${ADMIN_UID}`];
    const { deps, writes } = buildDeps(seed);
    await expect(retroCloseExecuteHandler(deps, ADMIN_AUTH, REQUEST)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(writes).toEqual([]);
  });

  it('rejects a caller with a record but no admin claim', async () => {
    const { deps, writes } = buildDeps(liveSeed());
    await expect(retroCloseExecuteHandler(
      deps, { uid: ADMIN_UID, token: { email: 'admin@example.com', email_verified: true } }, REQUEST,
    )).rejects.toMatchObject({ code: 'permission-denied' });
    expect(writes).toEqual([]);
  });
});

describe('retroClose handler — dry run', () => {
  it('classifies without writing anything', async () => {
    const { deps, store, writes } = buildDeps(liveSeed());
    const before = JSON.stringify(store);
    const out = await retroCloseDryRunHandler(deps, ADMIN_AUTH, REQUEST);
    expect(out).toMatchObject({ dryRun: true, classification: 'migrate:stale_origin_marker', changed: false });
    expect(out.willWrite).toHaveLength(2);
    expect(writes).toEqual([]);
    expect(JSON.stringify(store)).toBe(before);
  });

  it('reports the refusal it would hit, still without writing', async () => {
    const seed = liveSeed();
    seed[shiftDayPath(DRIVER, ORIGIN)].currentShiftId = '2026-08-20_080000';
    const { deps, writes } = buildDeps(seed);
    const out = await retroCloseDryRunHandler(deps, ADMIN_AUTH, REQUEST);
    expect(out.classification).toBe('refuse:origin_marker_mismatch');
    expect(writes).toEqual([]);
  });
});

describe('retroClose handler — execute', () => {
  it('clears the origin marker, preserves every historical event and field', async () => {
    const { deps, store } = buildDeps(liveSeed());
    const originBefore = { ...store[shiftDayPath(DRIVER, ORIGIN)] };
    const closeBefore = JSON.stringify(store[shiftDayPath(DRIVER, CLOSE_DAY)]);

    const out = await retroCloseExecuteHandler(deps, ADMIN_AUTH, REQUEST);
    expect(out).toMatchObject({ dryRun: false, changed: true });

    const originAfter = store[shiftDayPath(DRIVER, ORIGIN)];
    expect(originAfter.currentShiftId).toBe('');
    // Events untouched — no synthetic logout appended to the origin day.
    expect(originAfter.events).toEqual(originBefore.events);
    expect(originAfter.driverId).toBe(DRIVER);
    expect(originAfter.date).toBe(ORIGIN);
    // The close day is evidence, not a target: byte-identical afterwards.
    expect(JSON.stringify(store[shiftDayPath(DRIVER, CLOSE_DAY)])).toBe(closeBefore);
  });

  it('initializes the authority as closed, remembering the period', async () => {
    const { deps, store } = buildDeps(liveSeed());
    await retroCloseExecuteHandler(deps, ADMIN_AUTH, REQUEST);
    expect(store[shiftAuthorityPath(DRIVER)]).toMatchObject({
      driverId: DRIVER, companyId: COMPANY, initialized: true,
      openPeriodId: null, originLocalDate: null, lastClosedPeriodId: PERIOD, version: 1,
    });
  });

  it('writes exactly three documents: origin day, authority, audit', async () => {
    const { deps, writes } = buildDeps(liveSeed());
    await retroCloseExecuteHandler(deps, ADMIN_AUTH, REQUEST);
    expect(writes.sort()).toEqual([
      `create ${ADMIN_AUDIT_COLLECTION}/audit-1`,
      `create ${shiftAuthorityPath(DRIVER)}`,
      `update ${shiftDayPath(DRIVER, ORIGIN)}`,
    ].sort());
  });

  it('records a nonsecret audit naming the verified actor', async () => {
    const { deps, store } = buildDeps(liveSeed());
    await retroCloseExecuteHandler(deps, ADMIN_AUTH, REQUEST);
    const audit = store[`${ADMIN_AUDIT_COLLECTION}/audit-1`];
    expect(audit).toMatchObject({
      operation: 'driverShift.retroCloseStaleOriginMarker',
      targetType: 'driver_shift',
      targetId: DRIVER,
      actorUid: ADMIN_UID,
      reason: `retro_close:${PERIOD}`,
    });
    // No credential-shaped material anywhere in the record.
    expect(JSON.stringify(audit)).not.toMatch(/passcode|token|hash|secret/i);
  });

  it('is idempotent — a second execute changes nothing further', async () => {
    const { deps, store, writes } = buildDeps(liveSeed());
    await retroCloseExecuteHandler(deps, ADMIN_AUTH, REQUEST);
    const afterFirst = JSON.stringify(store);
    const writeCount = writes.length;

    const second = await retroCloseExecuteHandler(deps, ADMIN_AUTH, REQUEST);
    expect(second.changed).toBe(false);
    expect(second.classification).toMatch(/^already_migrated:/);
    expect(JSON.stringify(store)).toBe(afterFirst);
    expect(writes).toHaveLength(writeCount);
  });

  it('refuses and writes nothing when the evidence changed since review', async () => {
    const seed = liveSeed();
    // A new shift was started on the origin day since the dry run.
    seed[shiftDayPath(DRIVER, ORIGIN)].currentShiftId = '2026-08-08_235959';
    const { deps, store, writes } = buildDeps(seed);
    const before = JSON.stringify(store);
    await expect(retroCloseExecuteHandler(deps, ADMIN_AUTH, REQUEST)).rejects.toMatchObject({
      code: 'failed-precondition',
      adminCode: 'retro_close_refused:origin_marker_mismatch',
    });
    expect(writes).toEqual([]);
    expect(JSON.stringify(store)).toBe(before);
  });

  it('refuses to touch a driver whose authority reports an open period', async () => {
    const seed = liveSeed();
    seed[shiftAuthorityPath(DRIVER)] = {
      driverId: DRIVER, companyId: COMPANY, initialized: true,
      openPeriodId: '2026-08-20_080000', originLocalDate: '2026-08-20', version: 6,
    };
    const { deps, writes } = buildDeps(seed);
    await expect(retroCloseExecuteHandler(deps, ADMIN_AUTH, REQUEST)).rejects.toMatchObject({
      adminCode: 'retro_close_refused:authority_already_open',
    });
    expect(writes).toEqual([]);
  });

  it('is targeted — it never reads or writes another driver', async () => {
    const seed = liveSeed();
    seed[shiftDayPath(OTHER_DRIVER, ORIGIN)] = { currentShiftId: '2026-08-08_100000', events: [] };
    const { deps, store } = buildDeps(seed);
    await retroCloseExecuteHandler(deps, ADMIN_AUTH, REQUEST);
    // The other driver's stale-looking marker is untouched: no scan exists.
    expect(store[shiftDayPath(OTHER_DRIVER, ORIGIN)].currentShiftId).toBe('2026-08-08_100000');
  });

  it('rejects unknown payload fields rather than ignoring them', async () => {
    const { deps } = buildDeps(liveSeed());
    await expect(retroCloseExecuteHandler(
      deps, ADMIN_AUTH, { ...REQUEST, force: true },
    )).rejects.toMatchObject({ adminCode: 'unknown_fields:force' });
  });
});

// ── driver/company authority hardening ────────────────────────────────────

const readers = (over: Partial<{
  credExists: boolean; credActive: boolean;
  profileExists: boolean; profileActive: boolean; profileCompany: string | null;
}> = {}): CanonicalDriverRecordReaders => {
  const o = {
    credExists: true, credActive: true,
    profileExists: true, profileActive: true, profileCompany: COMPANY as string | null,
    ...over,
  };
  return {
    async getCredentials() { return { exists: o.credExists, active: o.credActive }; },
    async getProfile() {
      return { exists: o.profileExists, active: o.profileActive, companyId: o.profileCompany };
    },
  };
};

const driverRequest = (token: Record<string, unknown>) =>
  ({ auth: { uid: 'auth-uid', token } } as never);

describe('resolveSubject — canonical authority, not the claim', () => {
  it('returns the driver and company from authoritative records', async () => {
    const who = await resolveSubject(
      driverRequest({ kind: 'driver', driverId: DRIVER }), readers(),
    );
    expect(who).toEqual({ driverId: DRIVER, companyId: COMPANY });
  });

  it('rejects an inactive driver — deactivated credentials end shift authority', async () => {
    await expect(resolveSubject(
      driverRequest({ kind: 'driver', driverId: DRIVER }), readers({ credActive: false }),
    )).rejects.toMatchObject({ message: 'driver_inactive' });
  });

  it('rejects a deactivated profile just as firmly', async () => {
    await expect(resolveSubject(
      driverRequest({ kind: 'driver', driverId: DRIVER }), readers({ profileActive: false }),
    )).rejects.toMatchObject({ message: 'driver_inactive' });
  });

  it('rejects a driver with no canonical record at all', async () => {
    await expect(resolveSubject(
      driverRequest({ kind: 'driver', driverId: DRIVER }), readers({ profileExists: false }),
    )).rejects.toMatchObject({ message: 'driver_not_authoritative' });
  });

  it('IGNORES a companyId claim — the profile company wins', async () => {
    const who = await resolveSubject(
      // A stale or forged company claim rides along in the token...
      driverRequest({ kind: 'driver', driverId: DRIVER, companyId: OTHER_COMPANY }),
      readers({ profileCompany: COMPANY }),
    );
    // ...and is discarded. Cross-tenant access is not checked, it is unreachable.
    expect(who.companyId).toBe(COMPANY);
    expect(who.companyId).not.toBe(OTHER_COMPANY);
  });

  it('fails CLOSED when the driver moved company after the record was written', async () => {
    // The comment in resolveSubject claims a moved driver cannot act on the
    // authority record written under the old company. Prove it end to end:
    // the reconciled company is the new one...
    const who = await resolveSubject(
      driverRequest({ kind: 'driver', driverId: DRIVER }),
      readers({ profileCompany: OTHER_COMPANY }),
    );
    expect(who.companyId).toBe(OTHER_COMPANY);
    // ...and the old-company record is then not evidence about this subject,
    // so every mutation refuses rather than crossing the tenant boundary.
    const oldCompanyRecord: ShiftAuthorityRecord = {
      driverId: DRIVER, companyId: COMPANY, initialized: true,
      openPeriodId: PERIOD, originLocalDate: ORIGIN, version: 3,
    };
    expect(decideResolve(oldCompanyRecord, who))
      .toEqual({ state: 'unverifiable', reason: 'driver_mismatch' });
    expect(decideClaim(oldCompanyRecord, { periodId: PERIOD, originLocalDate: ORIGIN }, who))
      .toEqual({ action: 'refuse', reason: 'driver_mismatch' });
    expect(decideClose(oldCompanyRecord, PERIOD, who))
      .toEqual({ action: 'refuse', reason: 'driver_mismatch' });
  });

  it('another driver\'s authority record is never evidence about this driver', () => {
    const foreign: ShiftAuthorityRecord = {
      driverId: OTHER_DRIVER, companyId: COMPANY, initialized: true,
      openPeriodId: null, originLocalDate: null, version: 1,
    };
    const who = { driverId: DRIVER, companyId: COMPANY };
    // Crucially NOT 'none' — reading it as "no open shift" would let a second
    // concurrent period be minted off another driver's record.
    expect(decideResolve(foreign, who))
      .toEqual({ state: 'unverifiable', reason: 'driver_mismatch' });
    expect(decideClose(foreign, PERIOD, who))
      .toEqual({ action: 'refuse', reason: 'driver_mismatch' });
  });

  it('rejects a non-driver session', async () => {
    await expect(resolveSubject(
      driverRequest({ kind: 'admin', driverId: DRIVER }), readers(),
    )).rejects.toMatchObject({ message: 'driver_session_required' });
  });
});

describe('driver callables expose no driver/company selector', () => {
  it('accepts no driverId or companyId field on any shift callable', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'operational', 'shiftAuthorityCallables.ts'), 'utf8',
    ) as string;
    // The exact accepted key lists, asserted against source rather than assumed.
    expect(src).toMatch(/const RESOLVE_KEYS: string\[\] = \[\];/);
    expect(src).toMatch(/const CLAIM_KEYS = \['periodId', 'originLocalDate'\];/);
    // odometerMiles rides on close (period-scoped, captured at close time);
    // it is a bounded value, not a driver/company selector.
    expect(src).toMatch(/const CLOSE_KEYS = \['periodId', 'odometerMiles'\];/);
    expect(src).toMatch(/const DEPART_RETURN_KEYS = \['periodId'\];/);
  });
});

describe('firestore.rules denies direct authority access', () => {
  it('states an explicit deny for driver_shift_authority and keeps the catch-all', () => {
    const rules = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', '..', '..', '..', 'firestore.rules'), 'utf8',
    ) as string;
    expect(rules).toMatch(
      /match \/driver_shift_authority\/\{driverId\} \{\s*allow read, write: if false;/,
    );
    expect(rules).toMatch(/match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
  });
});
