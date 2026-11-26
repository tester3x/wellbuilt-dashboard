// Adds one public operational catalog entry. Never changes company activations,
// paid plans, driver accounts, governed job packets, or any existing catalog entry.
const path = require('node:path');
const { createRequire } = require('node:module');
const { isDeepStrictEqual } = require('node:util');
const catalog = require('../src/lib/independent-dispatch-catalog.json');
async function main() {
  if (!process.argv.includes('--publish')) {
    console.log(JSON.stringify({ dryRun: true, project: 'wellbuilt-sync', path: `job_packages/${catalog.id}`, catalog }, null, 2));
    return;
  }
  if (process.argv[process.argv.indexOf('--project') + 1] !== 'wellbuilt-sync') throw Error('Explicit --project wellbuilt-sync required');
  // Reuse the signed-in Firebase CLI identity without printing credentials.
  const cliRequire = createRequire(path.join(process.env.APPDATA, 'npm/node_modules/firebase-tools/package.json'));
  const { configstore } = cliRequire('./lib/configstore');
  const { getAccessToken } = cliRequire('./lib/auth');
  const refresh = configstore.get('tokens')?.refresh_token;
  if (!refresh) throw Error('Sign in to Firebase CLI before publishing');
  const admin = require('../functions/node_modules/firebase-admin');
  admin.initializeApp({ projectId: 'wellbuilt-sync', credential: {
    getAccessToken: async () => {
      const token = await getAccessToken(refresh, ['https://www.googleapis.com/auth/cloud-platform']);
      return { access_token: token.access_token, expires_in: token.expires_in || 3600 };
    },
  } });
  const ref = admin.firestore().collection('job_packages').doc(catalog.id);
  await admin.firestore().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      if (!isDeepStrictEqual(snap.data(), catalog)) throw Error('Existing catalog differs; refusing overwrite');
      return;
    }
    tx.create(ref, catalog);
  });
  if (!isDeepStrictEqual((await ref.get()).data(), catalog)) throw Error('Catalog readback mismatch');
  console.log('Verified job_packages/independent-dispatch in wellbuilt-sync. No company package activations changed.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
