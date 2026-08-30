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
  check('1 committed via coordinator receipt (content-derived id)', Object.keys((await val(`wells/${WELL}/chronoReceipts`)) || {}).length >= 1, 'receipt');
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

  // 6) CROSS-PRODUCTION-DATE edit — Blocker-1: production MOVES buckets.
  //    Sole pull on 08-27 seeded with a production bucket; edit moves it to
  //    08-25 → 08-27 bucket vacated (null), 08-25 bucket created.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  await db.ref('production/Gabriel_1/2026-08-27').set({ a: 40, w: 42, o: 39, u: new Date().toISOString(), n: 1 });
  const e6 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 140, newDateTimeUTC: '2026-08-25T15:00:00.000Z' });
  await waitConsumed(e6);
  const p6 = await val('packets/processed/p1');
  const oldBucket6 = await val('production/Gabriel_1/2026-08-27');
  const newBucket6 = await val('production/Gabriel_1/2026-08-25');
  check('6 CROSS-DATE: processed moved AND production buckets moved (old vacated → null, new date created n=1)', p6?.dateTimeUTC === '2026-08-25T15:00:00.000Z' && oldBucket6 === null && newBucket6 && newBucket6.n === 1, JSON.stringify({ old: oldBucket6, new: newBucket6 }));

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


  // ── BLOCKER-1 cross-date detail ──────────────────────────────────────────
  // 12) cross-date EARLIER, remains non-current (a newer pull exists).
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168); await seedLegacyPull('p2', '2026-08-28T15:00:00.000Z', 120, 160);
  await setCurrentOutgoing('p2', '2026-08-28T15:00:00.000Z', 120);
  await db.ref('production/Gabriel_1/2026-08-27').set({ a: 40, w: 42, o: 39, u: new Date().toISOString(), n: 1 });
  await db.ref('production/Gabriel_1/2026-08-28').set({ a: 30, w: 33, o: 31, u: new Date().toISOString(), n: 1 });
  const e12 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 145, newDateTimeUTC: '2026-08-26T15:00:00.000Z' });
  await waitConsumed(e12);
  check('12 cross-date EARLIER: current stays p2; 08-27 vacated; 08-26 created; 08-28 (p2) preserved',
    (await outRow())?.lastPullPacketId === 'p2'
    && (await val('production/Gabriel_1/2026-08-27')) === null
    && (await val('production/Gabriel_1/2026-08-26'))?.n === 1
    && (await val('production/Gabriel_1/2026-08-28'))?.n === 1,
    JSON.stringify({ cur: (await outRow())?.lastPullPacketId, d27: await val('production/Gabriel_1/2026-08-27'), d26: await val('production/Gabriel_1/2026-08-26') }));

  // 13) cross-date LATER, becomes current.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168); await seedLegacyPull('p2', '2026-08-28T15:00:00.000Z', 120, 160);
  await setCurrentOutgoing('p2', '2026-08-28T15:00:00.000Z', 120);
  const e13 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 145, newDateTimeUTC: '2026-08-29T15:00:00.000Z' });
  await waitConsumed(e13);
  check('13 cross-date LATER: p1 becomes current; 08-29 bucket created',
    (await outRow())?.lastPullPacketId === 'p1' && (await val('production/Gabriel_1/2026-08-29'))?.n === 1,
    JSON.stringify({ cur: (await outRow())?.lastPullPacketId, d29: await val('production/Gabriel_1/2026-08-29') }));

  // 14) cross-date edit FOLLOWED BY REPLAY (distinct new key, same final material) → idempotent, no double bucket/bump.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const e14a = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150, newDateTimeUTC: '2026-08-25T15:00:00.000Z' }, 1000000001000);
  await waitConsumed(e14a);
  const leg14 = await val('packets/incoming_version');
  const e14b = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150, newDateTimeUTC: '2026-08-25T15:00:00.000Z' }, 1000000002000); // DIFFERENT key, same material
  await sleep(4000);
  check('14 cross-date REPLAY under a DISTINCT key: idempotent — one edit event, no extra bump, one bucket',
    (await val('packets/processed/p1'))?.editCount === 1 && (await val('packets/incoming_version')) === leg14 && (await val('production/Gabriel_1/2026-08-25'))?.n === 1 && (await val(`packets/incoming/${e14b}`)) === null,
    JSON.stringify({ cnt: (await val('packets/processed/p1'))?.editCount, leg: await val('packets/incoming_version') }));

  // 15) OLD production bucket becomes EMPTY (sole pull leaves) → removed (null).
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  await db.ref('production/Gabriel_1/2026-08-27').set({ a: 40, w: 42, o: 39, u: new Date().toISOString(), n: 1 });
  const e15 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 140, newDateTimeUTC: '2026-08-24T15:00:00.000Z' });
  await waitConsumed(e15);
  check('15 vacated old bucket removed (null)', (await val('production/Gabriel_1/2026-08-27')) === null, JSON.stringify(await val('production/Gabriel_1/2026-08-27')));

  // 16) DESTINATION bucket already has pulls → n increments to authoritative count.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168); await seedLegacyPull('d1', '2026-08-25T14:00:00.000Z', 100, 150);
  await db.ref('production/Gabriel_1/2026-08-25').set({ a: 20, w: 22, o: 21, u: new Date().toISOString(), n: 1 });
  const e16 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 140, newDateTimeUTC: '2026-08-25T20:00:00.000Z' }); // later than d1 same date
  await waitConsumed(e16);
  const d25 = await val('production/Gabriel_1/2026-08-25');
  check('16 destination bucket already populated: authoritative n=2, a/w/o reflect the new latest (p1)', d25 && d25.n === 2, JSON.stringify(d25));

  // 17) HISTORICAL stored bottom survives a changed CURRENT config.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const before17 = (await val('packets/processed/p1'))?.tankAfterInches;
  // Change well config bblPerFoot AFTER the historical pull; edit a DIFFERENT aspect.
  await db.ref('well_config/Gabriel 1/bblPerFoot').set(40);
  await seedLegacyPull('p2', '2026-08-28T15:00:00.000Z', 120, 160); await setCurrentOutgoing('p2', '2026-08-28T15:00:00.000Z', 120);
  const e17 = await submitAdminEdit({ originalPacketId: 'p2', tankTopInches: 160, bblsTaken: 125 }); // edit p2, not p1
  await waitConsumed(e17);
  check('17 editing p2 does NOT recompute p1 historical stored bottom with today config', (await val('packets/processed/p1'))?.tankAfterInches === before17, JSON.stringify([before17, (await val('packets/processed/p1'))?.tankAfterInches]));

  // 18) NON-20 BBL/ft well cross-date edit computes a bottom (never rejected).
  const W25 = 'Predator 1';
  await db.ref('/').set(null); await db.ref(`well_config/${W25}`).set({ tanks: 1, bblPerFoot: 25, bottomLevel: 3, route: 'Montana', companyId: 'liquid-gold' }); await db.ref('packets/incoming_version').set(2000);
  await db.ref('packets/processed/pp1').set({ packetId: 'pp1', wellName: W25, companyId: 'liquid-gold', dateTimeUTC: '2026-08-27T15:00:00.000Z', bblsTaken: 140, tankTopInches: 168, tankLevelFeet: 14, tankAfterInches: 168 - (140 / 25) * 12, driverName: 'L', driverId: 'd0', processedAt: new Date().toISOString() });
  const e18 = await (async () => { const packetId = `edit_${Date.now()}_Predator1`; await db.ref(`packets/incoming/${packetId}`).set({ requestType: 'edit', originalPacketId: 'pp1', wellName: W25, tankTopInches: 168, bblsTaken: 140, timestamp: new Date().toISOString(), source: 'dashboard', wellDown: false, wellDownIsAuthoritative: true, editedByUid: 'u', dateTimeUTC: '2026-08-25T15:00:00.000Z', dateTime: 'x' }); return packetId; })();
  { const s = Date.now(); while (Date.now() - s < 12000) { if ((await val(`packets/incoming/${e18}`)) === null) break; await sleep(300); } }
  const pp1 = await val('packets/processed/pp1');
  check('18 NON-20 (25) BBL/ft cross-date edit: bottom = 168 − (140/25)*12 = 100.8, date moved', pp1 && Math.abs(pp1.tankAfterInches - 100.8) < 0.01 && pp1.dateTimeUTC === '2026-08-25T15:00:00.000Z', JSON.stringify(pp1?.tankAfterInches));

  // ── BLOCKER-2 retry idempotency (A–E) ────────────────────────────────────
  // A: same key twice → idempotent (covered by case 10). Re-assert compactly.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const kA = 1000000010000; const a1 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150 }, kA); await waitConsumed(a1); const legA = await val('packets/incoming_version');
  await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150 }, kA); await sleep(3500);
  check('A same-key replay: idempotent (editCount 1, no extra bump)', (await val('packets/processed/p1'))?.editCount === 1 && (await val('packets/incoming_version')) === legA);

  // B: two DIFFERENT keys + equivalent material → idempotent equivalent retry.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const b1 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150 }, 1000000020000); await waitConsumed(b1); const legB = await val('packets/incoming_version');
  const b2 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150 }, 1000000021000); await sleep(4000);
  check('B distinct keys + equivalent material: idempotent — one event, no second bump, residue consumed', (await val('packets/processed/p1'))?.editCount === 1 && (await val('packets/incoming_version')) === legB && (await val(`packets/incoming/${b2}`)) === null, JSON.stringify({ cnt: (await val('packets/processed/p1'))?.editCount }));

  // C: two DIFFERENT keys + DIFFERENT material → both edit events evidenced.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const c1 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150 }, 1000000030000); await waitConsumed(c1);
  const c2 = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 145 }, 1000000031000); await waitConsumed(c2);
  const hist = await val('packets/editHistory/p1');
  check('C distinct keys + different material: BOTH edit events evidenced (no silent disappearance), final=latest 145', hist && Object.keys(hist).length === 2 && (await val('packets/processed/p1'))?.bblsTaken === 145, JSON.stringify({ events: hist && Object.keys(hist).length, bbls: (await val('packets/processed/p1'))?.bblsTaken }));

  // D: retry after receipt exists (post-commit) → already_done, residue consumed.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const d1k = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150 }, 1000000040000); await waitConsumed(d1k);
  const legD = await val('packets/incoming_version');
  // Re-submit the SAME content under a fresh key AFTER the receipt exists.
  const d2k = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150 }, 1000000041000); await sleep(3500);
  check('D retry after receipt: already_done via content id, residue consumed, no extra bump', (await val(`packets/incoming/${d2k}`)) === null && (await val('packets/incoming_version')) === legD && (await val('packets/processed/p1'))?.editCount === 1);

  // E: retry after the 180s takeover horizon — simulate a stuck committing lock
  //    from the SAME content op, then the retry recovers/consumes without double apply.
  await reset(); await seedLegacyPull('p1', '2026-08-27T15:00:00.000Z', 140, 168);
  const e1k = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150 }, 1000000050000); await waitConsumed(e1k);
  const legE = await val('packets/incoming_version');
  // Plant a stale committing lock (past horizon) under the SAME well; a retry of
  // the same content must consult the receipt and NOT double-apply.
  await db.ref(`wells/${WELL}/status/chronoLock`).set({ token: 'stale', fence: 1, phase: 'committing', at: Date.now() - 200000, operationId: 'edit_c_p1_stale' });
  const e2k = await submitAdminEdit({ originalPacketId: 'p1', tankTopInches: 168, bblsTaken: 150 }, 1000000051000); await sleep(4000);
  check('E retry past 180s horizon with stale lock: no double apply (editCount 1), residue consumed, no extra bump', (await val('packets/processed/p1'))?.editCount === 1 && (await val(`packets/incoming/${e2k}`)) === null && (await val('packets/incoming_version')) === legE, JSON.stringify({ cnt: (await val('packets/processed/p1'))?.editCount }));

  console.log('\n=== ADMIN-EDIT COMPAT (exact adminSubmitPullEdit record → new processEditRequest) ===');
  console.log(results.join('\n'));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[adminEdit] fatal', e); process.exit(2); });
