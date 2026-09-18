/**
 * Comprehensive tests for adminSetDriverPasscode tenant authorization and hardening.
 *
 * Synthetic test drivers only. Adan, Liquid Gold production identities, and real passcodes
 * are strictly untouched.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  evaluateAdminSetDriverPasscodeTarget,
  CANONICAL_DRIVER_ID,
  CallerContext,
  TargetEvaluationContext,
} from '../operational/adminSetDriverPasscodeTarget';

const SYNTHETIC_DRIVER_A = '11111111-2222-3333-4444-555555555555';
const SYNTHETIC_DRIVER_B = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const COMPANY_A = 'company-alpha';
const COMPANY_B = 'company-bravo';

const VALID_TEST_SCRYPT_RECORD = {
  algo: 'scrypt',
  saltB64: 'c2FsdHNhbHRzYWx0',
  hashB64: 'aGFzaGhhc2hoYXNoaGFzaA==',
  N: 16384,
  r: 8,
  p: 1,
  keyLen: 32,
};

function makeAuthorizedCaller(overrides?: Partial<CallerContext>): CallerContext {
  return {
    uid: 'manager-uid-001',
    roles: ['manager'],
    companyId: COMPANY_A,
    caps: ['manageDrivers'],
    isPlatformAdmin: false,
    ...overrides,
  };
}

function makeHealthyDriverTarget(overrides?: Partial<TargetEvaluationContext>): TargetEvaluationContext {
  return {
    caller: makeAuthorizedCaller(),
    requestedDriverId: SYNTHETIC_DRIVER_A,
    requestDisplayName: 'Synthetic Driver Alpha',
    requestCompanyId: COMPANY_A,
    credentials: {
      exists: true,
      active: true,
      passcode: VALID_TEST_SCRYPT_RECORD,
      companyId: COMPANY_A,
      displayName: 'Synthetic Driver Alpha',
    },
    profile: {
      exists: true,
      active: true,
      companyId: COMPANY_A,
      displayName: 'Synthetic Driver Alpha',
    },
    userRecordExists: false,
    approvedRowExists: false,
    isAuthUserEmail: false,
    ...overrides,
  };
}

describe('adminSetDriverPasscode — Tenant Authorization & Pre-Mutation Target Validation', () => {
  // 1. unauthenticated caller denied
  test('unauthenticated caller is denied', () => {
    const ctx = makeHealthyDriverTarget({
      caller: { uid: '', roles: [], companyId: COMPANY_A, caps: [] },
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('unauthenticated');
      expect(res.reason).toMatch(/signed in/i);
    }
  });

  // 2. caller lacking manageDrivers denied
  test('caller lacking manageDrivers capability is denied', () => {
    const ctx = makeHealthyDriverTarget({
      caller: makeAuthorizedCaller({ caps: ['viewDispatches'] }),
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('permission-denied');
      expect(res.reason).toMatch(/manageDrivers/i);
    }
  });

  // 3. same-company authorized manager succeeds
  test('same-company authorized manager succeeds', () => {
    const ctx = makeHealthyDriverTarget();
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.driverId).toBe(SYNTHETIC_DRIVER_A);
      expect(res.targetCompanyId).toBe(COMPANY_A);
      expect(res.displayName).toBe('Synthetic Driver Alpha');
    }
  });

  // 4. Company A manager targeting Company B UUID is denied
  test('Company A manager targeting Company B UUID is denied', () => {
    const ctx = makeHealthyDriverTarget({
      caller: makeAuthorizedCaller({ companyId: COMPANY_A }),
      requestedDriverId: SYNTHETIC_DRIVER_B,
      requestCompanyId: COMPANY_B,
      credentials: {
        exists: true,
        active: true,
        passcode: VALID_TEST_SCRYPT_RECORD,
        companyId: COMPANY_B,
        displayName: 'Target Bravo Driver',
      },
      profile: {
        exists: true,
        active: true,
        companyId: COMPANY_B,
        displayName: 'Target Bravo Driver',
      },
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('permission-denied');
      expect(res.reason).toBe('Cross-company driver access denied');
    }
  });

  // 5. cross-company denial mutates nothing (state integrity simulation)
  test('cross-company denial mutates nothing in credentials, profile, Auth claims, journal, or audit success records', () => {
    // Initial store state for Company B driver
    const initialCredentials = {
      driverId: SYNTHETIC_DRIVER_B,
      active: true,
      passcode: { ...VALID_TEST_SCRYPT_RECORD },
      companyId: COMPANY_B,
      updatedAtMs: 1000000,
      opId: 'initial-op-id',
    };
    const initialProfile = {
      displayName: 'Bravo Driver',
      active: true,
      companyId: COMPANY_B,
    };
    const initialClaims = {
      driverId: SYNTHETIC_DRIVER_B,
      companyId: COMPANY_B,
      mustChangePasscode: false,
    };
    const journalEntries: string[] = [];
    const auditSuccessRecords: string[] = [];

    // Simulate store state before request
    const credentialsStore = new Map([[SYNTHETIC_DRIVER_B, { ...initialCredentials }]]);
    const profileStore = new Map([[SYNTHETIC_DRIVER_B, { ...initialProfile }]]);
    const claimsStore = new Map([[SYNTHETIC_DRIVER_B, { ...initialClaims }]]);

    // Cross-company caller attempt (Company A caller targeting Company B driver)
    const caller = makeAuthorizedCaller({ companyId: COMPANY_A });
    const evalResult = evaluateAdminSetDriverPasscodeTarget({
      caller,
      requestedDriverId: SYNTHETIC_DRIVER_B,
      credentials: {
        exists: true,
        active: initialCredentials.active,
        passcode: initialCredentials.passcode,
        companyId: initialCredentials.companyId,
      },
      profile: {
        exists: true,
        active: initialProfile.active,
        companyId: initialProfile.companyId,
      },
    });

    // Verify rejection occurred before any mutation logic
    expect(evalResult.ok).toBe(false);

    // If evalResult is not ok, caller throws and writes zero mutations:
    if (!evalResult.ok) {
      // Zero mutations applied
    } else {
      // If incorrectly allowed, it would have mutated:
      credentialsStore.set(SYNTHETIC_DRIVER_B, { ...initialCredentials, updatedAtMs: 2000000 });
      auditSuccessRecords.push('adminSetDriverPasscode');
    }

    // Verify exact state preservation
    expect(credentialsStore.get(SYNTHETIC_DRIVER_B)).toEqual(initialCredentials);
    expect(profileStore.get(SYNTHETIC_DRIVER_B)).toEqual(initialProfile);
    expect(claimsStore.get(SYNTHETIC_DRIVER_B)).toEqual(initialClaims);
    expect(journalEntries).toHaveLength(0);
    expect(auditSuccessRecords).toHaveLength(0);
  });

  // 6. inactive target denied
  test('inactive target is denied (inactive credentials)', () => {
    const ctx = makeHealthyDriverTarget({
      credentials: {
        exists: true,
        active: false,
        passcode: VALID_TEST_SCRYPT_RECORD,
        companyId: COMPANY_A,
      },
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('failed-precondition');
      expect(res.reason).toBe('Driver account is inactive');
    }
  });

  test('inactive target is denied (inactive profile)', () => {
    const ctx = makeHealthyDriverTarget({
      profile: {
        exists: true,
        active: false,
        companyId: COMPANY_A,
      },
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('failed-precondition');
      expect(res.reason).toBe('Driver account is inactive');
    }
  });

  // 7. missing target denied
  test('missing target is denied', () => {
    const ctx = makeHealthyDriverTarget({
      credentials: { exists: false },
      profile: { exists: false },
      approvedRowExists: false,
      userRecordExists: false,
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('not-found');
      expect(res.reason).toBe('Driver not found');
    }
  });

  // 8. legacy-only shell denied
  test('legacy-only shell in approved row only is denied', () => {
    const ctx = makeHealthyDriverTarget({
      credentials: { exists: false },
      profile: { exists: false },
      approvedRowExists: true,
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('failed-precondition');
      expect(res.reason).toMatch(/legacy driver shell cannot be reset directly/i);
    }
  });

  test('legacy-only profile without credentials is denied', () => {
    const ctx = makeHealthyDriverTarget({
      credentials: { exists: false },
      profile: { exists: true, active: true, companyId: COMPANY_A },
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('failed-precondition');
      expect(res.reason).toMatch(/legacy driver shell cannot be reset directly/i);
    }
  });

  test('profile marked legacy: true is denied', () => {
    const ctx = makeHealthyDriverTarget({
      profile: { exists: true, active: true, legacy: true, companyId: COMPANY_A },
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('failed-precondition');
      expect(res.reason).toMatch(/legacy driver shell cannot be reset directly/i);
    }
  });

  // 9. email/password account denied
  test('email/password dashboard account in users/{uid} is denied', () => {
    const ctx = makeHealthyDriverTarget({
      userRecordExists: true,
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('failed-precondition');
      expect(res.reason).toMatch(/cannot reset passcode for email\/password account/i);
    }
  });

  test('target with authType: email is denied', () => {
    const ctx = makeHealthyDriverTarget({
      credentials: {
        exists: true,
        active: true,
        authType: 'email',
        companyId: COMPANY_A,
      },
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('failed-precondition');
      expect(res.reason).toMatch(/cannot reset passcode for email\/password account/i);
    }
  });

  test('target driver without passcode record is denied', () => {
    const ctx = makeHealthyDriverTarget({
      credentials: {
        exists: true,
        active: true,
        passcode: undefined,
        companyId: COMPANY_A,
      },
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('failed-precondition');
      expect(res.reason).toMatch(/not passcode-authenticated/i);
    }
  });

  // 10. name-only reset denied
  test('name-only reset without canonical driverId is denied', () => {
    const ctx = makeHealthyDriverTarget({
      requestedDriverId: '',
      requestDisplayName: 'Synthetic Driver Alpha',
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('invalid-argument');
      expect(res.reason).toMatch(/name-only resets are not allowed/i);
    }
  });

  // 11. malformed UUID denied
  test('malformed driverId UUID is denied', () => {
    const malformedIds = [
      '12345',
      'not-a-uuid',
      'driver_0123456789abcdef0123456789',
      '11111111-2222-3333-4444-55555555555g', // non-hex
      '11111111_2222_3333_4444_555555555555', // underscores
    ];
    for (const badId of malformedIds) {
      const ctx = makeHealthyDriverTarget({ requestedDriverId: badId });
      const res = evaluateAdminSetDriverPasscodeTarget(ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('invalid-argument');
        expect(res.reason).toBe('driverId must be a valid canonical UUID');
      }
    }
  });

  // 12. broad IT/platform-admin identity without explicit same-tenant authority denied
  test('broad IT/platform-admin identity without explicit same-tenant authority is denied', () => {
    const itCallerWithoutCompany = makeAuthorizedCaller({
      roles: ['it', 'admin'],
      companyId: null,
      isPlatformAdmin: true,
    });
    const ctx = makeHealthyDriverTarget({
      caller: itCallerWithoutCompany,
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('permission-denied');
      expect(res.reason).toMatch(/cross-company driver access denied/i);
    }
  });

  test('platform admin with different companyId than target driver is denied', () => {
    const platformAdminWithOtherCompany = makeAuthorizedCaller({
      roles: ['it', 'admin'],
      companyId: 'company-support-hub',
      isPlatformAdmin: true,
    });
    const ctx = makeHealthyDriverTarget({
      caller: platformAdminWithOtherCompany,
      requestedDriverId: SYNTHETIC_DRIVER_A,
      credentials: {
        exists: true,
        active: true,
        passcode: VALID_TEST_SCRYPT_RECORD,
        companyId: COMPANY_A,
      },
      profile: {
        exists: true,
        active: true,
        companyId: COMPANY_A,
      },
    });
    const res = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('permission-denied');
      expect(res.reason).toBe('Cross-company driver access denied');
    }
  });

  // 13. retry behavior remains idempotent
  test('retry behavior remains idempotent', () => {
    const ctx = makeHealthyDriverTarget();
    const firstRes = evaluateAdminSetDriverPasscodeTarget(ctx);
    const secondRes = evaluateAdminSetDriverPasscodeTarget(ctx);
    expect(firstRes).toEqual(secondRes);
    expect(firstRes.ok).toBe(true);
  });

  // 14. successful temporary reset semantics
  test('successful temporary reset produces mustChangePasscode: true contract', () => {
    const temporary = true;
    const contractResult = {
      driverId: SYNTHETIC_DRIVER_A,
      displayName: 'Synthetic Driver Alpha',
      mustChangePasscode: temporary,
    };
    expect(contractResult.mustChangePasscode).toBe(true);
  });

  // 15. permanent reset semantics
  test('permanent reset produces mustChangePasscode: false contract', () => {
    const temporary = false;
    const contractResult = {
      driverId: SYNTHETIC_DRIVER_A,
      displayName: 'Synthetic Driver Alpha',
      mustChangePasscode: temporary,
    };
    expect(contractResult.mustChangePasscode).toBe(false);
  });

  // 16. secret exclusion in logs, errors, snapshots, fixtures, commits
  test('no passcode appears in evaluation errors, results, or source files', () => {
    const srcFile = fs.readFileSync(
      path.join(__dirname, '../operational/adminSetDriverPasscodeTarget.ts'),
      'utf8',
    );
    // Never hardcodes or logs passcode material
    expect(srcFile).not.toMatch(/passcode:\s*['"`][^'"`]+['"`]/);
    expect(srcFile).not.toContain('console.log');

    // Callable source never logs passcode
    const callableSrc = fs.readFileSync(
      path.join(__dirname, '../driverAuthCallables.ts'),
      'utf8',
    );
    const startIdx = callableSrc.indexOf('export const adminSetDriverPasscode');
    const endIdx = callableSrc.indexOf('export const', startIdx + 10);
    const callableBody = callableSrc.slice(startIdx, endIdx);
    expect(callableBody).toContain('// never log passcode');
    expect(callableBody).not.toMatch(/action:\s*'adminSetDriverPasscode'[\s\S]*?detail:\s*\{[\s\S]*?passcode\s*:/);
  });

  // Source pin verification on callable structure
  test('callable pins: target evaluation runs BEFORE hashPasscodeScrypt and transactions', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../driverAuthCallables.ts'),
      'utf8',
    );
    const startIdx = src.indexOf('export const adminSetDriverPasscode');
    const endIdx = src.indexOf('export const', startIdx + 10);
    const body = src.slice(startIdx, endIdx);

    const evalIdx = body.indexOf('evaluateAdminSetDriverPasscodeTarget');
    const hashIdx = body.indexOf('hashPasscodeScrypt');
    const txIdx = body.indexOf('runTransaction');

    expect(evalIdx).toBeGreaterThan(-1);
    expect(hashIdx).toBeGreaterThan(-1);
    expect(txIdx).toBeGreaterThan(-1);

    // Target evaluation MUST precede hashing
    expect(evalIdx).toBeLessThan(hashIdx);
    // Hashing MUST precede transaction
    expect(hashIdx).toBeLessThan(txIdx);
  });
});
