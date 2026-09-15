/**
 * ACTUAL Firebase emulator coverage for adminGetWellPool's three authorization
 * modes (global / company-scoped / denied) and the company-safe projection.
 *
 * Exercises the REAL exported callable handler (`adminGetWellPool.run(...)`) — its
 * real authorization resolution (requireRegisteredDashboardUser → RTDB users/{uid}
 * + Firestore companies roleCapabilities) and real projection — against emulated
 * RTDB + Firestore (never production). Skips when the emulator env is absent.
 *
 *   JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\t \
 *   firebase emulators:exec --only database,firestore --project wellbuilt-sync \
 *     "cd functions && npx jest src/security/__tests__/wellPoolAccess.emulator.e2e.test.ts"
 *
 * TRANSPORT NOTE: `.run(request)` executes the REAL handler with real auth
 * resolution + DB I/O, but it does NOT exercise the onCall HTTPS transport / App
 * Check / token-decode boundary. Those layers are Firebase-owned and unchanged by
 * this branch; they are explicitly out of scope for these tests.
 *
 * The projection / gate truth-tables are DB-independent (pure real functions) and
 * always run.
 */
import * as admin from 'firebase-admin';
import {
  projectWellStatus,
  projectCompanyWellPool,
  canonicalWellId,
  WELL_STATUS_ALLOWLIST,
} from '../dashboardCatalogProjection';
import {
  callerHasGlobalWellPoolAccess,
  callerCompanyWellPoolScope,
  GLOBAL_WELL_POOL_PRIVILEGES,
} from '../adminDashboardCatalog';

const RTDB = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const FS = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const describeE2E = RTDB && FS ? describe : describe.skip;

function init() {
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: PROJECT, databaseURL: `http://${RTDB}?ns=${PROJECT}-default-rtdb` });
  }
}

const DENIED = { ok: true, canViewWellPool: false, wellConfig: {}, wellStatus: {}, counts: { wellConfig: 0, wellStatus: 0 } };

