import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  ref,
  set,
  get,
  push,
  update,
  remove,
  query,
  orderByChild,
  equalTo,
} from 'firebase/database';

import {
  PROJECT_ID,
  DRIVER_HASH,
  OTHER_HASH,
  VALID_PENDING,
  PRIVILEGE_PENDING,
  VALID_PULL_PACKET,
  VALID_EDIT_PACKET,
  VALID_DELETE_PACKET,
} from './fixtures';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = resolve(__dirname, '../database.containment.json');

let testEnv: RulesTestEnvironment;

async function seedDashboardUser(
  uid: string,
  role: string,
  extra: Record<string, unknown> = {},
) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await set(ref(db, `users/${uid}`), {
      role,
      email: `${uid}@test.com`,
      displayName: uid,
      ...extra,
    });
  });
}

async function seedDriver(hash: string, data: Record<string, unknown>) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await set(ref(ctx.database(), `drivers/approved/${hash}`), data);
  });
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: {
      rules: readFileSync(RULES_PATH, 'utf8'),
      host: '127.0.0.1',
      port: 9000,
    },
  });
});

beforeEach(async () => {
  await testEnv.clearDatabase();
});

afterAll(async () => {
  await testEnv.cleanup();
});

describe('Root containment', () => {
  test('denies anonymous root read', async () => {
    const ctx = testEnv.unauthenticatedContext();
    await assertFails(get(ref(ctx.database(), '/')));
  });

  test('denies anonymous root write', async () => {
    const ctx = testEnv.unauthenticatedContext();
    await assertFails(set(ref(ctx.database(), 'rogue'), { x: 1 }));
  });

  test('denies unknown path access', async () => {
    const ctx = testEnv.unauthenticatedContext();
    await assertFails(get(ref(ctx.database(), 'rogue/path')));
    await assertFails(set(ref(ctx.database(), 'rogue/path'), { x: 1 }));
  });
});

describe('CF-only paths', () => {
  test('denies client access to truth, system_health, wells', async () => {
    const anon = testEnv.unauthenticatedContext();
    const admin = testEnv.authenticatedContext('admin-1');
    await seedDashboardUser('admin-1', 'admin');

    for (const path of [
      'truth_overrides/location_approvals/global/key1',
      'truth_reference/swd_catalog/key1',
      'system_health/overall',
      'wells/Gabriel1/status',
    ]) {
      await assertFails(get(ref(anon.database(), path)));
      await assertFails(set(ref(anon.database(), path), { x: 1 }));
      await assertFails(get(ref(admin.database(), path)));
      await assertFails(set(ref(admin.database(), path), { x: 1 }));
    }
  });
});

describe('users', () => {
  test('authenticated user reads and writes own record', async () => {
    await seedDashboardUser('user-1', 'viewer');
    const ctx = testEnv.authenticatedContext('user-1');
    const db = ctx.database();
    await assertSucceeds(get(ref(db, 'users/user-1')));
    await assertSucceeds(update(ref(db, 'users/user-1'), { displayName: 'Self' }));
  });

  test('manager can read users tree; viewer cannot', async () => {
    await seedDashboardUser('mgr-1', 'manager');
    await seedDashboardUser('viewer-1', 'viewer');
    await seedDashboardUser('other-uid', 'dispatch', { companyId: 'co1' });

    const mgr = testEnv.authenticatedContext('mgr-1');
    const viewer = testEnv.authenticatedContext('viewer-1');

    await assertSucceeds(get(ref(mgr.database(), 'users')));
    await assertFails(get(ref(viewer.database(), 'users')));
  });

  test('admin can update another user; viewer cannot', async () => {
    await seedDashboardUser('admin-1', 'admin');
    await seedDashboardUser('target-1', 'viewer');
    const admin = testEnv.authenticatedContext('admin-1');
    const viewer = testEnv.authenticatedContext('viewer-1');

    await assertSucceeds(update(ref(admin.database(), 'users/target-1'), { role: 'dispatch' }));
    await assertFails(update(ref(viewer.database(), 'users/target-1'), { role: 'dispatch' }));
  });
});

describe('drivers/approved', () => {
  test('anonymous can read own hash and full list (temporary exposure)', async () => {
    await seedDriver(DRIVER_HASH, { displayName: 'Mike S', active: true });
    const anon = testEnv.unauthenticatedContext();
    const db = anon.database();
    await assertSucceeds(get(ref(db, `drivers/approved/${DRIVER_HASH}`)));
    await assertSucceeds(get(ref(db, 'drivers/approved')));
  });

  test('anonymous can patch session fields on own hash', async () => {
    await seedDriver(DRIVER_HASH, { displayName: 'Mike S', active: true });
    const anon = testEnv.unauthenticatedContext();
    await assertSucceeds(update(ref(anon.database(), `drivers/approved/${DRIVER_HASH}`), {
      logoutAt: null,
      lastLoginAt: new Date().toISOString(),
    }));
  });
});

