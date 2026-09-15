/**
 * ACTUAL Firebase emulator coverage for the adminGetWellPool GLOBAL-access
 * containment (deny-by-default). Exercises the REAL exported callable handler
 * (`adminGetWellPool.run(...)`) — its real authorization resolution
 * (requireRegisteredDashboardUser → RTDB users/{uid} + Firestore companies) and
 * real projection — against emulated RTDB + Firestore (never production).
 * Skips when the emulator env is absent. Invoke via:
 *   JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\t \
 *   firebase emulators:exec --only database,firestore --project wellbuilt-sync \
 *     "npx jest src/security/__tests__/wellPoolContainment.emulator.e2e.test.ts"
 *
 * The same-well-name / missing-companyId collision proofs are DB-independent
 * (pure real projection functions) and always run.
 */
import * as admin from 'firebase-admin';
import { projectWellStatus, WELL_STATUS_ALLOWLIST } from '../dashboardCatalogProjection';
import { callerHasGlobalWellPoolAccess, GLOBAL_WELL_POOL_PRIVILEGES } from '../adminDashboardCatalog';

const RTDB = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const FS = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const describeE2E = RTDB && FS ? describe : describe.skip;

function init() {
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: PROJECT, databaseURL: `http://${RTDB}?ns=${PROJECT}-default-rtdb` });
  }
}

const DENIED = {
  ok: true,
  canViewWellPool: false,
  wellConfig: {},
  wellStatus: {},
  counts: { wellConfig: 0, wellStatus: 0 },
};

describeE2E('emulator: adminGetWellPool GLOBAL-access containment (real callable)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { adminGetWellPool } = require('../adminDashboardCatalog');
  const run = (auth: unknown, data: unknown = {}) =>
    adminGetWellPool.run({ data, auth, rawRequest: {} } as unknown) as Promise<any>;
  const authFor = (uid: string) => ({ uid, token: {} });

  beforeAll(init);
  afterAll(async () => { await Promise.all(admin.apps.filter(Boolean).map((a) => a!.delete())); });

  beforeEach(async () => {
    const db = admin.database();
    await db.ref('users').set(null);
    await db.ref('well_config').set(null);
    await db.ref('packets').set(null);
    // Personas (RTDB users/{uid} = the production source of truth for identity).
    await db.ref('users').set({
      'plat-it': { role: 'it' },                              // unscoped + viewAllCompanies → GLOBAL
      'plat-admin': { role: 'admin' },                        // unscoped admin, NO global privilege
      'lg-admin': { role: 'admin', companyId: 'liquid-gold' },
      'lg-viewer': { role: 'viewer', companyId: 'liquid-gold' },
      'acme-admin': { role: 'admin', companyId: 'acme' },
      'acme-dispatch': { role: 'dispatch', companyId: 'acme' },
      'acme-viewer': { role: 'viewer', companyId: 'acme' },
      'no-co-viewer': { role: 'viewer' },                     // no companyId, not admin
      'evil-admin': { role: 'admin', companyId: 'evil' },     // company tries to self-escalate
    });
    // A global/LG well, a tenant well, and a legacy well with NO companyId.
    await db.ref('well_config').set({
      'Gabriel 4': { route: 'R1', tanks: 1, pullBbls: 140, bottomLevel: 3, avgFlowRate: '6:00:00', companyId: 'liquid-gold' },
      'Acme Well 1': { route: 'A', tanks: 1, pullBbls: 140, bottomLevel: 3, avgFlowRate: '6:00:00', companyId: 'acme' },
      'Legacy Well': { route: 'L', tanks: 1, pullBbls: 140, bottomLevel: 3, avgFlowRate: '6:00:00' },
    });
    await db.ref('packets/outgoing').set({
      response_1: { wellName: 'Gabriel 4', currentLevel: "4'0\"", lastPullBottomLevel: "3'0\"", lastPullDateTimeUTC: '2026-09-14T00:00:00Z', flowRate: '6:00:00' },
    });
    const fs = admin.firestore();
    await fs.collection('companies').doc('liquid-gold').set({ state: 'ND' });
    await fs.collection('companies').doc('acme').set({ state: 'ND' });
    // Tenant tries to grant itself the global privilege via company roleCapabilities.
    await fs.collection('companies').doc('evil').set({ roleCapabilities: { admin: ['viewAllCompanies', 'viewWellPool'] } });
  });

  it('PLATFORM it (unscoped + viewAllCompanies) → GLOBAL pool served', async () => {
    const res = await run(authFor('plat-it'));
    expect(res.canViewWellPool).toBe(true);
    expect(Object.keys(res.wellConfig)).toEqual(expect.arrayContaining(['Gabriel 4', 'Acme Well 1', 'Legacy Well']));
    expect(res.wellStatus['Gabriel 4']).toBeTruthy();
    expect(res.counts.wellConfig).toBeGreaterThanOrEqual(3);
  });

  it('PLATFORM admin WITHOUT an explicit global privilege → DENIED (deny-by-default)', async () => {
    expect(await run(authFor('plat-admin'))).toEqual(DENIED);
  });

  it('Liquid Gold admin (membership alone) → DENIED', async () => {
    expect(await run(authFor('lg-admin'))).toEqual(DENIED);
  });

  it('Liquid Gold viewer (no capability) → DENIED', async () => {
    expect(await run(authFor('lg-viewer'))).toEqual(DENIED);
  });

  it('ordinary tenant admin → DENIED (never global data)', async () => {
    expect(await run(authFor('acme-admin'))).toEqual(DENIED);
  });

  it('ordinary tenant dispatcher → DENIED', async () => {
    expect(await run(authFor('acme-dispatch'))).toEqual(DENIED);
  });

  it('ordinary tenant viewer without viewWellPool → DENIED', async () => {
    expect(await run(authFor('acme-viewer'))).toEqual(DENIED);
  });

  it('authenticated caller with NO companyId (not a platform admin) → DENIED', async () => {
    expect(await run(authFor('no-co-viewer'))).toEqual(DENIED);
  });

  it('cross-company INPUT attempt is ignored (identity, not payload, decides) → DENIED', async () => {
    // A tenant admin passing a global companyId in the request payload still gets nothing.
    expect(await run(authFor('acme-admin'), { companyId: 'liquid-gold' })).toEqual(DENIED);
  });

  it('tenant self-escalation via company roleCapabilities is blocked (isPlatformAdmin requires no companyId)', async () => {
    expect(await run(authFor('evil-admin'))).toEqual(DENIED);
  });

  it('every denied persona returns the IDENTICAL empty result — no distinguishable cross-tenant metadata', async () => {
    const denied = ['plat-admin', 'lg-admin', 'lg-viewer', 'acme-admin', 'acme-dispatch', 'acme-viewer', 'no-co-viewer', 'evil-admin'];
    const results = await Promise.all(denied.map((u) => run(authFor(u))));
    for (const r of results) expect(r).toEqual(DENIED);
    // Byte-identical (JSON) across every denied persona — nothing leaks the caller's tenant.
    const shapes = new Set(results.map((r) => JSON.stringify(r)));
    expect(shapes.size).toBe(1);
  });
});

