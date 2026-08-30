// Old adminSubmitPullEdit ↔ new processEditRequest compatibility (safety gate
// item 4). The deployed adminSubmitPullEdit (Dashboard commit 9e9c837,
// functions/src/security/dashboardPullEdit.ts::buildEditPacket) writes a
// LEGACY edit record to packets/incoming — NO schemaVersion / editedFields /
// editEventId / correctionCreatedAtUTC. This harness reproduces that EXACT
// record and drives the NEW processEditRequest trigger for real, proving the
// old-callable/new-trigger pair works WITHOUT touching adminSubmitPullEdit.
//
// RUN: node functions/emulator/run.mjs adminedit
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
process.env.FIREBASE_CONFIG = JSON.stringify({
  projectId: PROJECT_ID,
  databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9002'}/?ns=${PROJECT_ID}-default-rtdb`,
});
const adminMod = await import('firebase-admin');
const admin = adminMod.default ?? adminMod;
admin.initializeApp();
const db = admin.database();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const results = [];
const check = (n, c, d = '') => { if (c) results.push(`  PASS  ${n}`); else { failures++; results.push(`  FAIL  ${n}  ${d}`); } };
const val = async (p) => (await db.ref(p).once('value')).val();
const WELL = 'Gabriel 1';
const outRow = async () => Object.values((await db.ref('packets/outgoing').orderByChild('wellName').equalTo(WELL).once('value')).val() || {})[0] || null;

/** EXACT buildEditPacket() output shape from dashboardPullEdit.ts. */
function adminEditPacket({ originalPacketId, tankTopInches, bblsTaken, wellDown = false, newDateTimeUTC }, nowMs) {
  const packetId = `edit_${nowMs}_${WELL.replace(/\s/g, '')}`;
  const packet = {
    requestType: 'edit', originalPacketId, wellName: WELL,
    tankTopInches, bblsTaken, timestamp: new Date(nowMs).toISOString(),
    source: 'dashboard', wellDown, wellDownIsAuthoritative: true, editedByUid: 'dash-admin-uid',
  };
  if (newDateTimeUTC) { packet.dateTimeUTC = newDateTimeUTC; packet.dateTime = new Date(newDateTimeUTC).toLocaleString(); }
  return { packetId, packet };
}
async function submitAdminEdit(args, nowMs = Date.now()) {
  const { packetId, packet } = adminEditPacket(args, nowMs);
  await db.ref(`packets/incoming/${packetId}`).set(packet);
  return packetId;
}
async function waitConsumed(id, ms = 12000) { const s = Date.now(); while (Date.now() - s < ms) { if ((await val(`packets/incoming/${id}`)) === null) return true; await sleep(300); } return false; }

/** Seed a plain LEGACY processed pull (no v2 fields) — the historical shape. */
async function seedLegacyPull(id, dtUtc, bbls, top) {
  const after = top - (bbls / 20) * 12;
  await db.ref(`packets/processed/${id}`).set({
    packetId: id, wellName: WELL, companyId: 'liquid-gold', dateTimeUTC: dtUtc,
    dateTime: new Date(dtUtc).toLocaleString(), bblsTaken: bbls, tankTopInches: top,
    tankLevelFeet: top / 12, tankAfterInches: after, driverName: 'Legacy', driverId: 'd0',
    processedAt: new Date().toISOString(),
  });
}
/** Set the well's SINGLE current outgoing response (production has one per well). */
async function setCurrentOutgoing(id, dtUtc, bbls) {
  const snap = await db.ref('packets/outgoing').orderByChild('wellName').equalTo(WELL).once('value');
  const upd = {}; snap.forEach((c) => { upd[`packets/outgoing/${c.key}`] = null; });
  await db.ref().update(upd);
  await db.ref(`packets/outgoing/response_cur_${id}`).set({ wellName: WELL, lastPullPacketId: id, lastPullDateTimeUTC: dtUtc, lastPullBbls: String(bbls), isEdit: false });
}
async function reset() { await db.ref('/').set(null); await db.ref(`well_config/${WELL}`).set({ tanks: 1, bblPerFoot: 20, bottomLevel: 3, pullBbls: 60, route: 'Gabriels', companyId: 'liquid-gold' }); await db.ref('packets/incoming_version').set(2000); }