describe('drivers/pending', () => {
  test('anonymous can create valid pending registration', async () => {
    const anon = testEnv.unauthenticatedContext();
    const pendingRef = push(ref(anon.database(), 'drivers/pending'));
    await assertSucceeds(set(pendingRef, VALID_PENDING));
  });

  test('rejects privilege injection on pending create', async () => {
    const anon = testEnv.unauthenticatedContext();
    const badRef = push(ref(anon.database(), 'drivers/pending'));
    await assertFails(set(badRef, PRIVILEGE_PENDING));
  });

  test('anonymous cannot read pending queue', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await push(ref(ctx.database(), 'drivers/pending'), VALID_PENDING);
    });
    const anon = testEnv.unauthenticatedContext();
    await assertFails(get(ref(anon.database(), 'drivers/pending')));
  });

  test('manager can read and update pending status', async () => {
    await seedDashboardUser('mgr-1', 'manager');
    let pendingKey = '';
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const p = await push(ref(ctx.database(), 'drivers/pending'), VALID_PENDING);
      pendingKey = p.key!;
    });
    const mgr = testEnv.authenticatedContext('mgr-1');
    await assertSucceeds(get(ref(mgr.database(), 'drivers/pending')));
    await assertSucceeds(update(ref(mgr.database(), `drivers/pending/${pendingKey}`), {
      status: 'approved',
    }));
  });
});

describe('packets/incoming', () => {
  test('anonymous cannot read incoming queue', async () => {
    const anon = testEnv.unauthenticatedContext();
    await assertFails(get(ref(anon.database(), 'packets/incoming')));
  });

  test('anonymous can create pull, edit, delete packets', async () => {
    const anon = testEnv.unauthenticatedContext();
    const db = anon.database();
    await assertSucceeds(set(ref(db, 'packets/incoming/pull1'), VALID_PULL_PACKET));
    await assertSucceeds(set(ref(db, 'packets/incoming/edit1'), VALID_EDIT_PACKET));
    await assertSucceeds(set(ref(db, 'packets/incoming/delete1'), VALID_DELETE_PACKET));
  });

  test('rejects invalid packet schema and overwrites', async () => {
    const anon = testEnv.unauthenticatedContext();
    const db = anon.database();
    await assertFails(set(ref(db, 'packets/incoming/bad1'), { foo: 'bar' }));
    await assertSucceeds(set(ref(db, 'packets/incoming/once'), VALID_PULL_PACKET));
    await assertFails(set(ref(db, 'packets/incoming/once'), VALID_EDIT_PACKET));
  });
});

describe('packets/outgoing + processed', () => {
  test('anonymous can read outgoing listener root', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'packets/outgoing/response_1'), {
        wellName: 'Gabriel 1',
        currentLevel: "10'0\"",
      });
    });
    const anon = testEnv.unauthenticatedContext();
    await assertSucceeds(get(ref(anon.database(), 'packets/outgoing')));
    await assertFails(set(ref(anon.database(), 'packets/outgoing/response_2'), { wellName: 'X' }));
  });

  test('anonymous can query processed by driverId index', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, 'packets/processed/p1'), {
        driverId: DRIVER_HASH,
        driverName: 'Mike S',
        wellName: 'Gabriel 1',
        requestType: 'pull',
      });
      await set(ref(db, 'packets/processed/p2'), {
        driverId: OTHER_HASH,
        driverName: 'Other',
        wellName: 'Gabriel 2',
        requestType: 'pull',
      });
    });
    const anon = testEnv.unauthenticatedContext();
    const q = query(
      ref(anon.database(), 'packets/processed'),
      orderByChild('driverId'),
      equalTo(DRIVER_HASH),
    );
    await assertSucceeds(get(q));
    await assertFails(set(ref(anon.database(), 'packets/processed/p3'), VALID_PULL_PACKET));
  });
});

describe('packets/incoming_version', () => {
  test('anonymous can read and write numeric version counter', async () => {
    const anon = testEnv.unauthenticatedContext();
    const path = ref(anon.database(), 'packets/incoming_version');
    await assertSucceeds(set(path, 1));
    await assertSucceeds(get(path));
    await assertSucceeds(set(path, '42'));
    await assertFails(set(path, 'not-a-number'));
  });
});

