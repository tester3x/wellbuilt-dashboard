import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';

const here = dirname(fileURLToPath(import.meta.url));
const projectId = 'demo-viewer-rules-test';
const env = await initializeTestEnvironment({
  projectId,
  firestore: { rules: readFileSync(join(here, 'firestore.rules'), 'utf8') },
  database: { rules: readFileSync(join(here, 'database.rules.json'), 'utf8') },
});

try {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await Promise.all([
      db.doc('companies/wellbuilt-demo').set({ companyId: 'wellbuilt-demo', isDemo: true, name: 'WellBuilt Demo Hauling' }),
      db.doc('companies/liquidgold').set({ companyId: 'liquidgold', name: 'Live company' }),
      db.doc('dispatches/demo-job').set({ companyId: 'wellbuilt-demo', isDemo: true, status: 'pending' }),
      db.doc('dispatches/live-job').set({ companyId: 'liquidgold', status: 'pending' }),
      db.doc('tickets/demo-ticket').set({ companyId: 'wellbuilt-demo', isDemo: true }),
      db.doc('tickets/unmarked-ticket').set({ companyId: 'wellbuilt-demo' }),
      db.doc('invoices/demo-invoice').set({ companyId: 'wellbuilt-demo', isDemo: true }),
    ]);
    await context.database().ref().update({
      'well_config/Demo Well': { companyId: 'wellbuilt-demo', isDemo: true },
      'well_config/Live Well': { companyId: 'liquidgold' },
      'drivers/profiles/demo-driver': { companyId: 'wellbuilt-demo', isDemo: true },
      'drivers/profiles/live-driver': { companyId: 'liquidgold' },
      'packets/outgoing/Demo Well': { companyId: 'wellbuilt-demo', isDemo: true },
      'packets/outgoing/Live Well': { companyId: 'liquidgold' },
      'packets/processed/demo-pull': { companyId: 'wellbuilt-demo', isDemo: true },
      'packets/processed/live-pull': { companyId: 'liquidgold' },
    });
  });

  const viewer = env.authenticatedContext('wellbuilt-demo-shared-viewer', {
    staffRole: 'demo_viewer', staffCompanyId: 'wellbuilt-demo', isDemo: true,
  });
  const fs = viewer.firestore();
  const rt = viewer.database();
  await assertSucceeds(fs.doc('companies/wellbuilt-demo').get());
  await assertSucceeds(fs.doc('dispatches/demo-job').get());
  await assertSucceeds(fs.doc('tickets/demo-ticket').get());
  await assertSucceeds(fs.doc('invoices/demo-invoice').get());
  await assertSucceeds(fs.collection('dispatches').where('companyId', '==', 'wellbuilt-demo').where('isDemo', '==', true).get());
  await assertFails(fs.doc('companies/liquidgold').get());
  await assertFails(fs.doc('dispatches/live-job').get());
  await assertFails(fs.doc('tickets/unmarked-ticket').get());
  await assertFails(fs.collection('dispatches').get());
  await assertFails(fs.doc('dispatches/demo-job').set({ status: 'changed' }, { merge: true }));

  await assertSucceeds(rt.ref('well_config/Demo Well').get());
  await assertSucceeds(rt.ref('drivers/profiles/demo-driver').get());
  await assertSucceeds(rt.ref('packets/processed/demo-pull').get());
  const demoPulls = await assertSucceeds(rt.ref('packets/processed').orderByChild('companyId').equalTo('wellbuilt-demo').get());
  assert.deepEqual(Object.keys(demoPulls.val()), ['demo-pull']);
  const demoStatuses = await assertSucceeds(rt.ref('packets/outgoing').orderByChild('companyId').equalTo('wellbuilt-demo').get());
  assert.deepEqual(Object.keys(demoStatuses.val()), ['Demo Well']);
  await assertFails(rt.ref('well_config/Live Well').get());
  await assertFails(rt.ref('packets/processed/live-pull').get());
  await assertFails(rt.ref('packets/processed').get());
  await assertFails(rt.ref('packets/processed').orderByChild('companyId').equalTo('liquidgold').get());
  await assertFails(rt.ref('well_config/Demo Well').child('name').set('changed'));

  for (const [uid, claims] of [
    ['another-user', { staffRole: 'demo_viewer', staffCompanyId: 'wellbuilt-demo', isDemo: true }],
    ['wellbuilt-demo-shared-viewer', { staffRole: 'viewer', staffCompanyId: 'wellbuilt-demo', isDemo: true }],
    ['wellbuilt-demo-shared-viewer', { staffRole: 'demo_viewer', staffCompanyId: 'liquidgold', isDemo: true }],
    ['wellbuilt-demo-shared-viewer', { staffRole: 'demo_viewer', staffCompanyId: 'wellbuilt-demo' }],
  ]) {
    const impostor = env.authenticatedContext(uid, claims);
    await assertFails(impostor.firestore().doc('dispatches/demo-job').get());
    await assertFails(impostor.database().ref('well_config/Demo Well').get());
  }
  console.log('Demo viewer rules: demo reads allowed; live reads, broad queries, writes, and forged claims denied.');
} finally {
  await env.cleanup();
}
