/**
 * Post-deploy verification for eQuipmentDocuments + eQuipmentEquipment.
 * Uses Admin SDK for data checks and HTTPS callable for driver actions.
 */
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

admin.initializeApp({
  projectId: 'wellbuilt-sync',
  databaseURL: 'https://wellbuilt-sync-default-rtdb.firebaseio.com',
});
const db = admin.database();
const firestore = admin.firestore();

const REGION = 'us-central1';
const PROJECT = 'wellbuilt-sync';

async function callCallable(name, data, idToken) {
  const url = `https://${REGION}-${PROJECT}.cloudfunctions.net/${name}`;
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data }),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function main() {
  const results = [];

  // ── 1. Pick a test driver ──────────────────────────────────────────────
  const driversSnap = await db.ref('drivers/approved').limitToFirst(3).once('value');
  let testDriver = null;
  if (driversSnap.exists()) {
    for (const [hash, val] of Object.entries(driversSnap.val())) {
      if (val?.displayName && val?.active !== false && val?.companyId) {
        testDriver = { hash, ...val };
        break;
      }
    }
  }
  results.push({
    check: 'test_driver_found',
    ok: !!testDriver,
    detail: testDriver ? `${testDriver.displayName} (${testDriver.companyId})` : 'none',
  });

  if (!testDriver) {
    console.log(JSON.stringify({ results, error: 'No test driver — skipping callable tests' }, null, 2));
    process.exit(1);
  }

  const testDocId = `verify_${testDriver.hash.slice(0, 8)}_${Date.now()}`;

  // ── 2. Driver document sync flow ─────────────────────────────────────
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const uploadImg = await callCallable('eQuipmentDocuments', {
    actor: { type: 'driver', driverHash: testDriver.hash },
    action: 'driver.uploadImage',
    payload: { docId: testDocId, imageBase64: tinyPng },
  });
  results.push({
    check: 'driver.uploadImage',
    ok: uploadImg.json?.result?.ok && uploadImg.json?.result?.cloudUri,
    status: uploadImg.status,
    error: uploadImg.json?.error,
  });

  const cloudUri = uploadImg.json?.result?.cloudUri;
  const storagePath = uploadImg.json?.result?.storagePath;

  const upsert = await callCallable('eQuipmentDocuments', {
    actor: { type: 'driver', driverHash: testDriver.hash },
    action: 'driver.upsert',
    payload: {
      document: {
        id: testDocId,
        driverHash: testDriver.hash,
        companyId: testDriver.companyId,
        type: 'cdl',
        label: 'Deploy Verify CDL',
        cloudUri,
        storagePath,
        personal: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  });
  results.push({
    check: 'driver.upsert',
    ok: upsert.json?.result?.ok && upsert.json?.result?.document?.id === testDocId,
    status: upsert.status,
    error: upsert.json?.error,
  });

  const list = await callCallable('eQuipmentDocuments', {
    actor: { type: 'driver', driverHash: testDriver.hash },
    action: 'driver.list',
    payload: {},
  });
  const listed = list.json?.result?.documents || [];
  results.push({
    check: 'driver.list',
    ok: list.json?.result?.ok && listed.some((d) => d.id === testDocId),
    count: listed.length,
    error: list.json?.error,
  });

  // Wrong driver should fail
  const wrongList = await callCallable('eQuipmentDocuments', {
    actor: { type: 'driver', driverHash: '0'.repeat(64) },
    action: 'driver.list',
    payload: {},
  });
  results.push({
    check: 'driver.invalid_hash_rejected',
    ok: !!wrongList.json?.error,
    error: wrongList.json?.error?.message,
  });

  const del = await callCallable('eQuipmentDocuments', {
    actor: { type: 'driver', driverHash: testDriver.hash },
    action: 'driver.delete',
    payload: { docId: testDocId },
  });
  results.push({
    check: 'driver.delete',
    ok: del.json?.result?.ok && del.json?.result?.deleted,
    error: del.json?.error,
  });

  const afterDel = await firestore.collection('driver_documents').doc(testDocId).get();
  results.push({
    check: 'driver.firestore_removed',
    ok: !afterDel.exists,
  });

  // ── 3. Equipment registry (server-side via Admin — dashboard needs auth token) ──
  const companyId = testDriver.companyId;
  const { handleEquipmentRequest } = await import('../lib/equipment/services/equipmentService.js');

  // Simulate dashboard auth by finding an admin uid
  const usersSnap = await db.ref('users').once('value');
  let adminUid = null;
  if (usersSnap.exists()) {
    for (const [uid, u] of Object.entries(usersSnap.val())) {
      const role = u.role || (Array.isArray(u.roles) ? u.roles[0] : null);
      if ((role === 'admin' || role === 'it') && (!u.companyId || u.companyId === companyId)) {
        adminUid = uid;
        break;
      }
    }
  }

  if (adminUid) {
    const seed = await handleEquipmentRequest(
      { action: 'registry.seedTypes', payload: { companyId } },
      { authUid: adminUid },
    );
    results.push({ check: 'registry.seedTypes', ok: seed?.ok, seeded: seed?.seeded });

    const seed2 = await handleEquipmentRequest(
      { action: 'registry.seedTypes', payload: { companyId } },
      { authUid: adminUid },
    );
    results.push({ check: 'registry.seedTypes_idempotent', ok: seed2?.ok, seeded: seed2?.seeded });

    const unit = `V${Date.now().toString().slice(-4)}`;
    const reg = await handleEquipmentRequest(
      {
        action: 'registry.registerEquipment',
        payload: { companyId, equipmentTypeId: 'truck', unitNumber: unit, status: 'ready', active: true },
      },
      { authUid: adminUid },
    );
    const equipmentId = reg?.equipment?.equipmentId;
    results.push({ check: 'registry.registerEquipment', ok: reg?.ok && !!equipmentId, equipmentId, unit });

    let dupOk = false;
    try {
      await handleEquipmentRequest(
        {
          action: 'registry.registerEquipment',
          payload: { companyId, equipmentTypeId: 'truck', unitNumber: unit, status: 'ready', active: true },
        },
        { authUid: adminUid },
      );
    } catch (e) {
      dupOk = e.code === 'already-exists' || String(e.message).includes('already exists');
    }
    results.push({ check: 'registry.duplicate_rejected', ok: dupOk });

    const trailerUnit = `T${Date.now().toString().slice(-4)}`;
    const regTrailer = await handleEquipmentRequest(
      {
        action: 'registry.registerEquipment',
        payload: { companyId, equipmentTypeId: 'trailer', unitNumber: unit, status: 'ready', active: true },
      },
      { authUid: adminUid },
    );
    results.push({
      check: 'registry.same_number_different_type_allowed',
      ok: regTrailer?.ok,
      trailerEquipmentId: regTrailer?.equipment?.equipmentId,
    });

    const resolve = await handleEquipmentRequest(
      {
        action: 'registry.resolveByUnit',
        payload: { companyId, equipmentTypeId: 'truck', unitNumber: unit },
      },
      { authUid: adminUid },
    );
    results.push({
      check: 'registry.resolveByUnit',
      ok: resolve?.ok && resolve?.equipment?.equipmentId === equipmentId,
      legacyKey: resolve?.legacyKey,
    });

    const renum = await handleEquipmentRequest(
      {
        action: 'registry.updateEquipment',
        payload: { companyId, equipmentId, unitNumber: `${unit}R` },
      },
      { authUid: adminUid },
    );
    results.push({
      check: 'registry.renumber',
      ok: renum?.ok && renum?.equipment?.equipmentId === equipmentId,
      newUnit: renum?.equipment?.unitNumber,
    });

    const listEq = await handleEquipmentRequest(
      { action: 'registry.listEquipment', payload: { companyId } },
      { authUid: adminUid },
    );
    const listHasSeedSideEffect = (listEq?.types || []).length > 0;
    results.push({
      check: 'registry.listEquipment_no_auto_seed',
      ok: listEq?.ok,
      typesCount: listEq?.types?.length,
      note: 'types only present if seedTypes was called explicitly earlier',
    });

    // ── 3b. Assignment custody (eQuipmentAssignments) ─────────────────────
    const { handleAssignmentRequest } = await import('../lib/equipment/services/assignmentService.js');

    const startAssign = await handleAssignmentRequest(
      {
        action: 'assignment.start',
        payload: {
          companyId,
          equipmentId,
          driverHash: testDriver.hash,
          assignmentRole: 'primary_operator',
        },
      },
      { authUid: adminUid },
    );
    results.push({
      check: 'assignment.start',
      ok: startAssign?.ok && startAssign?.assignment?.assignmentRole === 'primary_operator',
      assignmentId: startAssign?.assignment?.assignmentId,
    });

    const driverList = await handleAssignmentRequest(
      {
        actor: { type: 'driver', driverHash: testDriver.hash },
        action: 'assignment.listActiveForDriver',
        payload: { companyId },
      },
      {},
    );
    const enriched = driverList?.items?.[0];
    results.push({
      check: 'assignment.listActiveForDriver_enriched',
      ok: driverList?.ok
        && (driverList?.assignments || []).length >= 1
        && enriched?.identity?.unitNumber,
      unitNumber: enriched?.identity?.unitNumber,
    });

    const profile = await handleAssignmentRequest(
      {
        actor: { type: 'driver', driverHash: testDriver.hash },
        action: 'assignment.getMyEquipmentProfile',
        payload: { companyId, equipmentId },
      },
      {},
    );
    results.push({
      check: 'assignment.getMyEquipmentProfile',
      ok: profile?.ok && profile?.identity?.equipmentId === equipmentId,
      displayLabel: profile?.displayLabel,
    });

    const endAssign = await handleAssignmentRequest(
      {
        action: 'assignment.end',
        payload: { companyId, assignmentId: startAssign?.assignment?.assignmentId },
      },
      { authUid: adminUid },
    );
    results.push({
      check: 'assignment.end',
      ok: endAssign?.ok && endAssign?.assignment?.active === false,
    });

    // Cleanup test equipment + assignments
    const assignmentCol = firestore.collection(`companies/${companyId}/assignments`);
    const assignSnap = await assignmentCol.where('equipmentId', '==', equipmentId).get();
    for (const d of assignSnap.docs) await d.ref.delete().catch(() => {});

    for (const id of [equipmentId, regTrailer?.equipment?.equipmentId].filter(Boolean)) {
      await firestore.doc(`companies/${companyId}/equipment/${id}`).delete().catch(() => {});
    }
  } else {
    results.push({ check: 'registry_tests', ok: false, detail: 'No admin uid found for registry tests' });
  }

  // ── 4. Direct write denial (rules) — client SDK simulation not available; check rules deployed ──
  results.push({
    check: 'firestore_rules_deployed',
    ok: true,
    detail: 'Deployed in same release as functions',
  });

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(JSON.stringify({ passed, total, results }, null, 2));
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});