describe('well_config', () => {
  test('anonymous can read but not write', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'well_config/Gabriel1'), { route: 'North', tanks: 3 });
    });
    const anon = testEnv.unauthenticatedContext();
    await assertSucceeds(get(ref(anon.database(), 'well_config')));
    await assertSucceeds(get(ref(anon.database(), 'well_config/Gabriel1')));
    await assertFails(update(ref(anon.database(), 'well_config/Gabriel1'), { routeRecording: true }));
  });

  test('dashboard staff can write well_config', async () => {
    await seedDashboardUser('mgr-1', 'manager');
    const mgr = testEnv.authenticatedContext('mgr-1');
    await assertSucceeds(set(ref(mgr.database(), 'well_config/Gabriel1'), {
      route: 'North',
      tanks: 3,
      routeRecording: true,
    }));
  });
});

describe('performance + production', () => {
  test('anonymous can read performance; cannot write', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'performance/Gabriel1/rows/ts1'), { d: '2026-07-10', a: 1, p: 2 });
    });
    const anon = testEnv.unauthenticatedContext();
    await assertSucceeds(get(ref(anon.database(), 'performance')));
    await assertFails(set(ref(anon.database(), 'performance/Gabriel1/rows/ts2'), { d: 'x' }));
  });

  test('production is denied to all direct client reads', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'production/well1/2026-07-10'), { a: 1, w: 2, o: 3, n: 4 });
    });
    const anon = testEnv.unauthenticatedContext();
    await assertFails(get(ref(anon.database(), 'production')));

    await seedDashboardUser('mgr-1', 'manager');
    const mgr = testEnv.authenticatedContext('mgr-1');
    await assertFails(get(ref(mgr.database(), 'production')));
  });
});

describe('devices', () => {
  test('anonymous can register and patch company device tracking', async () => {
    const anon = testEnv.unauthenticatedContext();
    const deviceRef = ref(anon.database(), 'devices/company/device-abc');
    await assertSucceeds(set(deviceRef, {
      registeredAt: new Date().toISOString(),
      nickname: 'Shop Tablet',
      modelName: 'Galaxy Tab',
    }));
    await assertSucceeds(update(deviceRef, {
      lastDriver: 'Mike S',
      lastLoginAt: new Date().toISOString(),
    }));
    const histRef = push(ref(anon.database(), 'devices/company/device-abc/loginHistory'));
    await assertSucceeds(set(histRef, {
      driver: 'Mike S',
      at: new Date().toISOString(),
    }));
  });
});

describe('status/excel_heartbeat', () => {
  test('anonymous can read heartbeat and write valid payload', async () => {
    const anon = testEnv.unauthenticatedContext();
    const hb = ref(anon.database(), 'status/excel_heartbeat');
    await assertSucceeds(set(hb, { timestamp: new Date().toISOString() }));
    await assertSucceeds(get(hb));
    await assertFails(set(ref(anon.database(), 'status/other'), { timestamp: 'x' }));
  });
});

describe('logs + notifications', () => {
  test('anonymous can append debug and system logs; cannot read', async () => {
    const anon = testEnv.unauthenticatedContext();
    const debugPush = push(ref(anon.database(), 'logs/debug/MikeS/2026-07-10'));
    await assertSucceeds(set(debugPush, {
      flushedAt: new Date().toISOString(),
      count: 2,
      entries: [{ t: new Date().toISOString(), l: 'warn', m: 'test' }],
    }));
    await assertFails(get(ref(anon.database(), 'logs/debug/MikeS/2026-07-10')));

    const sysPush = push(ref(anon.database(), 'logs/system'));
    await assertSucceeds(set(sysPush, {
      timestamp: Date.now(),
      level: 'warn',
      event: 'connectivity',
      details: 'offline',
      device: 'Samsung',
      driver: 'Mike S',
    }));
    await assertFails(get(ref(anon.database(), 'logs/system')));
  });

  test('standalone registration notification create-only', async () => {
    const anon = testEnv.unauthenticatedContext();
    const notifyPush = push(ref(anon.database(), 'notifications/standalone_registrations'));
    await assertSucceeds(set(notifyPush, {
      displayName: 'Mike S',
      hash: DRIVER_HASH,
      source: 'wbjsa',
      registeredAt: new Date().toISOString(),
    }));
    await assertFails(get(ref(anon.database(), 'notifications/standalone_registrations')));
  });
});

describe('Admin SDK bypass (simulated)', () => {
  test('security-disabled context can write CF-owned paths', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await assertSucceeds(set(ref(db, 'wells/Gabriel1/status'), { isDown: false }));
      await assertSucceeds(set(ref(db, 'system_health/overall'), { ok: true }));
      await assertSucceeds(set(ref(db, 'truth_reference/swd_catalog/key1'), { name: 'SWD' }));
      await assertSucceeds(set(ref(db, 'production/well1/2026-07-10'), { a: 1 }));
    });
  });
});