describeE2E('emulator: adminGetWellPool — global / company-scoped / denied (real callable)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { adminGetWellPool } = require('../adminDashboardCatalog');
  const run = (uid: string, data: unknown = {}) =>
    adminGetWellPool.run({ data, auth: { uid, token: {} }, rawRequest: {} } as unknown) as Promise<any>;

  beforeAll(init);
  afterAll(async () => { await Promise.all(admin.apps.filter(Boolean).map((a) => a!.delete())); });

  beforeEach(async () => {
    const db = admin.database();
    await db.ref('users').set(null);
    await db.ref('well_config').set(null);
    await db.ref('packets').set(null);
    await db.ref('users').set({
      'plat-it': { role: 'it' },                                   // unscoped + viewAllCompanies → GLOBAL
      'plat-admin': { role: 'admin' },                             // unscoped admin, NO viewAllCompanies, no companyId
      'a-admin': { role: 'admin', companyId: 'company-a' },
      'a-dispatch': { role: 'dispatch', companyId: 'company-a' },
      'a-viewer': { role: 'viewer', companyId: 'company-a' },
      'a-auditor': { role: 'auditor', companyId: 'company-a' },    // custom role: no default caps
      'a-revoked': { role: 'viewer', companyId: 'company-revoke' },// company revokes viewer viewWellPool
      'b-admin': { role: 'admin', companyId: 'company-b' },
      'no-co-viewer': { role: 'viewer' },                          // viewWellPool but no companyId
      'evil-admin': { role: 'admin', companyId: 'evil' },          // company self-grants viewAllCompanies
    });
    await db.ref('well_config').set({
      'A Well 1': { companyId: 'company-a', wellId: 'A-1', route: 'RA', tanks: 1, pullBbls: 140, bottomLevel: 3, avgFlowRate: '6:00:00' },
      'Shared Well': { companyId: 'company-a', wellId: 'A-2', route: 'RA', tanks: 1, pullBbls: 140, bottomLevel: 3, avgFlowRate: '6:00:00' },
      'A No WellId': { companyId: 'company-a', route: 'RA', tanks: 1, pullBbls: 140, bottomLevel: 3, avgFlowRate: '6:00:00' }, // config has NO wellId
      'A Bad Status': { companyId: 'company-a', wellId: 'A-4', route: 'RA', tanks: 1, pullBbls: 140, bottomLevel: 3, avgFlowRate: '6:00:00' },
      'B Rig 7': { companyId: 'company-b', wellId: 'B-7', route: 'RB', tanks: 1, pullBbls: 140, bottomLevel: 3, avgFlowRate: '6:00:00' },
      'Evil Well': { companyId: 'evil', wellId: 'E-1', route: 'RE', tanks: 1, pullBbls: 140, bottomLevel: 3, avgFlowRate: '6:00:00' },
      'Legacy Well': { route: 'RL', tanks: 1, pullBbls: 140, bottomLevel: 3, avgFlowRate: '6:00:00' }, // NO companyId
    });
    await db.ref('packets/outgoing').set({
      response_a1: { wellName: 'A Well 1', companyId: 'company-a', wellId: 'A-1', currentLevel: "5'0\"", lastPullBottomLevel: "4'0\"", lastPullDateTimeUTC: '2026-09-14T00:00:00Z', flowRate: '6:00:00' },
      response_a_shared: { wellName: 'Shared Well', companyId: 'company-a', wellId: 'A-2', currentLevel: "4'0\"", lastPullBottomLevel: "3'0\"", lastPullDateTimeUTC: '2026-09-14T00:00:00Z', flowRate: '6:00:00' },
      response_b_collide: { wellName: 'Shared Well', companyId: 'company-b', wellId: 'B-9', currentLevel: "18'0\"", lastPullBottomLevel: "17'0\"", lastPullDateTimeUTC: '2026-09-13T00:00:00Z', flowRate: '3:00:00' },
      response_b7: { wellName: 'B Rig 7', companyId: 'company-b', wellId: 'B-7', currentLevel: "9'0\"", lastPullBottomLevel: "8'0\"", lastPullDateTimeUTC: '2026-09-14T00:00:00Z', flowRate: '6:00:00' },
      response_evil: { wellName: 'Evil Well', companyId: 'evil', wellId: 'E-1', currentLevel: "7'0\"", lastPullBottomLevel: "6'0\"", lastPullDateTimeUTC: '2026-09-14T00:00:00Z', flowRate: '6:00:00' },
      response_anowellid: { wellName: 'A No WellId', companyId: 'company-a', wellId: 'A-3', currentLevel: "6'0\"", lastPullBottomLevel: "5'0\"", lastPullDateTimeUTC: '2026-09-14T00:00:00Z', flowRate: '6:00:00' },
      response_badstatus: { wellName: 'A Bad Status', currentLevel: "7'0\"", lastPullBottomLevel: "6'0\"", lastPullDateTimeUTC: '2026-09-14T00:00:00Z', flowRate: '6:00:00' }, // NO companyId / wellId
    });
    const fs = admin.firestore();
    await fs.collection('companies').doc('company-a').set({ state: 'ND' });
    await fs.collection('companies').doc('company-b').set({ state: 'ND' });
    await fs.collection('companies').doc('company-revoke').set({ roleCapabilities: { viewer: [] } }); // REVOKE viewWellPool
    await fs.collection('companies').doc('evil').set({ roleCapabilities: { admin: ['viewAllCompanies', 'viewWellPool'] } });
  });

  // ── Mode 1: explicit global authority ──
  it('platform user WITH explicit global capability (it/viewAllCompanies) → GLOBAL pool', async () => {
    const res = await run('plat-it');
    expect(res.canViewWellPool).toBe(true);
    expect(Object.keys(res.wellConfig)).toEqual(expect.arrayContaining(['A Well 1', 'Shared Well', 'B Rig 7', 'Evil Well', 'Legacy Well']));
    expect(res.counts.wellConfig).toBeGreaterThanOrEqual(7);
  });

  it('platform user WITHOUT global capability (unscoped admin, no companyId) → DENIED', async () => {
    expect(await run('plat-admin')).toEqual(DENIED);
  });

  // ── Mode 2: company-scoped viewWellPool ──
  for (const uid of ['a-admin', 'a-dispatch', 'a-viewer']) {
    it(`company ${uid} (viewWellPool) → company-a pool ONLY`, async () => {
      const res = await run(uid);
      expect(res.canViewWellPool).toBe(true);
      const keys = Object.keys(res.wellConfig);
      expect(keys).toEqual(expect.arrayContaining(['A Well 1', 'Shared Well']));
      // No other company's wells, and no unattributable legacy well.
      expect(keys).not.toContain('B Rig 7');
      expect(keys).not.toContain('Evil Well');
      expect(keys).not.toContain('Legacy Well');
      // Owned status attached; unavailable stays absent (never zero, never foreign).
      expect(res.wellStatus['A Well 1'].currentLevel).toBe("5'0\"");
      expect(res.wellStatus['Shared Well'].currentLevel).toBe("4'0\""); // A's own, NOT B's 18'0"
      expect(res.wellStatus['A No WellId']).toBeUndefined();  // config has no wellId → status cannot be proven
      expect(res.wellStatus['A Bad Status']).toBeUndefined(); // status has no companyId/wellId → rejected
    });
  }

  it('custom company role WITHOUT viewWellPool → DENIED', async () => {
    expect(await run('a-auditor')).toEqual(DENIED);
  });

  it('explicit capability REVOCATION (company sets viewer roleCapabilities [] ) → DENIED', async () => {
    expect(await run('a-revoked')).toEqual(DENIED);
  });

  it('authenticated caller with NO companyId (viewWellPool but unscoped, not platform) → DENIED', async () => {
    expect(await run('no-co-viewer')).toEqual(DENIED);
  });

  it('cross-company INPUT is ignored — identity decides, payload does not', async () => {
    const res = await run('a-admin', { companyId: 'company-b' });
    expect(Object.keys(res.wellConfig)).toContain('A Well 1');
    expect(Object.keys(res.wellConfig)).not.toContain('B Rig 7'); // never company-b, despite the payload
  });

  it('tenant self-escalation via company roleCapabilities → own pool ONLY, never global', async () => {
    const res = await run('evil-admin'); // company granted itself viewAllCompanies + viewWellPool
    expect(res.canViewWellPool).toBe(true);
    expect(Object.keys(res.wellConfig)).toEqual(['Evil Well']); // ONLY evil's own well
    expect(Object.keys(res.wellConfig)).not.toContain('A Well 1');
    expect(Object.keys(res.wellConfig)).not.toContain('B Rig 7');
  });

  it('every denied persona returns the IDENTICAL empty result — no distinguishable cross-tenant metadata', async () => {
    const denied = ['plat-admin', 'a-auditor', 'a-revoked', 'no-co-viewer'];
    const results = await Promise.all(denied.map((u) => run(u)));
    for (const r of results) expect(r).toEqual(DENIED);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  // ── Same-name across two tenants ──
  it('same well name, different tenants: each company gets only its OWN status', async () => {
    const a = await run('a-admin');
    const b = await run('b-admin');
    // A owns "Shared Well" and sees its OWN status (4'0"), never B's colliding 18'0".
    expect(a.wellStatus['Shared Well'].currentLevel).toBe("4'0\"");
    // B does not own a "Shared Well" config → it never appears for B; B sees only its own.
    expect(Object.keys(b.wellConfig)).toContain('B Rig 7');
    expect(Object.keys(b.wellConfig)).not.toContain('Shared Well');
    expect(b.wellStatus['B Rig 7'].currentLevel).toBe("9'0\"");
  });

  it('writer-loss: if dedupe left only the FOREIGN row, the owner gets config + UNAVAILABLE (never the foreign row)', async () => {
    // Simulate the global wellName dedupe having removed A's own row, leaving B's collision.
    await admin.database().ref('packets/outgoing/response_a_shared').remove();
    const a = await run('a-admin');
    expect(Object.keys(a.wellConfig)).toContain('Shared Well'); // config still returned
    expect(a.wellStatus['Shared Well']).toBeUndefined();        // status UNAVAILABLE, NOT B's 18'0"
  });

  it('platform/global path exhibits the documented wellName writer-loss limitation (can surface a FOREIGN row)', async () => {
    // Mode 1 uses the wellName-deduped global projection (projectWellStatus). Two tenants'
    // status rows for "Shared Well" collapse to ONE, and the survivor here is company B's
    // FOREIGN row (18'0") even though "Shared Well" is company A's configured well — a
    // concrete demonstration that the global path is NOT tenant-safe. The company-scoped
    // path (mode 2) is immune: it filters raw rows by companyId + canonical wellId BEFORE
    // any wellName keying, so company A correctly gets 4'0" and B never appears for A.
    const res = await run('plat-it');
    expect(res.wellStatus['Shared Well']).toBeDefined();
    expect(["4'0\"", "18'0\""]).toContain(res.wellStatus['Shared Well'].currentLevel);
    // Only global authority is exposed to this collapsed/ambiguous view; scoped callers
    // (proven above) never are.
  });
});

// ── DB-independent proofs (real functions) — always run ─────────────────────────
describe('projectCompanyWellPool — company-safe filtering (pure)', () => {
  const config = {
    'Owned': { companyId: 'c1', wellId: 'W1', route: 'R' },
    'Owned No Status': { companyId: 'c1', wellId: 'W2', route: 'R' },
    'Owned No WellId': { companyId: 'c1', route: 'R' },
    'Foreign': { companyId: 'c2', wellId: 'F1', route: 'R' },
    'No Company': { wellId: 'X1', route: 'R' },
  };
  const outgoing = {
    response_ok: { wellName: 'Owned', companyId: 'c1', wellId: 'W1', currentLevel: "5'0\"", timestampUTC: '2026-09-14T00:00:00Z' },
    response_foreign_company: { wellName: 'Owned No Status', companyId: 'c2', wellId: 'W2', currentLevel: "9'0\"", timestampUTC: '2026-09-14T00:00:00Z' },
    response_wellid_mismatch: { wellName: 'Owned No WellId', companyId: 'c1', wellId: 'ZZ', currentLevel: "9'0\"", timestampUTC: '2026-09-14T00:00:00Z' },
    response_foreign_well: { wellName: 'Foreign', companyId: 'c2', wellId: 'F1', currentLevel: "1'0\"", timestampUTC: '2026-09-14T00:00:00Z' },
  };

  it('returns only c1 config; foreign + no-company configs excluded (fail closed)', () => {
    const r = projectCompanyWellPool('c1', config, outgoing);
    const keys = Object.keys(r.wellConfig);
    expect(keys).toEqual(expect.arrayContaining(['Owned', 'Owned No Status', 'Owned No WellId']));
    expect(keys).not.toContain('Foreign');
    expect(keys).not.toContain('No Company');
  });

  it('status attached ONLY on company + wellId match; mismatches → unavailable, never foreign, never zero', () => {
    const r = projectCompanyWellPool('c1', config, outgoing);
    expect(r.wellStatus['Owned'].currentLevel).toBe("5'0\"");     // company + wellId match
    expect(r.wellStatus['Owned No Status']).toBeUndefined();      // status companyId c2 ≠ c1 → rejected
    expect(r.wellStatus['Owned No WellId']).toBeUndefined();      // config has no wellId → cannot prove
    expect(r.counts.wellStatus).toBe(1);
  });

  it('empty companyId → empty pool (fails closed)', () => {
    const r = projectCompanyWellPool('', config, outgoing);
    expect(r.counts).toEqual({ wellConfig: 0, wellStatus: 0 });
  });

  it('canonicalWellId reads wellId then id, else empty', () => {
    expect(canonicalWellId({ wellId: 'A' })).toBe('A');
    expect(canonicalWellId({ id: 7 })).toBe('7');
    expect(canonicalWellId({})).toBe('');
  });
});

describe('same-well-name collision resolution (composite identity in global projection)', () => {
  it('status rows carry canonical tenant identity through composite keys and allowlist', () => {
    const projected = projectWellStatus({
      response_A: { wellName: 'Gabriel 4', companyId: 'a', wellId: 'A', currentLevel: "4'0\"", timestampUTC: '2026-09-14T00:00:00Z' },
      response_B: { wellName: 'Gabriel 4', companyId: 'b', wellId: 'B', currentLevel: "9'0\"", timestampUTC: '2026-09-13T00:00:00Z' },
    });
    // Distinct composite keys retain both tenants' status
    expect(projected['a__A']?.companyId).toBe('a');
    expect(projected['a__A']?.wellId).toBe('A');
    expect(projected['b__B']?.companyId).toBe('b');
    expect(projected['b__B']?.wellId).toBe('B');
    // Display name alias also present
    expect('Gabriel 4' in projected).toBe(true);
    expect((WELL_STATUS_ALLOWLIST as readonly string[]).includes('companyId')).toBe(true);
    expect((WELL_STATUS_ALLOWLIST as readonly string[]).includes('wellId')).toBe(true);
  });
});

describe('authorization gate truth-tables (real gates)', () => {
  const caps = (...c: string[]) => ({ caps: c });
  it('GLOBAL requires isPlatformAdmin + viewAllCompanies; viewWellPool is NOT global', () => {
    expect(GLOBAL_WELL_POOL_PRIVILEGES).toEqual(['viewAllCompanies']);
    expect(callerHasGlobalWellPoolAccess({ isPlatformAdmin: true, ...caps('viewAllCompanies') })).toBe(true);
    expect(callerHasGlobalWellPoolAccess({ isPlatformAdmin: true, ...caps('viewWellPool') })).toBe(false);
    expect(callerHasGlobalWellPoolAccess({ isPlatformAdmin: true, ...caps('manageDrivers') })).toBe(false);
    expect(callerHasGlobalWellPoolAccess({ isPlatformAdmin: false, ...caps('viewAllCompanies', 'viewWellPool') })).toBe(false);
  });
  it('COMPANY scope requires companyId + viewWellPool; never grants global', () => {
    expect(callerCompanyWellPoolScope({ companyId: 'c1', ...caps('viewWellPool') })).toBe('c1');
    expect(callerCompanyWellPoolScope({ companyId: 'c1', ...caps('manageDrivers') })).toBe(null); // no viewWellPool
    expect(callerCompanyWellPoolScope({ companyId: '', ...caps('viewWellPool') })).toBe(null);    // no companyId
    // A scoped caller with viewAllCompanies is still only company-scoped here (not global).
    expect(callerCompanyWellPoolScope({ companyId: 'c1', ...caps('viewAllCompanies', 'viewWellPool') })).toBe('c1');
  });
});
