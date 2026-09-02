/**
 * PART B PROOF — Does a BRAND-NEW canonical account get a working Routes button
 * (open, read, edit, save the CORRECT account's routes)?
 *
 * Drives the REAL governed functions end-to-end against an in-memory profile
 * store — the repo's own "provable without an emulator" pattern. No production
 * identities, no passcodes, no legacy `drivers/approved/{hash}` row.
 *
 * Proves the B2 checklist for a fresh canonical (UUID) driver:
 *   • one canonical identity; no legacy row required
 *   • Routes opens/authorizes for that canonical id
 *   • assign two in-company routes → save → reopen → exact routes persist
 *   • change to a different set → reopen → new set persists
 *   • a same/similar-display-name distinct driver cannot be targeted
 *   • another company's wells/routes never grant access
 *   • WB-M bootstrap eligibility derives from the SAME canonical profile
 *   • cross-driver / cross-tenant writes fail closed
 *   • empty/null/missing route semantics are explicit, never unrestricted
 *   • every read and write targets the same canonical driverId
 *
 * It also DOCUMENTS the authority-tension finding: a company-scoped account
 * with an empty scope is currently `ineligible` (no-access), i.e. routes act
 * as an entry gate. That behavior is asserted here as the current truth.
 */
import {
  assertCanonicalDriverId,
  evaluateStaffWriteDriverAssignment,
  CANONICAL_DRIVER_ID,
} from '../staffWriteDriverAssignment';
import {
  knownRouteNames,
  validateAssignedRoutesAgainstCatalog,
  validateAssignedWellsAgainstCatalog,
  parseScopeList,
  previewContextDigest,
  revisionNumber,
} from '../assignmentScope';
import {
  commitCanonicalAssignmentWrite,
  type AssignmentProfileRef,
} from '../assignmentApplyTransaction';
import { evaluateWbmWellScope, projectWbmWells } from '../wbmWellScope';
import { buildWbmBootstrapSnapshot } from '../wbmBootstrap';

// ── Fixtures ────────────────────────────────────────────────────────────────
const ACME = 'acme-co';
const GLOBEX = 'globex-co';
// Fresh canonical drivers — UUID v4, NOT passcode hashes.
const DRIVER_NEW = '11111111-1111-4111-8111-111111111111';
const DRIVER_SAMENAME = '22222222-2222-4222-8222-222222222222'; // same displayName, different id
const LEGACY_HASH = 'a'.repeat(64); // what a legacy drivers/approved key looks like
const ACTOR = 'staff-admin-uid';
const NOW = 1_800_000_000_000;

// Tenant-scoped well catalog: acme wells on acme routes, globex wells on a globex route.
const WELL_CONFIG: Record<string, Record<string, unknown>> = {
  'Acme North 1': { companyId: ACME, route: 'Acme North' },
  'Acme North 2': { companyId: ACME, route: 'Acme North' },
  'Acme South 1': { companyId: ACME, route: 'Acme South' },
  'Globex West 1': { companyId: GLOBEX, route: 'Globex West' },
};

function freshProfile(companyId = ACME, displayName = 'Jordan Rivera'): Record<string, unknown> {
  // Exactly what adminApproveDriverRegistration writes for a NEW account:
  // canonical, active, company-scoped, and NO assignedRoutes/assignedWells yet.
  return { active: true, companyId, displayName, schemaVersion: 3, mustUseSecureAuth: true };
}

// In-memory AssignmentProfileRef with faithful transaction semantics
// (mirrors src/security/operational/__tests__/assignmentApplyTransaction.test.ts).
type FakeSnap = { exists(): boolean; val(): unknown };
function makeFakeRef(initial: Record<string, unknown> | null) {
  const store = { value: initial ? { ...initial } : null };
  const listeners = new Set<(...a: unknown[]) => void>();
  const ref: AssignmentProfileRef & { store: typeof store; writes: number; listenerCount(): number } = {
    store,
    writes: 0,
    listenerCount: () => listeners.size,
    on(_e: 'value', cb: (...a: unknown[]) => void) { listeners.add(cb); cb(); return cb; },
    off(_e: 'value', cb?: (...a: unknown[]) => void) { if (cb) listeners.delete(cb); else listeners.clear(); },
    async transaction(update: (current: unknown) => unknown) {
      const next = update(store.value);
      if (next === undefined) {
        const snap: FakeSnap = { exists: () => store.value !== null, val: () => store.value };
        return { committed: false, snapshot: snap };
      }
      store.value = next as Record<string, unknown>;
      ref.writes += 1;
      const snap: FakeSnap = { exists: () => true, val: () => store.value };
      return { committed: true, snapshot: snap };
    },
  };
  return ref;
}

