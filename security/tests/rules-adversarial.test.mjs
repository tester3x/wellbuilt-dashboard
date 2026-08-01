/**
 * Adversarial rules tests against secure rule drafts (emulator).
 * Does NOT use production rules. Requires:
 *   firebase emulators:exec --only firestore,database,storage --project demo-wb-sec "node security/tests/rules-adversarial.test.mjs"
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { ref, get, set } from 'firebase/database';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { ref as sref, uploadString, getDownloadURL } from 'firebase/storage';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const PROJECT_ID = 'demo-wb-sec';

let passed = 0;
let failed = 0;
function ok(name) {
  passed++;
  console.log(`  PASS  ${name}`);
}
function fail(name, err) {
  failed++;
  console.error(`  FAIL  ${name}:`, err?.message || err);
}

async function main() {
  console.log('\n=== SECURE RULES ADVERSARIAL TESTS ===\n');

  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(resolve(root, 'firestore.rules.secure'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
    database: {
      rules: readFileSync(resolve(root, 'database.rules.secure.json'), 'utf8'),
      host: '127.0.0.1',
      port: 9000,
    },
    storage: {
      rules: readFileSync(resolve(root, 'storage.rules.secure'), 'utf8'),
      host: '127.0.0.1',
      port: 9199,
    },
  });

  // Seed via admin (bypass rules)
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await set(ref(db, 'drivers/approved/legacyhash1'), {
      displayName: 'SeedDriver',
      active: true,
    });
    await set(ref(db, 'drivers/profiles/driver-a'), {
      displayName: 'DriverA',
      companyId: 'co-a',
    });
    await set(ref(db, 'drivers/profiles/driver-b'), {
      displayName: 'DriverB',
      companyId: 'co-b',
    });
    await set(ref(db, 'users/admin1'), { role: 'admin', displayName: 'Admin' });
    await set(ref(db, 'users/driver-user'), { role: 'driver' });
  });

  // 1 Anonymous RTDB root/shallow equivalent
  {
    const unauth = testEnv.unauthenticatedContext();
    try {
      await assertFails(get(ref(unauth.database(), 'drivers')));
      ok('anonymous RTDB drivers read denied');
    } catch (e) {
      fail('anonymous RTDB drivers read denied', e);
    }
  }

  // 2 Anonymous approved read
  {
    const unauth = testEnv.unauthenticatedContext();
    try {
      await assertFails(get(ref(unauth.database(), 'drivers/approved/legacyhash1')));
      ok('anonymous drivers/approved read denied');
    } catch (e) {
      fail('anonymous drivers/approved read denied', e);
    }
  }

  // 3 Anonymous pending write
  {
    const unauth = testEnv.unauthenticatedContext();
    try {
      await assertFails(
        set(ref(unauth.database(), 'drivers/pending/spam1'), {
          displayName: 'bot',
          passcodeHash: 'abc',
        }),
      );
      ok('anonymous drivers/pending write denied');
    } catch (e) {
      fail('anonymous drivers/pending write denied', e);
    }
  }

  // 4 Anonymous self-approve write
  {
    const unauth = testEnv.unauthenticatedContext();
    try {
      await assertFails(
        set(ref(unauth.database(), 'drivers/approved/evil'), {
          displayName: 'Hacker',
          active: true,
        }),
      );
      ok('anonymous self-approve denied');
    } catch (e) {
      fail('anonymous self-approve denied', e);
    }
  }

  // 5 Driver cannot write approved
  {
    const driver = testEnv.authenticatedContext('drv1', {
      kind: 'driver',
      driverId: 'driver-a',
    });
    try {
      await assertFails(
        set(ref(driver.database(), 'drivers/approved/x'), { displayName: 'nope' }),
      );
      ok('authenticated driver cannot write drivers/approved');
    } catch (e) {
      fail('authenticated driver cannot write drivers/approved', e);
    }
  }

  // 6 Driver can read own profile, not peer
  {
    const driver = testEnv.authenticatedContext('drv1', {
      kind: 'driver',
      driverId: 'driver-a',
    });
    try {
      await assertSucceeds(get(ref(driver.database(), 'drivers/profiles/driver-a')));
      ok('driver reads own profile');
    } catch (e) {
      fail('driver reads own profile', e);
    }
    try {
      await assertFails(get(ref(driver.database(), 'drivers/profiles/driver-b')));
      ok('driver cannot read peer profile');
    } catch (e) {
      fail('driver cannot read peer profile', e);
    }
  }

  // 7 Driver cannot elevate isAdmin via profile write
  {
    const driver = testEnv.authenticatedContext('drv1', {
      kind: 'driver',
      driverId: 'driver-a',
    });
    try {
      await assertFails(
        set(ref(driver.database(), 'drivers/profiles/driver-a/isAdmin'), true),
      );
      ok('driver cannot write profile isAdmin');
    } catch (e) {
      fail('driver cannot write profile isAdmin', e);
    }
  }

  // 8 Firestore credential collections deny all clients
  {
    const unauth = testEnv.unauthenticatedContext();
    const adminCtx = testEnv.authenticatedContext('admin1', { kind: 'dashboard' });
    try {
      await assertFails(getDoc(doc(unauth.firestore(), 'driver_credentials/x')));
      ok('unauth cannot read driver_credentials');
    } catch (e) {
      fail('unauth cannot read driver_credentials', e);
    }
    try {
      await assertFails(getDoc(doc(adminCtx.firestore(), 'driver_credentials/x')));
      ok('even authed client cannot read driver_credentials');
    } catch (e) {
      fail('even authed client cannot read driver_credentials', e);
    }
  }

  // 9 Anonymous Firestore invoice write denied under secure rules
  {
    const unauth = testEnv.unauthenticatedContext();
    try {
      await assertFails(
        setDoc(doc(unauth.firestore(), 'invoices/inv1'), { n: 1 }),
      );
      ok('anonymous Firestore invoices write denied');
    } catch (e) {
      fail('anonymous Firestore invoices write denied', e);
    }
  }

  // 10 Storage anonymous write denied
  {
    const unauth = testEnv.unauthenticatedContext();
    try {
      await assertFails(
        uploadString(sref(unauth.storage(), 'photos/co/x.jpg'), 'data'),
      );
      ok('anonymous Storage photo write denied');
    } catch (e) {
      fail('anonymous Storage photo write denied', e);
    }
  }

  // 11 Storage signed-in can write photos path when company claim matches
  {
    const user = testEnv.authenticatedContext('u1', {
      kind: 'driver',
      driverId: 'driver-a',
      companyId: 'co',
    });
    try {
      await assertSucceeds(
        uploadString(sref(user.storage(), 'photos/co/inv1/x.jpg'), 'fake', 'raw', {
          contentType: 'image/jpeg',
        }),
      );
      ok('signed-in Storage photo write allowed under secure draft');
    } catch (e) {
      fail('signed-in Storage photo write allowed under secure draft', e);
    }
  }
  // 12 Cross-company photo path denied
  {
    const user = testEnv.authenticatedContext('u2', {
      kind: 'driver',
      driverId: 'driver-a',
      companyId: 'co-a',
    });
    try {
      await assertFails(
        uploadString(sref(user.storage(), 'photos/co-b/inv1/x.jpg'), 'fake', 'raw', {
          contentType: 'image/jpeg',
        }),
      );
      ok('cross-company Storage photo write denied');
    } catch (e) {
      fail('cross-company Storage photo write denied', e);
    }
  }

  await testEnv.cleanup();

  console.log(`\nRules results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
