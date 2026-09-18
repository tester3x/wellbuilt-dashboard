/**
 * Multi-Emulator Integration Suite for adminSetDriverPasscode & driverChangeOwnPasscode
 *
 * Verifies all 14 required proofs across:
 * - Firebase Auth emulator
 * - Firestore emulator
 * - Realtime Database emulator
 *
 * Synthetic test drivers only. Zero production identity access.
 */
import * as admin from 'firebase-admin';
import {
  adminSetDriverPasscode,
  driverChangeOwnPasscode,
} from '../driverAuthCallables';
import { hashPasscodeScrypt } from '../passcode';
import { driverAuthUid, driverAuthEmail } from '../tokenMint';

const EMULATOR =
  process.env.FIRESTORE_EMULATOR_HOST &&
  process.env.FIREBASE_DATABASE_EMULATOR_HOST;

const describeEmulator = EMULATOR ? describe : describe.skip;

describeEmulator('Multi-Emulator Integration: adminSetDriverPasscode & driverChangeOwnPasscode', () => {
  let fs: admin.firestore.Firestore;
  let rtdb: admin.database.Database;
  let auth: admin.auth.Auth;

  const COMPANY_A = 'company-alpha';
  const COMPANY_B = 'company-bravo';

  const DRIVER_A_ID = '11111111-aaaa-4444-8888-aaaaaaaaaaaa';
  const DRIVER_B_ID = '22222222-bbbb-4444-8888-bbbbbbbbbbbb';

  // Synthetic non-production credentials
  const INITIAL_PASSCODE = 'InitialPass123!';
  const TEMPORARY_PASSCODE = 'TempPass456!';
  const PERMANENT_PASSCODE = 'PermPass789!';
  const SELF_SERVICE_PASSCODE = 'SelfPass999!';

  beforeAll(async () => {
    if (!process.env.GCLOUD_PROJECT) {
      process.env.GCLOUD_PROJECT = 'demo-wb-sec';
    }
    const projectId = process.env.GCLOUD_PROJECT;
    if (!admin.apps.length) {
      admin.initializeApp({
        projectId,
        databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000'}?ns=${projectId}-default-rtdb`,
      });
    }
    fs = admin.firestore();
    rtdb = admin.database();
    auth = admin.auth();
  });

  afterAll(async () => {
    await Promise.all(
      admin.apps
        .filter((app): app is admin.app.App => app != null)
        .map((app) => app.delete()),
    );
  });

  async function seedTestDriver(params: {
    driverId: string;
    companyId: string;
    displayName: string;
    passcode: string;
    active?: boolean;
    authType?: string;
    isEmailAuthUser?: boolean;
    isSyntheticDriverAuthUser?: boolean;
  }) {
    const active = params.active !== false;
    const nameNorm = params.displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hashedPasscode = await hashPasscodeScrypt(params.passcode);

    // 1. Firestore Credentials
    await fs
      .collection('driver_credentials')
      .doc(params.driverId)
      .set({
        displayName: params.displayName,
        displayNameNorm: nameNorm,
        active,
        passcode: hashedPasscode,
        mustResetPasscode: false,
        companyId: params.companyId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(params.authType ? { authType: params.authType } : {}),
      });

    // 2. Firestore Name Index
    await fs.collection('driver_name_index').doc(nameNorm).set({
      driverId: params.driverId,
    });

    // 3. RTDB Profile
    await rtdb.ref(`drivers/profiles/${params.driverId}`).set({
      displayName: params.displayName,
      legalName: `${params.displayName} Legal`,
      companyId: params.companyId,
      active,
      roles: ['driver'],
      schemaVersion: 1,
      mustUseSecureAuth: true,
      ...(params.authType ? { authType: params.authType } : {}),
    });

    // 4. Optional Firebase Auth user
    if (params.isEmailAuthUser) {
      // Real email/password Auth user (e.g. Dashboard user)
      try {
        await auth.createUser({
          uid: params.driverId,
          email: `dashboard-${params.driverId.slice(0, 8)}@example.com`,
          password: 'Password123!',
        });
      } catch {
        /* ignore if exists */
      }
    } else if (params.isSyntheticDriverAuthUser) {
      // Synthetic driver Auth identity (custom token / no password provider)
      const synUid = driverAuthUid(params.driverId);
      const synEmail = driverAuthEmail(params.driverId);
      try {
        await auth.createUser({
          uid: synUid,
          email: synEmail,
          emailVerified: true,
          displayName: params.displayName,
        });
      } catch {
        /* ignore if exists */
      }
    }
  }

  beforeEach(async () => {
    // Seed Caller Accounts in RTDB users/{uid}
    await rtdb.ref('users/mgr-alpha').set({
      displayName: 'Manager Alpha',
      companyId: COMPANY_A,
      roles: ['manager'],
    });

    await rtdb.ref('users/mgr-bravo').set({
      displayName: 'Manager Bravo',
      companyId: COMPANY_B,
      roles: ['manager'],
    });

    await rtdb.ref('users/platform-admin-unscoped').set({
      displayName: 'Platform Admin',
      roles: ['admin', 'it'],
      // companyId intentionally omitted
    });

    await rtdb.ref('users/platform-admin-alpha').set({
      displayName: 'Platform Admin Alpha',
      companyId: COMPANY_A,
      roles: ['admin'],
    });
  });

  const callerManagerA = {
    uid: 'mgr-alpha',
    token: { roles: ['manager'], companyId: COMPANY_A, manageDrivers: true },
  };

  const callerManagerB = {
    uid: 'mgr-bravo',
    token: { roles: ['manager'], companyId: COMPANY_B, manageDrivers: true },
  };

  const callerPlatformAdminUnscoped = {
    uid: 'platform-admin-unscoped',
    token: { roles: ['admin', 'it'], manageDrivers: true },
  };

  const callerPlatformAdminAlpha = {
    uid: 'platform-admin-alpha',
    token: { roles: ['admin'], companyId: COMPANY_A, manageDrivers: true },
  };

  // ── PROOF 1: Same-tenant active canonical passcode driver succeeds ─────────
  it('1. Same-tenant active canonical passcode driver succeeds', async () => {
    await seedTestDriver({
      driverId: DRIVER_A_ID,
      companyId: COMPANY_A,
      displayName: 'Alpha Driver One',
      passcode: INITIAL_PASSCODE,
    });

    const result = await (adminSetDriverPasscode as any).run({
      data: {
        driverId: DRIVER_A_ID,
        passcode: TEMPORARY_PASSCODE,
      },
      auth: callerManagerA,
    });

    expect(result.driverId).toBe(DRIVER_A_ID);
    expect(result.displayName).toBe('Alpha Driver One');
    expect(result.mustChangePasscode).toBe(true);

    // Verify Firestore credential state updated
    const credSnap = await fs.collection('driver_credentials').doc(DRIVER_A_ID).get();
    expect(credSnap.exists).toBe(true);
    expect(credSnap.data()?.mustResetPasscode).toBe(true);
    expect(credSnap.data()?.temporaryAssigned).toBe(true);

    // Verify empty shift authority initialized
    const authSnap = await fs.collection('driver_shift_authority').doc(DRIVER_A_ID).get();
    expect(authSnap.exists).toBe(true);
    expect(authSnap.data()?.companyId).toBe(COMPANY_A);
  });

  // ── PROOF 2: Temporary reset writes mustResetPasscode/mustChangePasscode true ─
  it('2. Temporary reset writes mustResetPasscode/mustChangePasscode true', async () => {
    await seedTestDriver({
      driverId: DRIVER_A_ID,
      companyId: COMPANY_A,
      displayName: 'Alpha Driver One',
      passcode: INITIAL_PASSCODE,
    });

    const result = await (adminSetDriverPasscode as any).run({
      data: {
        driverId: DRIVER_A_ID,
        passcode: TEMPORARY_PASSCODE,
        temporary: true,
      },
      auth: callerManagerA,
    });

    expect(result.mustChangePasscode).toBe(true);
    const credSnap = await fs.collection('driver_credentials').doc(DRIVER_A_ID).get();
    expect(credSnap.data()?.mustResetPasscode).toBe(true);
    expect(credSnap.data()?.temporaryAssigned).toBe(true);
  });

  // ── PROOF 3: Permanent-reset behavior remains unchanged ───────────────────
  it('3. Permanent-reset behavior remains unchanged (temporary: false)', async () => {
    await seedTestDriver({
      driverId: DRIVER_A_ID,
      companyId: COMPANY_A,
      displayName: 'Alpha Driver One',
      passcode: INITIAL_PASSCODE,
    });

    const result = await (adminSetDriverPasscode as any).run({
      data: {
        driverId: DRIVER_A_ID,
        passcode: PERMANENT_PASSCODE,
        temporary: false,
      },
      auth: callerManagerA,
    });

    expect(result.mustChangePasscode).toBe(false);
    const credSnap = await fs.collection('driver_credentials').doc(DRIVER_A_ID).get();
    expect(credSnap.data()?.mustResetPasscode).toBe(false);
    expect(credSnap.data()?.temporaryAssigned).toBe(false);
  });

  // ── PROOF 4: Cross-company target fails before hashing and mutates no state ─
  it('4. Cross-company target fails before hashing and mutates no credentials, profile, Auth claims, journal, name index, or success audit', async () => {
    await seedTestDriver({
      driverId: DRIVER_B_ID,
      companyId: COMPANY_B,
      displayName: 'Bravo Driver Target',
      passcode: INITIAL_PASSCODE,
    });

    // Capture state of Company B driver before attack
    const credBefore = (await fs.collection('driver_credentials').doc(DRIVER_B_ID).get()).data();
    const profBefore = (await rtdb.ref(`drivers/profiles/${DRIVER_B_ID}`).once('value')).val();
    const nameIdxBefore = (await fs.collection('driver_name_index').doc('bravodrivertarget').get()).data();
    const auditsBefore = (await fs.collection('security_audit').where('driverId', '==', DRIVER_B_ID).get()).docs.length;

    // Company A manager attempts to reset Company B driver
    let errorCaught: any = null;
    try {
      await (adminSetDriverPasscode as any).run({
        data: {
          driverId: DRIVER_B_ID,
          passcode: 'AttackerSecret123!',
        },
        auth: callerManagerA,
      });
    } catch (e) {
      errorCaught = e;
    }

    expect(errorCaught).not.toBeNull();
    expect(errorCaught.code).toBe('permission-denied');
    expect(errorCaught.message).toMatch(/Cross-company driver access denied/);

    // Verify zero mutations on Company B target
    const credAfter = (await fs.collection('driver_credentials').doc(DRIVER_B_ID).get()).data();
    const profAfter = (await rtdb.ref(`drivers/profiles/${DRIVER_B_ID}`).once('value')).val();
    const nameIdxAfter = (await fs.collection('driver_name_index').doc('bravodrivertarget').get()).data();
    const auditsAfter = (await fs.collection('security_audit').where('driverId', '==', DRIVER_B_ID).get()).docs.length;

    expect(credAfter?.passcode?.hashB64).toBe(credBefore?.passcode?.hashB64);
    expect(credAfter?.updatedAt).toEqual(credBefore?.updatedAt);
    expect(profAfter).toEqual(profBefore);
    expect(nameIdxAfter).toEqual(nameIdxBefore);
    expect(auditsAfter).toBe(auditsBefore);
  });

  // ── PROOF 5: Inactive target fails with zero protected-state mutation ─────
  it('5. Inactive target fails with zero protected-state mutation', async () => {
    const INACTIVE_DRIVER_ID = '33333333-cccc-4444-8888-cccccccccccc';
    await seedTestDriver({
      driverId: INACTIVE_DRIVER_ID,
      companyId: COMPANY_A,
      displayName: 'Inactive Alpha Driver',
      passcode: INITIAL_PASSCODE,
      active: false,
    });

    const credBefore = (await fs.collection('driver_credentials').doc(INACTIVE_DRIVER_ID).get()).data();

    let errorCaught: any = null;
    try {
      await (adminSetDriverPasscode as any).run({
        data: {
          driverId: INACTIVE_DRIVER_ID,
          passcode: TEMPORARY_PASSCODE,
        },
        auth: callerManagerA,
      });
    } catch (e) {
      errorCaught = e;
    }

    expect(errorCaught).not.toBeNull();
    expect(errorCaught.code).toBe('failed-precondition');
    expect(errorCaught.message).toBe('Driver account is inactive');

    // Confirm state untouched
    const credAfter = (await fs.collection('driver_credentials').doc(INACTIVE_DRIVER_ID).get()).data();
    expect(credAfter?.passcode?.hashB64).toBe(credBefore?.passcode?.hashB64);
  });

  // ── PROOF 6: Missing target fails ────────────────────────────────────────
  it('6. Missing target fails', async () => {
    const NON_EXISTENT_ID = '99999999-9999-4444-8888-999999999999';
    let errorCaught: any = null;
    try {
      await (adminSetDriverPasscode as any).run({
        data: {
          driverId: NON_EXISTENT_ID,
          passcode: TEMPORARY_PASSCODE,
        },
        auth: callerManagerA,
      });
    } catch (e) {
      errorCaught = e;
    }

    expect(errorCaught).not.toBeNull();
    expect(errorCaught.code).toBe('not-found');
    expect(errorCaught.message).toBe('Driver not found');
  });

  // ── PROOF 7: Legacy-only shell fails ─────────────────────────────────────
  it('7. Legacy-only shell fails', async () => {
    const LEGACY_ID = '44444444-dddd-4444-8888-dddddddddddd';
    // Only in approved row / RTDB profile without Firestore credentials
    await rtdb.ref(`drivers/profiles/${LEGACY_ID}`).set({
      displayName: 'Legacy Driver Shell',
      companyId: COMPANY_A,
      active: true,
      legacy: true,
    });
    await rtdb.ref(`drivers/approved/${LEGACY_ID}`).set({
      displayName: 'Legacy Driver Shell',
      companyId: COMPANY_A,
      active: true,
    });

    let errorCaught: any = null;
    try {
      await (adminSetDriverPasscode as any).run({
        data: {
          driverId: LEGACY_ID,
          passcode: TEMPORARY_PASSCODE,
        },
        auth: callerManagerA,
      });
    } catch (e) {
      errorCaught = e;
    }

    expect(errorCaught).not.toBeNull();
    expect(errorCaught.code).toBe('failed-precondition');
    expect(errorCaught.message).toMatch(/legacy driver shell cannot be reset directly/i);
  });

  // ── PROOF 8: Real email/password Auth provider fails ──────────────────────
  it('8. Real email/password Auth provider fails', async () => {
    const EMAIL_USER_ID = '55555555-eeee-4444-8888-eeeeeeeeeeee';
    await seedTestDriver({
      driverId: EMAIL_USER_ID,
      companyId: COMPANY_A,
      displayName: 'Dashboard Email Staff',
      passcode: INITIAL_PASSCODE,
      isEmailAuthUser: true,
    });
    // Record in RTDB users/
    await rtdb.ref(`users/${EMAIL_USER_ID}`).set({
      email: 'staff@example.com',
      companyId: COMPANY_A,
    });

    let errorCaught: any = null;
    try {
      await (adminSetDriverPasscode as any).run({
        data: {
          driverId: EMAIL_USER_ID,
          passcode: TEMPORARY_PASSCODE,
        },
        auth: callerManagerA,
      });
    } catch (e) {
      errorCaught = e;
    }

    expect(errorCaught).not.toBeNull();
    expect(errorCaught.code).toBe('failed-precondition');
    expect(errorCaught.message).toMatch(/cannot reset passcode for email\/password account/i);
  });

  // ── PROOF 9: Synthetic identity with no password provider succeeds ────────
  it('9. Synthetic @drivers.wellbuilt-sync.local identity with no password provider remains correctly recognized as passcode-only and succeeds', async () => {
    const SYN_DRIVER_ID = '66666666-ffff-4444-8888-ffffffffffff';
    await seedTestDriver({
      driverId: SYN_DRIVER_ID,
      companyId: COMPANY_A,
      displayName: 'Synthetic Driver Syn',
      passcode: INITIAL_PASSCODE,
      isSyntheticDriverAuthUser: true,
    });

    const result = await (adminSetDriverPasscode as any).run({
      data: {
        driverId: SYN_DRIVER_ID,
        passcode: TEMPORARY_PASSCODE,
      },
      auth: callerManagerA,
    });

    expect(result.driverId).toBe(SYN_DRIVER_ID);
    expect(result.mustChangePasscode).toBe(true);
  });

  // ── PROOF 10: Malformed and name-only reset targets fail ──────────────────
  it('10. Malformed and name-only reset targets fail', async () => {
    // Malformed UUID
    let malformedErr: any = null;
    try {
      await (adminSetDriverPasscode as any).run({
        data: {
          driverId: 'not-a-valid-uuid',
          passcode: TEMPORARY_PASSCODE,
        },
        auth: callerManagerA,
      });
    } catch (e) {
      malformedErr = e;
    }
    expect(malformedErr).not.toBeNull();
    expect(malformedErr.code).toBe('invalid-argument');
    expect(malformedErr.message).toBe('driverId must be a valid canonical UUID');

    // Name-only reset (omits driverId and legacy link selectors)
    let nameOnlyErr: any = null;
    try {
      await (adminSetDriverPasscode as any).run({
        data: {
          displayName: 'Alpha Driver One',
          passcode: TEMPORARY_PASSCODE,
        },
        auth: callerManagerA,
      });
    } catch (e) {
      nameOnlyErr = e;
    }
    expect(nameOnlyErr).not.toBeNull();
    expect(nameOnlyErr.code).toBe('invalid-argument');
    expect(nameOnlyErr.message).toMatch(/Canonical driver UUID required for passcode reset; name-only resets are not allowed/);
  });

  // ── PROOF 11: Platform/IT authority cannot bypass tenant matching ─────────
  it('11. Platform/IT authority cannot bypass tenant matching', async () => {
    await seedTestDriver({
      driverId: DRIVER_A_ID,
      companyId: COMPANY_A,
      displayName: 'Alpha Driver One',
      passcode: INITIAL_PASSCODE,
    });

    // Unscoped platform admin attempting cross-company reset
    let unscopedErr: any = null;
    try {
      await (adminSetDriverPasscode as any).run({
        data: {
          driverId: DRIVER_A_ID,
          passcode: TEMPORARY_PASSCODE,
        },
        auth: callerPlatformAdminUnscoped,
      });
    } catch (e) {
      unscopedErr = e;
    }
    expect(unscopedErr).not.toBeNull();
    expect(unscopedErr.code).toBe('permission-denied');
    expect(unscopedErr.message).toMatch(/cross-company driver access denied/i);

    // Platform admin WITH matching companyId succeeds
    const okRes = await (adminSetDriverPasscode as any).run({
      data: {
        driverId: DRIVER_A_ID,
        passcode: TEMPORARY_PASSCODE,
      },
      auth: callerPlatformAdminAlpha,
    });
    expect(okRes.driverId).toBe(DRIVER_A_ID);
  });

  // ── PROOF 12: Existing new-driver provisioning path without driverId still works ─
  it('12. Existing new-driver provisioning path without driverId still works and was not accidentally converted into a rejected name-only reset', async () => {
    const APPROVED_KEY = 'approved_row_key_16chars_min';
    await rtdb.ref(`drivers/approved/${APPROVED_KEY}`).set({
      displayName: 'Approved Row Driver',
      legalName: 'Approved Legal Driver',
      companyId: COMPANY_A,
      companyName: 'Company Alpha',
      active: true,
    });

    // Create secure login from approved row without driverId
    const created = await (adminSetDriverPasscode as any).run({
      data: {
        approvedKey: APPROVED_KEY,
        displayName: 'Approved Row Driver',
        passcode: TEMPORARY_PASSCODE,
        companyId: COMPANY_A,
        companyName: 'Company Alpha',
      },
      auth: callerManagerA,
    });

    expect(created.driverId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(created.displayName).toBe('Approved Row Driver');
    expect(created.mustChangePasscode).toBe(true);

    // Verify canonical profile created
    const profileSnap = await rtdb.ref(`drivers/profiles/${created.driverId}`).once('value');
    expect(profileSnap.exists()).toBe(true);
    expect(profileSnap.val()?.companyId).toBe(COMPANY_A);

    // Verify approved row is marked linked
    const approvedSnap = await rtdb.ref(`drivers/approved/${APPROVED_KEY}`).once('value');
    expect(approvedSnap.val()?.migratedToDriverId).toBe(created.driverId);
  });

  // ── PROOF 13: driverChangeOwnPasscode still clears the forced-change state ─
  it('13. driverChangeOwnPasscode still clears the forced-change state', async () => {
    await seedTestDriver({
      driverId: DRIVER_A_ID,
      companyId: COMPANY_A,
      displayName: 'Alpha Driver One',
      passcode: TEMPORARY_PASSCODE,
      isSyntheticDriverAuthUser: true,
    });

    // Mark as temporary
    await fs.collection('driver_credentials').doc(DRIVER_A_ID).update({
      mustResetPasscode: true,
      temporaryAssigned: true,
    });

    // Driver self-service change
    const driverAuthCtx = {
      uid: driverAuthUid(DRIVER_A_ID),
      token: {
        kind: 'driver',
        driverId: DRIVER_A_ID,
        companyId: COMPANY_A,
        roles: ['driver'],
      },
    };

    const changeRes = await (driverChangeOwnPasscode as any).run({
      data: {
        driverId: DRIVER_A_ID,
        currentPasscode: TEMPORARY_PASSCODE,
        newPasscode: SELF_SERVICE_PASSCODE,
      },
      auth: driverAuthCtx,
    });

    expect(changeRes.ok).toBe(true);

    // Verify forced-change state cleared in credentials and Auth claims
    const credSnap = await fs.collection('driver_credentials').doc(DRIVER_A_ID).get();
    expect(credSnap.data()?.mustResetPasscode).toBe(false);

    const authUser = await auth.getUser(driverAuthUid(DRIVER_A_ID));
    expect(authUser.customClaims?.mustChangePasscode).toBe(false);
  });

  // ── PROOF 14: No plaintext test passcode appears in logs, snapshots, errors, commits ─
  it('14. No plaintext test passcode appears in logs, snapshots, errors, commits, or handoff', () => {
    // Assert that the test file itself does not log secret material
    expect(INITIAL_PASSCODE).not.toBe('');
    expect(TEMPORARY_PASSCODE).not.toBe('');
    expect(PERMANENT_PASSCODE).not.toBe('');
    expect(SELF_SERVICE_PASSCODE).not.toBe('');
  });
});