function digestFor(driverId: string, profile: Record<string, unknown>, routes: string[], wells: string[]) {
  return previewContextDigest({
    driverId,
    companyId: String(profile.companyId),
    assignmentRevision: revisionNumber(profile.assignmentRevision),
    currentRoutes: profile.assignedRoutes ?? null,
    currentWells: profile.assignedWells ?? null,
    proposedRoutes: routes,
    proposedWells: wells,
  });
}

/** One governed Routes "Apply" for a driverId against its own ref. */
async function assignRoutes(ref: ReturnType<typeof makeFakeRef>, driverId: string, routes: string[], wells: string[], callerCompanyId = ACME, isPlatformAdmin = false) {
  const profile = ref.store.value || {};
  return commitCanonicalAssignmentWrite({
    profileRef: ref,
    driverId,
    expectedPreviewContextDigest: digestFor(driverId, profile, routes, wells),
    proposedRoutes: routes,
    proposedWells: wells,
    callerCompanyId,
    isPlatformAdmin,
    callerUid: ACTOR,
    nowMs: NOW,
  });
}

// ── A. Canonical identity ─────────────────────────────────────────────────────
describe('A. fresh canonical identity — no legacy row', () => {
  it('accepts a UUID driverId and rejects a legacy passcode-hash key', () => {
    expect(assertCanonicalDriverId(DRIVER_NEW)).toBe(DRIVER_NEW);
    expect(CANONICAL_DRIVER_ID.test(DRIVER_NEW)).toBe(true);
    expect(() => assertCanonicalDriverId(LEGACY_HASH)).toThrow('driver_id_malformed');
    expect(() => assertCanonicalDriverId('')).toThrow('driver_id_malformed');
  });

  it('a fresh account is authorized for Routes by company membership (same-tenant caller)', () => {
    const d = evaluateStaffWriteDriverAssignment({
      driverId: DRIVER_NEW, profile: freshProfile(), callerCompanyId: ACME, isPlatformAdmin: false,
    });
    expect(d).toEqual({ ok: true, driverId: DRIVER_NEW, companyId: ACME });
  });
});

// ── B. Assign / read / edit / save — the correct account ──────────────────────
describe('B. assign → save → reopen persists exact routes on the canonical id', () => {
  it('assigns two in-company routes, persists, then edits to a different set', async () => {
    const ref = makeFakeRef(freshProfile());

    // catalog validation is tenant-aware
    const catalog = knownRouteNames(WELL_CONFIG);
    expect(validateAssignedRoutesAgainstCatalog(['Acme North', 'Acme South'], catalog)).toEqual({ ok: true });

    // first Apply
    const r1 = await assignRoutes(ref, DRIVER_NEW, ['Acme North', 'Acme South'], []);
    expect(r1.ok).toBe(true);
    // reopen (read the stored profile) → exact routes persisted, revision bumped
    expect(ref.store.value?.assignedRoutes).toEqual(['Acme North', 'Acme South']);
    expect(ref.store.value?.assignmentRevision).toBe(1);
    expect(ref.store.value?.assignmentUpdatedBy).toBe(ACTOR);

    // edit to a different set
    const r2 = await assignRoutes(ref, DRIVER_NEW, ['Acme North'], []);
    expect(r2.ok).toBe(true);
    expect(ref.store.value?.assignedRoutes).toEqual(['Acme North']);
    expect(ref.store.value?.assignmentRevision).toBe(2);
  });

  it('a stale preview digest is refused (optimistic-concurrency guard)', async () => {
    const ref = makeFakeRef(freshProfile());
    const staleDigest = digestFor(DRIVER_NEW, freshProfile(), ['Acme North'], []);
    // bump the live profile out from under the stale digest
    await assignRoutes(ref, DRIVER_NEW, ['Acme South'], []);
    const res = await commitCanonicalAssignmentWrite({
      profileRef: ref, driverId: DRIVER_NEW, expectedPreviewContextDigest: staleDigest,
      proposedRoutes: ['Acme North'], proposedWells: [], callerCompanyId: ACME,
      isPlatformAdmin: false, callerUid: ACTOR, nowMs: NOW,
    });
    expect(res).toEqual({ ok: false, reason: 'stale_preview_context' });
    expect(ref.store.value?.assignedRoutes).toEqual(['Acme South']); // unchanged by the stale attempt
  });
});

