#!/usr/bin/env node
/**
 * scripts/provision-watchdog-principal.mjs
 *
 * PROVISIONING SPEC & TOOL FOR DEDICATED WATCHDOG PRINCIPAL.
 *
 * HARD BOUNDARY:
 *  - DO NOT EXECUTE AGAINST PRODUCTION WITHOUT AUTHORIZATION.
 *  - This script is for emulator verification and documented deployment commands only.
 *
 * Usage:
 *   node scripts/provision-watchdog-principal.mjs --dry-run
 *   node scripts/provision-watchdog-principal.mjs --emulator
 */

// firebase-admin dynamically loaded when executing
let admin;

const IS_DRY_RUN = process.argv.includes('--dry-run') || (!process.argv.includes('--emulator') && !process.argv.includes('--execute'));
const IS_EMULATOR = process.argv.includes('--emulator') || Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);

const DEFAULT_CONFIG = {
  email: 'watchdog-liquidgold@service.wellbuilt.internal',
  displayName: 'WhatsApp Watchdog Sidecar (Liquid Gold)',
  companyId: 'liquid-gold',
  credentialTarget: 'WellBuilt/Watchdog/ingestWatchdogPull',
};

async function main() {
  console.log('================================================================');
  console.log('   WELLBUILT WATCHDOG PRINCIPAL PROVISIONING SPECIFICATION');
  console.log('================================================================');
  console.log(`Target Principal: ${DEFAULT_CONFIG.email}`);
  console.log(`Display Name:     ${DEFAULT_CONFIG.displayName}`);
  console.log(`Custom Claims:    { kind: "watchdog", companyId: "${DEFAULT_CONFIG.companyId}" }`);
  console.log(`DPAPI Target:     ${DEFAULT_CONFIG.credentialTarget}`);
  console.log('----------------------------------------------------------------');

  if (IS_DRY_RUN && !IS_EMULATOR) {
    console.log('[DRY RUN] No changes were made to Firebase Auth.');
    console.log('Production provisioning commands for review:');
    console.log('  1. Create Firebase Auth user:');
    console.log(`     firebase auth:export users.json (or via Admin SDK / Google Cloud Console)`);
    console.log('  2. Stamp custom claims via Admin SDK:');
    console.log(`     admin.auth().setCustomUserClaims(uid, { kind: 'watchdog', companyId: '${DEFAULT_CONFIG.companyId}' });`);
    console.log('  3. Store initial refresh credential on Windows host via DPAPI / Credential Manager:');
    console.log(`     cmdkey /generic:${DEFAULT_CONFIG.credentialTarget} /user:${DEFAULT_CONFIG.email} /pass:<REFRESH_TOKEN>`);
    console.log('================================================================');
    return;
  }

  if (IS_EMULATOR) {
    console.log('[EMULATOR] Provisioning Watchdog principal in local Auth emulator...');
    admin = (await import('../functions/node_modules/firebase-admin/lib/index.js')).default;
    if (!admin.apps.length) {
      admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'wellbuilt-sync' });
    }
    const auth = admin.auth();
    let user;
    try {
      user = await auth.getUserByEmail(DEFAULT_CONFIG.email);
      console.log(`Existing user found: ${user.uid}`);
    } catch {
      user = await auth.createUser({
        email: DEFAULT_CONFIG.email,
        displayName: DEFAULT_CONFIG.displayName,
        password: 'LocalWatchdogDevPassword123!',
      });
      console.log(`Created new user: ${user.uid}`);
    }

    await auth.setCustomUserClaims(user.uid, {
      kind: 'watchdog',
      companyId: DEFAULT_CONFIG.companyId,
    });
    console.log(`Stamped custom claims: kind=watchdog, companyId=${DEFAULT_CONFIG.companyId}`);
    console.log('Watchdog emulator principal ready.');
  }
}

main().catch((err) => {
  console.error('Provisioning failed:', err);
  process.exit(1);
});
