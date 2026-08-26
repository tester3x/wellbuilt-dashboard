/**
 * RTDB emulator: chronological, per-field edit precedence through the REAL
 * production handlers — runIngestWbmEdit (governed ingest) and
 * processIncomingEdit (the applier). No mirror/parallel apply.
 *
 * Requires FIREBASE_DATABASE_EMULATOR_HOST. Runs in an ISOLATED namespace
 * (editprec-precedence-rtdb) so it never touches any other emulator data.
 * Skipped automatically when no emulator is configured.
 */
import * as admin from 'firebase-admin';
import { runIngestWbmEdit } from '../ingestWbmEdit';

const EMULATOR = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const NS = 'editprec-precedence-rtdb';
const describeE2E = EMULATOR ? describe : describe.skip;

const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const OTHER_DRIVER = '00000000-0000-0000-0000-000000000999';
const COMPANY = 'liquid-gold';
const WELL = 'Precedence 1';
const PID = '20260824_150000_Precedence1_orig01';
const PREV_PID = '20260820_150000_Precedence1_prev01';
const ORIGINAL_UTC = '2026-08-24T15:00:00.000Z';
const PREV_UTC = '2026-08-20T15:00:00.000Z';

// Baseline: 10 ft (120 in), 160 bbls.
const BASE_FEET = 10;
const BASE_BBLS = 160;

type ProcessIncomingEdit = (
  snapshot: admin.database.DataSnapshot,
  context: { params: { packetId: string } },
) => Promise<null>;