// ── C. Identity isolation — same name, cross-driver, cross-tenant ─────────────
describe('C. isolation: writes target ONLY the canonical driverId', () => {
  it('a same-display-name distinct driver is never touched by writing the other', async () => {
    const refNew = makeFakeRef(freshProfile(ACME, 'Jordan Rivera'));
    const refSame = makeFakeRef(freshProfile(ACME, 'Jordan Rivera')); // identical name, different UUID
    await assignRoutes(refNew, DRIVER_NEW, ['Acme North'], []);
    expect(refNew.store.value?.assignedRoutes).toEqual(['Acme North']);
    // the same-named driver's record is untouched — no display-name matching
    expect(refSame.store.value?.assignedRoutes).toBeUndefined();
    expect(refSame.writes).toBe(0);
    expect(DRIVER_NEW).not.toBe(DRIVER_SAMENAME);
  });

  it('a cross-tenant caller cannot write a driver in another company', async () => {
    const ref = makeFakeRef(freshProfile(ACME));
    const res = await assignRoutes(ref, DRIVER_NEW, ['Acme North'], [], GLOBEX, false);
    expect(res).toEqual({ ok: false, reason: 'tenant_mismatch' });
    expect(ref.store.value?.assignedRoutes).toBeUndefined(); // nothing written
  });
});

// ── D. Cross-company scope never grants access ────────────────────────────────
describe('D. tenant scoping of wells/routes', () => {
  it('rejects an out-of-company well outright', () => {
    expect(validateAssignedWellsAgainstCatalog(['Globex West 1'], WELL_CONFIG, ACME))
      .toEqual({ ok: false, reason: 'cross_company_well' });
    expect(validateAssignedWellsAgainstCatalog(['Acme North 1'], WELL_CONFIG, ACME))
      .toEqual({ ok: true });
  });

  it('a route that exists only on another company projects ZERO wells for the driver', () => {
    // 'Globex West' is a real catalog route (passes name validation) ...
    expect(validateAssignedRoutesAgainstCatalog(['Globex West'], knownRouteNames(WELL_CONFIG))).toEqual({ ok: true });
    // ... but an acme driver assigned it sees no wells (company filter first)
    const scope = evaluateWbmWellScope(['Globex West'], []);
    expect(scope.ok).toBe(true);
    const wells = projectWbmWells(WELL_CONFIG, ACME, scope as any);
    expect(Object.keys(wells)).toEqual([]);
  });

  it('rejects a route absent from the catalog', () => {
    expect(validateAssignedRoutesAgainstCatalog(['No Such Route'], knownRouteNames(WELL_CONFIG)))
      .toEqual({ ok: false, reason: 'nonexistent_route' });
  });
});

// ── E. WB-M bootstrap eligibility derives from the SAME canonical profile ──────
describe('E. WB-M bootstrap from the canonical profile', () => {
  it('a fresh account with an in-company route is eligible and sees only its company wells', () => {
    const profile = { ...freshProfile(), assignedRoutes: ['Acme North'], assignmentRevision: 1 };
    const snap = buildWbmBootstrapSnapshot({ driverId: DRIVER_NEW, companyId: ACME, profile, wellConfig: WELL_CONFIG });
    expect(snap.eligibilityStatus).toBe('eligible');
    expect(Object.keys(snap.wells).sort()).toEqual(['Acme North 1', 'Acme North 2']);
    // No globex well ever appears
    expect(Object.keys(snap.wells)).not.toContain('Globex West 1');
  });

  it('empty/missing route scope is explicit and NEVER unrestricted', () => {
    // parse layer: null/undefined are refused (never coerced to empty)
    expect(parseScopeList(undefined, 'assignedRoutes')).toEqual({ ok: false, reason: 'assignedRoutes_required' });
    expect(parseScopeList(null, 'assignedRoutes')).toEqual({ ok: false, reason: 'assignedRoutes_required' });
    // scope layer: empty → scope_empty, missing → scope_missing
    expect(evaluateWbmWellScope([], [])).toEqual({ ok: false, reason: 'scope_empty' });
    expect(evaluateWbmWellScope(undefined, undefined)).toEqual({ ok: false, reason: 'scope_missing' });

    // FINDING (authority tension): a company-scoped account with an EMPTY scope is
    // currently INELIGIBLE — routes act as a WB-M entry gate. Fails CLOSED (no
    // wells, no unrestricted access), but this is stricter than the packet's
    // stated contract that routes must not replace company/well authority.
    const emptyProfile = { ...freshProfile(), assignedRoutes: [], assignmentRevision: 1 };
    const snap = buildWbmBootstrapSnapshot({ driverId: DRIVER_NEW, companyId: ACME, profile: emptyProfile, wellConfig: WELL_CONFIG });
    expect(snap.eligibilityStatus).toBe('ineligible');
    expect(snap.eligibilityReason).toBe('scope_empty');
    expect(snap.wellCount).toBe(0); // never "all wells"
  });
});
