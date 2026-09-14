// Unit tests for the deterministic level-report identity resolver.
// Mirrors the observed production data shapes:
//  - legacy driver: drivers/approved/{64hash} carries companyId
//  - canonical driver: drivers/approved/{36uuid} is thin (no companyId),
//    drivers/profiles/{36uuid} carries companyId  ← the break + the fix
import {
  resolveLevelChatDriver,
  participantAliasSet,
  levelReportMessageId,
  driverIdForm,
  LEVEL_CHAT_REASON,
} from '../levelChatIdentity';

const LEGACY = 'a'.repeat(64);
const CANON = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';

const readers = (approved: Record<string, Record<string, unknown>>, profiles: Record<string, Record<string, unknown>>) => ({
  readApproved: async (id: string) => approved[id] || null,
  readProfile: async (id: string) => profiles[id] || null,
});

describe('resolveLevelChatDriver', () => {
  test('legacy driver: companyId from drivers/approved', async () => {
    const r = await resolveLevelChatDriver(LEGACY, readers(
      { [LEGACY]: { companyId: 'liquid-gold', legalName: 'Test Driver', displayName: 'TD' } },
      {},
    ));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.driver.companyId).toBe('liquid-gold');
      expect(r.driver.source).toBe('approved');
      expect(r.driver.participantIds).toEqual([`driver:${LEGACY}`]);
      expect(r.driver.driverName).toBe('Test Driver');
    }
  });

  test('canonical driver: thin approved (no companyId) → falls back to profiles', async () => {
    const r = await resolveLevelChatDriver(CANON, readers(
      { [CANON]: { profile: { truckNumber: '12' } } },                  // thin approved, no companyId
      { [CANON]: { companyId: 'liquid-gold', legalName: 'Gabriel Driver' } },
    ));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.driver.companyId).toBe('liquid-gold');
      expect(r.driver.source).toBe('profiles');
      expect(r.driver.participantIds).toEqual([`driver:${CANON}`]);
    }
  });

  test('canonical driver with an EXPLICIT legacy alias on the profile → both participant ids', async () => {
    const r = await resolveLevelChatDriver(CANON, readers(
      { [CANON]: {} },
      { [CANON]: { companyId: 'liquid-gold', legacyHash: LEGACY } },
    ));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(new Set(r.driver.participantIds)).toEqual(new Set([`driver:${CANON}`, `driver:${LEGACY}`]));
    }
  });

  test('record exists but no companyId anywhere → NO_COMPANY (the observed live skip)', async () => {
    const r = await resolveLevelChatDriver(CANON, readers(
      { [CANON]: { profile: { truckNumber: '12' } } },
      { [CANON]: { displayName: 'no company' } },
    ));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(LEVEL_CHAT_REASON.NO_COMPANY);
  });

  test('no record at all → DRIVER_UNRESOLVED', async () => {
    const r = await resolveLevelChatDriver(CANON, readers({}, {}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(LEVEL_CHAT_REASON.DRIVER_UNRESOLVED);
  });

  test('missing driverId → NO_DRIVER_ID', async () => {
    const r = await resolveLevelChatDriver(undefined, readers({}, {}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(LEVEL_CHAT_REASON.NO_DRIVER_ID);
  });

  test('no scan / no guess: an 8-char migratedFromLegacyHashPrefix is NOT used as an alias', async () => {
    const ids = participantAliasSet(CANON, { migratedFromLegacyHashPrefix: 'a1b2c3d4', companyId: 'liquid-gold' });
    expect(ids).toEqual([`driver:${CANON}`]); // prefix ignored (not a full id)
  });
});

describe('dedup + diagnostics helpers', () => {
  test('levelReportMessageId is deterministic and id-safe', () => {
    const a = levelReportMessageId('20260913_145126_Gabriel4_noarwi', 'THREADabc123');
    const b = levelReportMessageId('20260913_145126_Gabriel4_noarwi', 'THREADabc123');
    expect(a).toBe(b);
    expect(a).toMatch(/^lvl_[A-Za-z0-9_-]+$/);
    // different thread → different id (no cross-thread collision)
    expect(levelReportMessageId('p', 't1')).not.toBe(levelReportMessageId('p', 't2'));
  });

  test('driverIdForm classifies without leaking the id', () => {
    expect(driverIdForm(CANON)).toBe('canonical(36)');
    expect(driverIdForm(LEGACY)).toBe('legacyHash(64)');
    expect(driverIdForm(undefined)).toBe('none');
  });
});
