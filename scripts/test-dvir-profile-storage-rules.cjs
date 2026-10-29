/**
 * Run only against a local Storage emulator with a previously audited rules file:
 * node scripts/test-dvir-profile-storage-rules.cjs <LIVE_RULES_SNAPSHOT>
 * The 2026-10-29 live wellbuilt-sync ruleset is 4b33f6f4-529c-4005-8e12-40a2cf8d99a4.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');

const expectedSha = 'e7009c8ca5bc368ad028e674c2fa3d780731ba5b58a0047003f16a1d8413cf7a';
const input = process.argv[2];
if (!input) throw new Error('Pass a verified live Storage rules snapshot');
const rules = fs.readFileSync(input, 'utf8').replace(/\r\n/g, '\n');
const sha = crypto.createHash('sha256').update(rules).digest('hex');
if (sha !== expectedSha) throw new Error('Rules snapshot differs from the audited 2026-10-29 live release');

async function main() {
  const env = await initializeTestEnvironment({
    projectId: 'demo-dvir-profile',
    storage: { host: '127.0.0.1', port: 9199, rules },
  });
  const payload = Uint8Array.from([255, 216, 255, 1]);
  const defaultPath = 'equipment-inspection-defaults/hot-oiler-v1/revision1/image1.jpg';
  const privatePath = 'companies/acme/equipment-inspection-media/image1.jpg';
  const existingPhotoPath = 'photos/acme/driverA/invoice1/photo.jpg';
  try {
    await env.withSecurityRulesDisabled(async ctx => {
      for (const path of [defaultPath, privatePath, existingPhotoPath]) {
        await ctx.storage().ref(path).put(payload, { contentType: 'image/jpeg' });
      }
    });
    const contexts = [
      ['anonymous', env.unauthenticatedContext()],
      ['company driver', env.authenticatedContext('driverA', { kind: 'driver', driverId: 'driverA', companyId: 'acme' })],
      ['company platform admin', env.authenticatedContext('adminA', { wellbuiltAdmin: true, companyId: 'acme' })],
      ['foreign driver', env.authenticatedContext('driverB', { kind: 'driver', driverId: 'driverB', companyId: 'other' })],
    ];
    let assertions = 0;
    for (const [name, ctx] of contexts) {
      for (const path of [defaultPath, privatePath]) {
        await assertFails(ctx.storage().ref(path).getMetadata());
        await assertFails(ctx.storage().ref(path).put(payload, { contentType: 'image/jpeg' }));
        assertions += 2;
      }
      console.log(`${name}: profile media direct read/write denied`);
    }
    const ownDriver = contexts[1][1];
    const foreignDriver = contexts[3][1];
    await assertSucceeds(ownDriver.storage().ref(existingPhotoPath).getMetadata());
    await assertFails(foreignDriver.storage().ref(existingPhotoPath).getMetadata());
    console.log(`PASS ${assertions + 2} Storage rules assertions; live rules SHA-256 ${sha}`);
  } finally { await env.cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