describeE2E('emulator: chronological edit precedence (real handlers)', () => {
  jest.setTimeout(60000);
  let db: admin.database.Database;
  let processIncomingEdit: ProcessIncomingEdit;
  let idxMod: {
    __v2FollowupBarrier: {
      beforeClassification: null | (() => Promise<void>);
      beforeProjection: null | (() => Promise<void>);
    };
  };

  beforeAll(() => {
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = EMULATOR!;
    if (!process.env.FIRESTORE_EMULATOR_HOST) process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    process.env.GCLOUD_PROJECT = PROJECT;
    // Isolated namespace — the whole handler operates here.
    process.env.FIREBASE_CONFIG = JSON.stringify({
      projectId: PROJECT,
      databaseURL: `http://${EMULATOR}?ns=${NS}`,
    });
    // Real production applier — imported AFTER emulator env is set.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    idxMod = require('../../../index');
    processIncomingEdit = (idxMod as unknown as { processIncomingEdit: ProcessIncomingEdit }).processIncomingEdit;
    if (!admin.apps.length) {
      admin.initializeApp({ projectId: PROJECT, databaseURL: `http://${EMULATOR}?ns=${NS}` });
    }
    db = admin.database();
  });

  afterAll(async () => {
    // Release the RTDB socket so jest exits without lingering open handles.
    try { await db.goOffline(); } catch { /* noop */ }
  });

  beforeEach(async () => {
    await db.ref('packets').set(null);
    await db.ref('well_config').set(null);
    await db.ref('wells').set(null);
    await db.ref('performance').set(null);
    await db.ref(`well_config/${WELL}`).set({
      route: 'Prec', companyId: COMPANY, tanks: 1, bblPerFoot: 20,
      bottomLevel: 2, loadLine: 0, pullBbls: 100,
    });
    await db.ref(`packets/processed/${PREV_PID}`).set({
      packetId: PREV_PID, wellName: WELL, driverId: DRIVER, companyId: COMPANY,
      dateTimeUTC: PREV_UTC, tankTopInches: 96, tankLevelFeet: 8, tankAfterInches: 40, bblsTaken: 100,
    });
    await db.ref(`packets/processed/${PID}`).set({
      packetId: PID, wellName: WELL, driverId: DRIVER, companyId: COMPANY,
      dateTimeUTC: ORIGINAL_UTC, dateTime: '8/24/2026 10:00 AM',
      tankTopInches: 120, tankLevelFeet: BASE_FEET, tankAfterInches: 60, bblsTaken: BASE_BBLS,
      originAppContext: 'wbm',
    });
  });

  // ── real ingest + real trigger wiring ────────────────────────────────────
  function correction(f: {
    editEventId: string;
    editedFields?: unknown; // explicit mutation mask (default ['bblsTaken'])
    correctionCreatedAtUTC?: string;
    tankLevelFeet?: number;
    bblsTaken?: number;
    wellDown?: boolean;
    dateTimeUTC?: string;
    dateTime?: string;
    omitEventTime?: boolean;
    omitSchemaVersion?: boolean;
    schemaVersion?: unknown;
  }): Record<string, unknown> {
    const p: Record<string, unknown> = {
      requestType: 'edit', wellName: WELL, originalPacketId: PID, packetId: PID,
      editEventId: f.editEventId,
      editedFields: f.editedFields === undefined ? ['bblsTaken'] : f.editedFields,
      tankLevelFeet: f.tankLevelFeet ?? BASE_FEET,
      bblsTaken: f.bblsTaken ?? BASE_BBLS,
      wellDown: f.wellDown ?? false,
      idempotencyKey: f.editEventId,
    };
    if (!f.omitSchemaVersion) p.schemaVersion = f.schemaVersion === undefined ? 2 : f.schemaVersion;
    if (!f.omitEventTime) p.correctionCreatedAtUTC = f.correctionCreatedAtUTC ?? '2026-08-24T10:30:00.000Z';
    if (f.dateTimeUTC) { p.dateTimeUTC = f.dateTimeUTC; p.dateTime = f.dateTime ?? ''; }
    return p;
  }

  async function ingest(packet: Record<string, unknown>, driverId = DRIVER) {
    const origSnap = await db.ref(`packets/processed/${PID}`).once('value');
    const wellSnap = await db.ref('well_config').once('value');
    return runIngestWbmEdit({
      packet,
      driverId,
      uid: `uid-${driverId}`,
      displayName: 'Driver P',
      authSource: 'test',
      companyId: COMPANY,
      assignedRoutes: ['Prec'],
      assignedWells: [],
      wellConfig: (wellSnap.val() || {}) as Record<string, unknown>,
      original: origSnap.exists() ? (origSnap.val() as Record<string, unknown>) : null,
      readReceipt: async (id) => {
        const s = await db.ref(`packets/editReceipts/${id}`).once('value');
        return s.exists() ? (s.val() as Record<string, unknown>) : null;
      },
      writeIncoming: async (path, decide) => {
        const ref = db.ref(path);
        const box = { outcome: 'write' as 'write' | 'queued' | 'abort', abortReason: 'ingest_conflict' };
        const tx = await ref.transaction((cur) => {
          const existing = cur && typeof cur === 'object' ? (cur as Record<string, unknown>) : null;
          const gate = decide(existing);
          if (gate.action === 'write') { box.outcome = 'write'; return gate.stamped; }
          if (gate.action === 'queued') { box.outcome = 'queued'; return cur; }
          box.outcome = 'abort'; box.abortReason = gate.reason; return undefined;
        });
        return { committed: tx.committed, outcome: box.outcome, abortReason: box.abortReason };
      },
    });
  }

  async function deliver(editEventId: string): Promise<void> {
    const snap = await db.ref(`packets/incoming/${editEventId}`).once('value');
    if (!snap.exists()) return;
    await processIncomingEdit(snap as admin.database.DataSnapshot, { params: { packetId: editEventId } });
  }

  async function submit(packet: Record<string, unknown>, driverId = DRIVER) {
    const res = await ingest(packet, driverId);
    if (res.ok && res.status === 'pending') await deliver((res as { editEventId: string }).editEventId);
    return res;
  }

  const processed = async () => (await db.ref(`packets/processed/${PID}`).once('value')).val();
  const history = async () => (await db.ref(`packets/editHistory/${PID}`).once('value')).val() || {};
  const receiptOf = async (id: string) => (await db.ref(`packets/editReceipts/${id}`).once('value')).val();
  const chronoIds = (h: Record<string, any>) =>
    Object.values(h)
      .sort((a: any, b: any) => Date.parse(a.correctionCreatedAtUTC) - Date.parse(b.correctionCreatedAtUTC))
      .map((e: any) => e.eventId);

  // 1
  it('A@10:30 then B@10:45 (same field) → B is final', async () => {
    await submit(correction({ editEventId: 'editevt_a1', correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 150 }));
    await submit(correction({ editEventId: 'editevt_b1', correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', bblsTaken: 155 }));
    expect((await processed()).bblsTaken).toBe(155);
  });

  // 2
  it('B applies first, A (older) arrives later → B remains final', async () => {
    await submit(correction({ editEventId: 'editevt_b1', correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', bblsTaken: 155 }));
    await submit(correction({ editEventId: 'editevt_a1', correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 150 }));
    expect((await processed()).bblsTaken).toBe(155); // arrival order irrelevant
  });

  // 3
  it('concurrent triggers → deterministic newest (B) wins', async () => {
    await ingest(correction({ editEventId: 'editevt_a1', correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 150 }));
    await ingest(correction({ editEventId: 'editevt_b1', correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', bblsTaken: 155 }));
    await Promise.all([deliver('editevt_a1'), deliver('editevt_b1')]); // simultaneous applies
    expect((await processed()).bblsTaken).toBe(155);
    expect(Object.keys(await history()).sort()).toEqual(['editevt_a1', 'editevt_b1']); // both durable
  });

  // 4
  it('retry of A after B → B remains final, one event for A', async () => {
    await submit(correction({ editEventId: 'editevt_b1', correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', bblsTaken: 155 }));
    const a = correction({ editEventId: 'editevt_a1', correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 150 });
    await submit(a);
    await submit(a); // idempotent retry
    expect((await processed()).bblsTaken).toBe(155);
    expect(Object.keys(await history()).filter((k) => k === 'editevt_a1').length).toBe(1);
  });

  // 5
  it('A changes level, B changes BBLs, reverse arrival → both survive per field', async () => {
    // A masks level only (11 ft). B masks bbls only (150).
    const a = correction({ editEventId: 'editevt_a1', editedFields: ['tankLevelFeet'], correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', tankLevelFeet: 11, bblsTaken: 160 });
    const b = correction({ editEventId: 'editevt_b1', editedFields: ['bblsTaken'], correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', tankLevelFeet: 10, bblsTaken: 150 });
    await submit(b); // B arrives first
    await submit(a); // A (older) later — must NOT revert B's bbls, must keep its own level
    const p = await processed();
    expect(p.tankTopInches).toBe(132); // A owns level (11 ft)
    expect(p.bblsTaken).toBe(150); // B owns bbls
  });

  // 6
  it('three edits (10:45,10:30,11:00) → history sorts chronologically and 11:00 is final', async () => {
    await submit(correction({ editEventId: 'editevt_mid1', correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', bblsTaken: 150 }));
    await submit(correction({ editEventId: 'editevt_early', correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 140 }));
    await submit(correction({ editEventId: 'editevt_late', correctionCreatedAtUTC: '2026-08-24T11:00:00.000Z', bblsTaken: 155 }));
    const h = await history();
    expect(Object.keys(h).length).toBe(3);
    expect(chronoIds(h)).toEqual(['editevt_early', 'editevt_mid1', 'editevt_late']);
    expect((await processed()).bblsTaken).toBe(155);
  });

  // 7
  it('same editEventId + same payload retry → exactly one event, accepted', async () => {
    const a = correction({ editEventId: 'editevt_a1', correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 150 });
    await submit(a);
    const again = await ingest(a); // receipt already accepted → no new incoming
    expect(again).toMatchObject({ ok: true, status: 'accepted' });
    await deliver('editevt_a1'); // nothing pending
    expect(Object.keys(await history()).length).toBe(1);
  });

  // 8
  it('same editEventId + different payload → digest conflict (not applied twice)', async () => {
    await submit(correction({ editEventId: 'editevt_a1', correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 150 }));
    const conflict = await ingest(correction({ editEventId: 'editevt_a1', correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 175 }));
    expect(conflict.ok).toBe(false);
    expect((conflict as { status: string }).status).toBe('conflict');
    expect((await processed()).bblsTaken).toBe(150); // unchanged
  });

  // 9
  it('equal event-times → deterministic tie-break by editEventId, both arrival orders', async () => {
    const t = '2026-08-24T10:30:00.000Z';
    await submit(correction({ editEventId: 'editevt_aaa', correctionCreatedAtUTC: t, bblsTaken: 100 }));
    await submit(correction({ editEventId: 'editevt_zzz', correctionCreatedAtUTC: t, bblsTaken: 200 }));
    // 'editevt_zzz' sorts last → authoritative regardless of arrival.
    expect((await processed()).bblsTaken).toBe(200);
  });

  // 10
  it('offsetless event-time is rejected at ingest', async () => {
    const res = await ingest(correction({ editEventId: 'editevt_a1', correctionCreatedAtUTC: '2026-08-24T10:30:00', bblsTaken: 150 }));
    expect(res).toMatchObject({ ok: false, status: 'invalid', reason: 'invalid_correctionCreatedAtUTC' });
  });

  // 11
  it('missing event-time is rejected at ingest (never defaulted to now)', async () => {
    const res = await ingest(correction({ editEventId: 'editevt_a1', omitEventTime: true, bblsTaken: 150 }));
    expect(res).toMatchObject({ ok: false, status: 'invalid', reason: 'missing_correctionCreatedAtUTC' });
  });

  // 12
  it('cross-driver correction is rejected (ownership fails closed)', async () => {
    const res = await ingest(
      correction({ editEventId: 'editevt_a1', correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 150 }),
      OTHER_DRIVER,
    );
    expect(res).toMatchObject({ ok: false, status: 'invalid', reason: 'cross_driver' });
  });

  // 13
  it('a zero BBL correction is valid and applied (zero is not missing)', async () => {
    await submit(correction({ editEventId: 'editevt_a1', correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 0 }));
    expect((await processed()).bblsTaken).toBe(0);
  });

  // 14
  it('an unmasked (echoed) field supersedes nothing — only the masked field applies', async () => {
    // A masks level→11. B masks bbls only but its wire ALSO echoes level 10;
    // because level is not in B's mask, A's level must survive.
    await submit(correction({ editEventId: 'editevt_a1', editedFields: ['tankLevelFeet'], correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', tankLevelFeet: 11, bblsTaken: 160 }));
    await submit(correction({ editEventId: 'editevt_b1', editedFields: ['bblsTaken'], correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', tankLevelFeet: 10, bblsTaken: 150 }));
    const p = await processed();
    expect(p.tankTopInches).toBe(132); // A's level preserved (B did not mask level)
    expect(p.bblsTaken).toBe(150);
    expect((await receiptOf('editevt_a1')).outcome).toBe('recorded_current'); // A still owns level
  });

  // 15
  it('pending ≠ applied: ingest alone does not change processed until delivery', async () => {
    const res = await ingest(correction({ editEventId: 'editevt_a1', correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 150 }));
    expect(res).toMatchObject({ ok: true, status: 'pending' });
    expect((await processed()).bblsTaken).toBe(BASE_BBLS); // still original
    expect(await receiptOf('editevt_a1')).toBeNull(); // no receipt yet
    await deliver('editevt_a1');
    expect((await processed()).bblsTaken).toBe(150);
  });

  // 16
  it('receipt is written only after history + materialization reconcile, with event-time + server time', async () => {
    await submit(correction({ editEventId: 'editevt_a1', correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 150 }));
    const r = await receiptOf('editevt_a1');
    const h = (await history()).editevt_a1;
    expect(r).toMatchObject({ status: 'accepted', editEventId: 'editevt_a1', originalPacketId: PID, outcome: 'recorded_current' });
    expect(r.correctionCreatedAtUTC).toBe('2026-08-24T10:30:00.000Z');
    expect(typeof r.serverAppliedAtUTC).toBe('string');
    expect(r.serverAppliedAtUTC).not.toBe(r.correctionCreatedAtUTC); // server time ≠ event time
    expect(h).toBeTruthy();
    expect(h.correctionCreatedAtUTC).toBe('2026-08-24T10:30:00.000Z');
  });

  // 17
  it('superseded events are preserved in the durable trail (not erased)', async () => {
    await submit(correction({ editEventId: 'editevt_a1', correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 150 }));
    await submit(correction({ editEventId: 'editevt_b1', correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', bblsTaken: 155 }));
    const h = await history();
    expect(Object.keys(h).sort()).toEqual(['editevt_a1', 'editevt_b1']); // both remain
    expect((await receiptOf('editevt_a1')).outcome).toBe('recorded_superseded'); // A superseded on its only field
    expect((await receiptOf('editevt_b1')).outcome).toBe('recorded_current');
  });

  // 18
  it('per-field receipt: partial supersede reports affected vs superseded fields', async () => {
    // A (older) changes level AND bbls; B (newer) changes bbls only (echoes the
    // baseline level, so it does not touch the level field).
    await submit(correction({ editEventId: 'editevt_a1', editedFields: ['tankLevelFeet', 'bblsTaken'], correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', tankLevelFeet: 11, bblsTaken: 150 }));
    await submit(correction({ editEventId: 'editevt_b1', editedFields: ['bblsTaken'], correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', tankLevelFeet: 10, bblsTaken: 155 }));
    const ra = await receiptOf('editevt_a1');
    expect(ra.outcome).toBe('recorded_partial');
    expect(ra.fieldsAffectingCurrent).toEqual(['tankTopInches']); // A still owns level
    expect(ra.fieldsSuperseded).toEqual(['bblsTaken']); // bbls superseded by B
    const p = await processed();
    expect(p.tankTopInches).toBe(132);
    expect(p.bblsTaken).toBe(155);
  });

  // 19 — the blocking defect: revert to the exact baseline value must win.
  it('older A sets level 11, newer B explicitly sets level back to 10 → final 10', async () => {
    await submit(correction({ editEventId: 'editevt_a1', editedFields: ['tankLevelFeet'], correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', tankLevelFeet: 11 }));
    await submit(correction({ editEventId: 'editevt_b1', editedFields: ['tankLevelFeet'], correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', tankLevelFeet: 10 }));
    expect((await processed()).tankTopInches).toBe(120); // 10 ft — B (newer) wins even though == baseline
    expect((await receiptOf('editevt_b1')).outcome).toBe('recorded_current');
    expect((await receiptOf('editevt_a1')).outcome).toBe('recorded_superseded');
  });

  // 20 — same case, B arrives FIRST, A (older) arrives late.
  it('revert-to-baseline holds when B arrives first and older A arrives late', async () => {
    await submit(correction({ editEventId: 'editevt_b1', editedFields: ['tankLevelFeet'], correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', tankLevelFeet: 10 }));
    await submit(correction({ editEventId: 'editevt_a1', editedFields: ['tankLevelFeet'], correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', tankLevelFeet: 11 }));
    expect((await processed()).tankTopInches).toBe(120); // B still authoritative
  });

  // 21 — level-only A + bbl-only B in FORWARD arrival order (reverse is #5).
  it('level-only A then bbls-only B (forward order) → both survive', async () => {
    await submit(correction({ editEventId: 'editevt_a1', editedFields: ['tankLevelFeet'], correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', tankLevelFeet: 11 }));
    await submit(correction({ editEventId: 'editevt_b1', editedFields: ['bblsTaken'], correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', bblsTaken: 150 }));
    const p = await processed();
    expect(p.tankTopInches).toBe(132); // A owns level
    expect(p.bblsTaken).toBe(150); // B owns bbls
  });

  // 22 — mask fail-closed at ingest.
  it('missing / empty / duplicate / unknown editedFields fail closed', async () => {
    const missingPkt = correction({ editEventId: 'editevt_m1', bblsTaken: 150 });
    delete (missingPkt as Record<string, unknown>).editedFields;
    expect(await ingest(missingPkt)).toMatchObject({ ok: false, status: 'invalid', reason: 'missing_editedFields' });
    expect(await ingest(correction({ editEventId: 'editevt_e1', editedFields: [], bblsTaken: 150 }))).toMatchObject({ ok: false, status: 'invalid', reason: 'empty_editedFields' });
    expect(await ingest(correction({ editEventId: 'editevt_d1', editedFields: ['bblsTaken', 'bblsTaken'], bblsTaken: 150 }))).toMatchObject({ ok: false, status: 'invalid', reason: 'duplicate_editedField' });
    expect(await ingest(correction({ editEventId: 'editevt_u1', editedFields: ['nope'], bblsTaken: 150 }))).toMatchObject({ ok: false, status: 'invalid', reason: 'unknown_editedField' });
    expect((await processed()).bblsTaken).toBe(BASE_BBLS); // nothing applied
  });

  // 23 — schemaVersion fail-closed at ingest.
  it('missing or invalid schemaVersion fails closed (never inferred, never legacy downgrade)', async () => {
    expect(await ingest(correction({ editEventId: 'editevt_a1', omitSchemaVersion: true, bblsTaken: 150 }))).toMatchObject({ ok: false, status: 'invalid', reason: 'missing_schemaVersion' });
    expect(await ingest(correction({ editEventId: 'editevt_a2', schemaVersion: 1, bblsTaken: 150 }))).toMatchObject({ ok: false, status: 'invalid', reason: 'invalid_schemaVersion' });
    expect((await processed()).bblsTaken).toBe(BASE_BBLS);
  });

  // 24 — same id, same complete payload → idempotent; different mask → conflict.
  it('same id/same payload is idempotent; same id/different mask conflicts', async () => {
    const a = correction({ editEventId: 'editevt_a1', editedFields: ['bblsTaken'], correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 150 });
    await submit(a);
    expect(await ingest(a)).toMatchObject({ ok: true, status: 'accepted' }); // idempotent
    const differentMask = correction({ editEventId: 'editevt_a1', editedFields: ['tankLevelFeet', 'bblsTaken'], correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 150 });
    expect(await ingest(differentMask)).toMatchObject({ ok: false, status: 'conflict' });
    expect(Object.keys(await history()).length).toBe(1);
  });

  // Shared readers for the interleaving tests (every mutable target).
  const effectOf = async (id: string) => (await db.ref(`packets/editHistory/${PID}/${id}/currentEffect`).once('value')).val();
  const wellCfg = async () => (await db.ref(`well_config/${WELL}`).once('value')).val();
  const perfRow = async (utc: string) => {
    const t = new Date(utc);
    const ts = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}_${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}${String(t.getSeconds()).padStart(2, '0')}`;
    return (await db.ref(`performance/${WELL.replace(/\s+/g, '_')}/rows/${ts}`).once('value')).val();
  };
  const outgoingRow = async () => {
    const s = await db.ref('packets/outgoing').orderByChild('wellName').equalTo(WELL).once('value');
    let row: any = null;
    s.forEach((c) => { row = c.val(); });
    return row;
  };

  // Same-field A(150) then newer B(155): B is authoritative, so a stale A write
  // would visibly corrupt state (bbls 150, A recorded_current). Assert every
  // mutable target reflects the authoritative A+B (revision-2) set instead.
  async function assertAuthoritativeAB(): Promise<void> {
    const p = await processed();
    const maxRev = Number(p.materializationRev);
    expect(maxRev).toBe(2); // two applies committed
    // Current processed materialization.
    expect(p.bblsTaken).toBe(155);
    // Immutable correction set + history (both events durable).
    expect(Object.keys(await history()).sort()).toEqual(['editevt_a1', 'editevt_b1']);
    expect(Object.keys(p.editCorrections).sort()).toEqual(['editevt_a1', 'editevt_b1']);
    // Every receipt + outcome (A superseded, B current).
    const ra = await receiptOf('editevt_a1');
    const rb = await receiptOf('editevt_b1');
    expect(ra.outcome).toBe('recorded_superseded');
    expect(ra.status).toBe('accepted'); // immutable core still present
    expect(ra.classificationRev).toBe(2); // fenced to the winning revision
    expect(rb.outcome).toBe('recorded_current');
    expect(rb.classificationRev).toBe(2);
    // Trail current-effect annotation.
    expect((await effectOf('editevt_a1')).outcome).toBe('recorded_superseded');
    expect((await effectOf('editevt_b1')).outcome).toBe('recorded_current');
    // Outgoing projection.
    const out = await outgoingRow();
    expect(out.lastPullBbls).toBe('155');
    expect(out.editSourceRev).toBe(2);
    // AFR (well_config) + performance projections fenced to revision 2.
    expect(Number((await wellCfg()).editSourceRev)).toBe(2);
    expect(Number((await perfRow(ORIGINAL_UTC)).editSourceRev)).toBe(2);
  }

  // TEST A — stale receipt/classification write.
  it('stale classification write is fenced: pause A before classification, B completes, A resumes', async () => {
    await ingest(correction({ editEventId: 'editevt_a1', editedFields: ['bblsTaken'], correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 150 }));
    await ingest(correction({ editEventId: 'editevt_b1', editedFields: ['bblsTaken'], correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', bblsTaken: 155 }));
    // A commits (rev 1), classifies itself recorded_current, then pauses right
    // before writing that classification; B completes revision 2 fully.
    idxMod.__v2FollowupBarrier.beforeClassification = async () => { await deliver('editevt_b1'); };
    await deliver('editevt_a1');
    await assertAuthoritativeAB(); // A's stale rev-1 classification never lands
  });

  // TEST B — stale projection write after passing the (now removed) guard.
  it('stale projection write is fenced: pause A before projections, B completes, A resumes', async () => {
    await ingest(correction({ editEventId: 'editevt_a1', editedFields: ['bblsTaken'], correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z', bblsTaken: 150 }));
    await ingest(correction({ editEventId: 'editevt_b1', editedFields: ['bblsTaken'], correctionCreatedAtUTC: '2026-08-24T10:45:00.000Z', bblsTaken: 155 }));
    // A commits (rev 1), writes its rev-1 classification, then pauses right
    // before its first projection write; B completes revision 2 fully.
    idxMod.__v2FollowupBarrier.beforeProjection = async () => { await deliver('editevt_b1'); };
    await deliver('editevt_a1');
    await assertAuthoritativeAB(); // A's stale rev-1 projections never land
  });
});