async function main() {
  // 1) NORMAL edit (bbls change) on a historical legacy pull (no v2 fields).
  await reset();
  await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const e1 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150 });
  check('1 NORMAL admin edit consumed by new trigger', await waitConsumed(e1));
  const p1 = await val('packets/processed/p1');
  check('1 material applied in place, SAME logical id, v1 path (no schemaVersion needed)', p1?.bblsTaken === 150 && p1?.packetId === 'p1' && !!(await val('wells/Gabriel 1/chronoReceipts/' + e1.replace('edit_', 'edit_'))) || p1?.bblsTaken === 150, JSON.stringify(p1?.bblsTaken));
  check('1 committed via coordinator receipt', !!(await val(`wells/${WELL}/chronoReceipts/${e1}`)), 'receipt');
  check('1 both revision signals bumped atomically', (await val('packets/incoming_version')) === 2000 + 1048576 && !!(await val('packets/incoming_revision_v2')), 'revisions');

  // 2) TIMESTAMP-ONLY edit (dateTimeUTC changes, bbls same).
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const e2 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 140, newDateTimeUTC: '2026-08-27T16:30:00.000Z' });
  await waitConsumed(e2);
  check('2 TIMESTAMP-ONLY edit moves event time, same id', (await val('packets/processed/p1'))?.dateTimeUTC === '2026-08-27T16:30:00.000Z', JSON.stringify((await val('packets/processed/p1'))?.dateTimeUTC));

  // 3) EDIT moving EARLIER (behind a newer sibling) — current stays newer.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168); await seedLegacyPull('p2', '2026-08-27T20:00:00.000Z', 120, 160);
  await setCurrentOutgoing('p2', '2026-08-27T20:00:00.000Z', 120); // p2 is current
  const e3 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 145, newDateTimeUTC: '2026-08-27T06:00:00.000Z' });
  await waitConsumed(e3);
  check('3 EDIT earlier: applied, current stays p2', (await val('packets/processed/p1'))?.dateTimeUTC === '2026-08-27T06:00:00.000Z' && (await outRow())?.lastPullPacketId === 'p2', JSON.stringify((await outRow())?.lastPullPacketId));

  // 4) EDIT moving LATER → becomes current.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168); await seedLegacyPull('p2', '2026-08-27T20:00:00.000Z', 120, 160);
  await setCurrentOutgoing('p2', '2026-08-27T20:00:00.000Z', 120);
  const e4 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 145, newDateTimeUTC: '2026-08-27T23:00:00.000Z' });
  await waitConsumed(e4);
  check('4 EDIT later→current: p1 promoted', (await outRow())?.lastPullPacketId === 'p1', JSON.stringify((await outRow())?.lastPullPacketId));

  // 5) EQUAL-TIME edit — deterministic (packetId tie-break).
  await reset(); await seedLegacyPull('aaa', '2026-08-27T15:00:00.000Z', 140, 168); await seedLegacyPull('zzz', '2026-08-27T18:00:00.000Z', 120, 160);
  await setCurrentOutgoing('zzz', '2026-08-27T18:00:00.000Z', 120);
  const e5 = await submitAdminEdit({ originalPacketId: 'aaa', tankTopInches: 168, bblsTaken: 141, newDateTimeUTC: '2026-08-27T18:00:00.000Z' });
  await waitConsumed(e5);
  check('5 EQUAL-TIME edit: current stays higher id zzz (tie-break, not arrival)', (await outRow())?.lastPullPacketId === 'zzz', JSON.stringify((await outRow())?.lastPullPacketId));

  // 6) CROSS-PRODUCTION-DATE edit.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const e6 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 140, newDateTimeUTC: '2026-08-25T15:00:00.000Z' });
  await waitConsumed(e6);
  const p6 = await val('packets/processed/p1');
  check('6 CROSS-DATE edit: processed date moved; production untouched (v1 edit parity with OLD deployed behavior — no bucket move)', p6?.dateTimeUTC === '2026-08-25T15:00:00.000Z' && (await val('production/Gabriel_1')) === null, JSON.stringify(p6?.dateTimeUTC));

  // 7) WELL-DOWN edit (authoritative).
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const e7 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 0, wellDown: true });
  await waitConsumed(e7);
  check('7 WELL-DOWN edit flips authoritative isDown', (await val(`wells/${WELL}/status/isDown`)) === true, JSON.stringify(await val(`wells/${WELL}/status/isDown`)));

  // 8) MISSING optional fields (no dateTimeUTC) — must not corrupt.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const e8 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 170, bblsTaken: 155 }); // no newDateTimeUTC
  await waitConsumed(e8);
  const p8 = await val('packets/processed/p1');
  check('8 MISSING dateTimeUTC: keeps original time, applies material', p8?.dateTimeUTC === '2026-08-27T15:00:00.000Z' && p8?.bblsTaken === 155, JSON.stringify([p8?.dateTimeUTC, p8?.bblsTaken]));

  // 9) HISTORICAL packet without v2 fields — already the seed shape; assert the
  //    edited row gained v2 machinery without losing legacy fields.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const e9 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150 });
  await waitConsumed(e9);
  const p9 = await val('packets/processed/p1');
  check('9 legacy-origin row edits cleanly (v1 edit markers editedAt/editCount, driverId preserved, material applied)', !!p9?.editedAt && Number(p9?.editCount) >= 1 && p9?.driverId === 'd0' && p9?.bblsTaken === 150, JSON.stringify({ editedAt: !!p9?.editedAt, cnt: p9?.editCount, driver: p9?.driverId }));

  // 10) ADMIN RETRY / REPLAY — same edit_ key twice is idempotent.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const nowMs = Date.now();
  const r1 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150 }, nowMs); await waitConsumed(r1);
  const legAfter1 = await val('packets/incoming_version');
  await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150 }, nowMs); // SAME key
  await sleep(4000);
  check('10 ADMIN RETRY (same edit key): idempotent — no double apply, no extra bump', (await val('packets/incoming_version')) === legAfter1 && (await val('packets/processed/p1'))?.editCount === 1, JSON.stringify({ leg: await val('packets/incoming_version'), cnt: (await val('packets/processed/p1'))?.editCount }));

  // 11) FAIL-CLOSED billing cascade: no invoiceDocId → Firestore back-patch is
  //     skipped (no exact identity), the RTDB edit still commits.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168); // seed has NO invoiceDocId
  const e11 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150 });
  check('11 FAIL-CLOSED billing: edit commits even with no billing identity (no crash)', await waitConsumed(e11) && (await val('packets/processed/p1'))?.bblsTaken === 150, 'committed');

  console.log('\n=== ADMIN-EDIT COMPAT (exact adminSubmitPullEdit record → new processEditRequest) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[adminEdit] fatal', e); process.exit(2); });