// ── DB-independent proofs (real projection functions) — always run ──────────────
describe('same-well-name / missing-companyId collision proof (why a wellName join is unsafe)', () => {
  it('status rows carry NO companyId and a wellName key collapses two tenants into one', () => {
    // Two companies each pull a well named "Gabriel 4". packets/outgoing is keyed by
    // response id and carries wellName but NO companyId.
    const outgoing = {
      response_A: { wellName: 'Gabriel 4', currentLevel: "4'0\"", timestampUTC: '2026-09-14T00:00:00Z' },
      response_B: { wellName: 'Gabriel 4', currentLevel: "9'0\"", timestampUTC: '2026-09-13T00:00:00Z' },
    };
    const projected = projectWellStatus(outgoing);
    // The projection is keyed by wellName → the two tenants' statuses COLLAPSE to one.
    expect(Object.keys(projected)).toEqual(['Gabriel 4']);
    // And the surviving record carries no companyId, so it cannot be attributed to a
    // tenant — a wellName-keyed scoped join would cross-associate. Hence deny-by-default
    // until a companyId-bearing / canonical-well-id status identity exists.
    expect('companyId' in projected['Gabriel 4']).toBe(false);
  });

  it('the status allowlist has no companyId — status can never carry tenant identity through projection', () => {
    expect((WELL_STATUS_ALLOWLIST as readonly string[]).includes('companyId')).toBe(false);
  });
});

describe('callerHasGlobalWellPoolAccess unit truth-table (the well-pool-specific gate)', () => {
  const caps = (...c: string[]) => ({ caps: c });
  it('platform admin + explicit global privilege → allowed', () => {
    for (const p of GLOBAL_WELL_POOL_PRIVILEGES) {
      expect(callerHasGlobalWellPoolAccess({ isPlatformAdmin: true, ...caps(p) })).toBe(true);
    }
  });
  it('platform admin WITHOUT a global privilege → denied', () => {
    expect(callerHasGlobalWellPoolAccess({ isPlatformAdmin: true, ...caps('manageDrivers', 'manageEquipment') })).toBe(false);
  });
  it('scoped caller with a global cap (self-escalation) → denied (not a platform admin)', () => {
    expect(callerHasGlobalWellPoolAccess({ isPlatformAdmin: false, ...caps('viewAllCompanies', 'viewWellPool') })).toBe(false);
  });
  it('missing/empty identity → denied (fails closed)', () => {
    expect(callerHasGlobalWellPoolAccess({ isPlatformAdmin: false, ...caps() })).toBe(false);
    // @ts-expect-error deliberately malformed
    expect(callerHasGlobalWellPoolAccess(null)).toBe(false);
    // @ts-expect-error caps missing
    expect(callerHasGlobalWellPoolAccess({ isPlatformAdmin: true })).toBe(false);
  });
});
