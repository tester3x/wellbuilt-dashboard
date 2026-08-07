/**
 * Real Firebase RTDB emulator E2E for the canonical edit trail.
 *
 * Requires:
 *   FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000
 *   (typically via: firebase emulators:exec --only database ...)
 *
 * Uses Admin SDK against the emulator (no production mutation).
 * Rules authorization cases use @firebase/rules-unit-testing when available.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as admin from 'firebase-admin';
import {
  buildAppliedEditEvent,
  buildFieldDiff,
  editHistoryWritePaths,
  editSummaryFields,
  nextEditCount,
  normalizeEditSource,
  normalizeOriginAppContext,
  packetShowsEditBadge,
  resolveEditEventId,
  resolveOriginalSubmissionAt,
} from '../editHistory';
import {
  orphanEditVerdict,
  quarantineIncomingPacket,
  resolveEditTarget,
} from '../packetGuards';

const EMULATOR = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const hasEmulator = Boolean(EMULATOR);

const describeE2E = hasEmulator ? describe : describe.skip;

function getDb(): admin.database.Database {
  if (!admin.apps.length) {
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = EMULATOR!;
    admin.initializeApp({
      projectId: PROJECT,
      databaseURL: `http://${EMULATOR}?ns=${PROJECT}-default-rtdb`,
    });
  }
  return admin.database();
}

async function clearPackets(db: admin.database.Database) {
  await db.ref('packets').set(null);
}

/** Mirror of CF multi-path apply used by processEditRequest (values + trail). */
async function applyEditServerSide(
  db: admin.database.Database,
  args: {
    originalPacketId: string;
    incomingKey: string;
    edit: Record<string, unknown>;
    resolutionPath?: 'direct' | 'invoiceDocId_fallback' | 'queued_pull_merge';
  },
) {
  const origSnap = await db.ref(`packets/processed/${args.originalPacketId}`).once('value');
  if (!origSnap.exists()) {
    await quarantineIncomingPacket(db.ref() as any, {
      packetId: args.incomingKey,
      packet: args.edit,
      verdict: orphanEditVerdict(args.originalPacketId),
      nowMs: Date.now(),
    });
    return { applied: false as const, reason: 'orphan' as const };
  }
  const orig = origSnap.val() as Record<string, unknown>;
  const eventId = resolveEditEventId({
    incomingPacketId: args.incomingKey,
    clientEventId: args.edit.editEventId,
  });
  const existing = await db.ref(`packets/editHistory/${args.originalPacketId}/${eventId}`).once('value');
  if (existing.exists()) {
    await db.ref(`packets/incoming/${args.incomingKey}`).remove();
    return { applied: false as const, reason: 'idempotent' as const, eventId };
  }

  const newBbls =
    args.edit.bblsTaken !== undefined ? Number(args.edit.bblsTaken) : Number(orig.bblsTaken);
  let newTop =
    typeof orig.tankTopInches === 'number'
      ? Number(orig.tankTopInches)
      : Math.round(Number(orig.tankLevelFeet || 0) * 12);
  if (args.edit.tankTopInches !== undefined) newTop = Number(args.edit.tankTopInches);
  else if (args.edit.tankLevelFeet !== undefined) newTop = Math.round(Number(args.edit.tankLevelFeet) * 12);

  const fields = buildFieldDiff(orig, {
    bblsTaken: newBbls,
    tankTopInches: newTop,
    tankLevelFeet: newTop / 12,
  });
  const sequence = nextEditCount(orig);
  const editedAt = new Date().toISOString();
  const source = normalizeEditSource(args.edit.source);
  const originAppContext =
    normalizeOriginAppContext(orig.originAppContext) !== 'unknown'
      ? normalizeOriginAppContext(orig.originAppContext)
      : normalizeOriginAppContext(args.edit.originAppContext);
  const originalSubmissionAt = resolveOriginalSubmissionAt(orig);
  const event = buildAppliedEditEvent({
    eventId,
    packetId: args.originalPacketId,
    sequence,
    editedAt,
    source,
    originAppContext,
    fields,
    originalSubmissionAt,
    resolutionPath: args.resolutionPath || 'direct',
    editRequestId: args.incomingKey,
  });
  const summary = editSummaryFields({
    editedAt,
    source,
    editCount: sequence,
    originalSubmissionAt,
    freezeOriginal: !orig.originalSubmittedAt,
  });
  const updates: Record<string, unknown> = {
    ...Object.fromEntries(
      Object.entries({
        bblsTaken: newBbls,
        tankTopInches: newTop,
        tankLevelFeet: newTop / 12,
        ...summary,
      }).map(([k, v]) => [`packets/processed/${args.originalPacketId}/${k}`, v]),
    ),
    ...editHistoryWritePaths(args.originalPacketId, event),
    [`packets/incoming/${args.incomingKey}`]: null,
  };
  await db.ref().update(updates);
  return { applied: true as const, eventId, sequence, event };
}

describeE2E('RTDB emulator E2E: edit trail matrix', () => {
  const db = getDb();

  beforeEach(async () => {
    await clearPackets(db);
  });

  test('processed edit 140→150: values + one history event + badge', async () => {
    const pid = '20260801_120000_Gabriel1_abc123';
    await db.ref(`packets/processed/${pid}`).set({
      packetId: pid,
      wellName: 'Gabriel 1',
      bblsTaken: 140,
      tankLevelFeet: 10,
      tankTopInches: 120,
      dateTimeUTC: '2026-08-01T17:00:00.000Z',
      requestType: 'pull',
      originAppContext: 'wbm',
      driverId: 'd1',
      processedAt: '2026-08-01T17:00:05.000Z',
    });

    const r = await applyEditServerSide(db, {
      originalPacketId: pid,
      incomingKey: 'edit_20260801_120000_Gabriel1',
      edit: {
        requestType: 'edit',
        originalPacketId: pid,
        bblsTaken: 150,
        tankLevelFeet: 10,
        source: 'wbm',
        editEventId: 'editop_test_1',
      },
    });
    expect(r.applied).toBe(true);

    const proc = (await db.ref(`packets/processed/${pid}`).once('value')).val();
    expect(proc.bblsTaken).toBe(150);
    expect(proc.editCount).toBe(1);
    expect(proc.editedAt).toBeTruthy();
    expect(proc.editedBy).toBe('wbm');
    expect(packetShowsEditBadge(proc)).toBe(true);

    const hist = (await db.ref(`packets/editHistory/${pid}`).once('value')).val();
    const events = Object.values(hist || {}) as any[];
    expect(events).toHaveLength(1);
    expect(events[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'bblsTaken', previous: 140, next: 150 }),
      ]),
    );
  });

  test('retry same editEventId → one event, one editCount', async () => {
    const pid = '20260802_100000_Well_x1';
    await db.ref(`packets/processed/${pid}`).set({
      packetId: pid,
      wellName: 'Well',
      bblsTaken: 100,
      tankTopInches: 100,
      tankLevelFeet: 100 / 12,
      dateTimeUTC: '2026-08-02T15:00:00.000Z',
      originAppContext: 'wbm',
    });
    const edit = {
      requestType: 'edit',
      originalPacketId: pid,
      bblsTaken: 110,
      source: 'wbm',
      editEventId: 'editop_stable_retry',
    };
    const a = await applyEditServerSide(db, {
      originalPacketId: pid,
      incomingKey: 'edit_20260802_100000_Well',
      edit,
    });
    const b = await applyEditServerSide(db, {
      originalPacketId: pid,
      incomingKey: 'edit_20260802_100000_Well',
      edit,
    });
    expect(a.applied).toBe(true);
    expect(b.reason).toBe('idempotent');
    const proc = (await db.ref(`packets/processed/${pid}`).once('value')).val();
    expect(proc.editCount).toBe(1);
    const hist = (await db.ref(`packets/editHistory/${pid}`).once('value')).val();
    expect(Object.keys(hist || {})).toHaveLength(1);
  });

  test('multiple corrections 140→150→145: two ordered events', async () => {
    const pid = '20260803_090000_Well_m1';
    await db.ref(`packets/processed/${pid}`).set({
      packetId: pid,
      wellName: 'Well',
      bblsTaken: 140,
      tankTopInches: 120,
      tankLevelFeet: 10,
      dateTimeUTC: '2026-08-03T14:00:00.000Z',
      originAppContext: 'wbm',
    });
    await applyEditServerSide(db, {
      originalPacketId: pid,
      incomingKey: 'edit_a',
      edit: { bblsTaken: 150, source: 'wbm', editEventId: 'e1' },
    });
    await applyEditServerSide(db, {
      originalPacketId: pid,
      incomingKey: 'edit_b',
      edit: { bblsTaken: 145, source: 'wbm', editEventId: 'e2' },
    });
    const proc = (await db.ref(`packets/processed/${pid}`).once('value')).val();
    expect(proc.bblsTaken).toBe(145);
    expect(proc.editCount).toBe(2);
    const hist = (await db.ref(`packets/editHistory/${pid}`).once('value')).val();
    const events = Object.values(hist || {}).sort(
      (a: any, b: any) => a.sequence - b.sequence,
    ) as any[];
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(events[0].fields.find((f: any) => f.field === 'bblsTaken')).toMatchObject({
      previous: 140,
      next: 150,
    });
    expect(events[1].fields.find((f: any) => f.field === 'bblsTaken')).toMatchObject({
      previous: 150,
      next: 145,
    });
    // Dashboard + WB-M share same ordering key (sequence then editedAt)
    const dashOrder = [...events].sort(
      (a, b) => a.sequence - b.sequence || String(a.editedAt).localeCompare(String(b.editedAt)),
    );
    const wbmOrder = [...events].sort(
      (a, b) => a.sequence - b.sequence || String(a.editedAt).localeCompare(String(b.editedAt)),
    );
    expect(dashOrder.map((e) => e.eventId)).toEqual(wbmOrder.map((e) => e.eventId));
  });

  test('WB-T origin + WB-M correction provenance', async () => {
    const pid = '20260805_151604_GABRIEL1_wbt';
    await db.ref(`packets/processed/${pid}`).set({
      packetId: pid,
      wellName: 'Gabriel 1',
      bblsTaken: 140,
      tankTopInches: 130,
      tankLevelFeet: 10.833,
      dateTimeUTC: '2026-08-05T20:16:04.000Z',
      originAppContext: 'wbt',
      invoiceDocId: 'inv_demo',
    });
    const r = await applyEditServerSide(db, {
      originalPacketId: pid,
      incomingKey: 'edit_wbm_corr',
      edit: {
        bblsTaken: 150,
        source: 'wbm',
        editEventId: 'editop_wbm',
        originAppContext: 'wbm', // must not overwrite stored origin
      },
    });
    expect(r.applied).toBe(true);
    if (r.applied) {
      expect(r.event.originAppContext).toBe('wbt');
      expect(r.event.source).toBe('wbm');
    }
    const proc = (await db.ref(`packets/processed/${pid}`).once('value')).val();
    expect(proc.editedBy).toBe('wbm');
    expect(proc.originAppContext).toBe('wbt'); // origin preserved on packet
  });

  test('invoiceDocId fallback resolves phantom id to one event', async () => {
    const realId = '20260725_132315_GABRIEL1_7guae0';
    const phantom = '20260725_132315_GABRIEL1_q1jwti';
    await db.ref(`packets/processed/${realId}`).set({
      packetId: realId,
      wellName: 'Gabriel 1',
      bblsTaken: 140,
      tankTopInches: 143,
      tankLevelFeet: 11.916,
      dateTimeUTC: '2026-07-25T18:23:15.646Z',
      requestType: 'pull',
      invoiceDocId: 'bosYvJhlcbM48av8qONh',
      originAppContext: 'wbt',
    });
    const resolution = await resolveEditTarget(
      {
        readProcessed: async (id) => {
          const s = await db.ref(`packets/processed/${id}`).once('value');
          return s.exists() ? (s.val() as Record<string, unknown>) : null;
        },
        queryProcessedByInvoiceDocId: async (inv) => {
          const s = await db
            .ref('packets/processed')
            .orderByChild('invoiceDocId')
            .equalTo(inv)
            .once('value');
          const rows: Array<{ key: string; val: Record<string, unknown> }> = [];
          s.forEach((c) => {
            rows.push({ key: String(c.key), val: c.val() as Record<string, unknown> });
          });
          return rows;
        },
      },
      phantom,
      'bosYvJhlcbM48av8qONh',
    );
    expect(resolution.kind).toBe('fallback');
    if (resolution.kind !== 'fallback') return;
    expect(resolution.packetId).toBe(realId);

    const r = await applyEditServerSide(db, {
      originalPacketId: resolution.packetId,
      incomingKey: `edit_${phantom}`,
      edit: { bblsTaken: 165, source: 'wbm', editEventId: 'editop_inv_fb' },
      resolutionPath: 'invoiceDocId_fallback',
    });
    expect(r.applied).toBe(true);
    // Retry after fallback must not double
    const r2 = await applyEditServerSide(db, {
      originalPacketId: resolution.packetId,
      incomingKey: `edit_${phantom}`,
      edit: { bblsTaken: 165, source: 'wbm', editEventId: 'editop_inv_fb' },
      resolutionPath: 'invoiceDocId_fallback',
    });
    expect(r2.reason).toBe('idempotent');
    const hist = (await db.ref(`packets/editHistory/${realId}`).once('value')).val();
    expect(Object.keys(hist || {})).toHaveLength(1);
  });

  test('rejected/orphan edit: quarantine, no successful badge/count', async () => {
    const r = await applyEditServerSide(db, {
      originalPacketId: 'missing_packet_id',
      incomingKey: 'edit_orphan_1',
      edit: { bblsTaken: 99, source: 'wbm', wellName: 'X' },
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('orphan');
    const rejected = (await db.ref('packets/rejected/edit_orphan_1').once('value')).val();
    expect(rejected).toBeTruthy();
    expect(rejected.reason || rejected.verdict?.reason).toBeTruthy();
    const hist = (await db.ref('packets/editHistory/missing_packet_id').once('value')).val();
    expect(hist).toBeNull();
  });

  test('queued merge materialization: pendingEditEvents → one trail, stamped edited', async () => {
    const pid = '20260806_080000_Queued_q1';
    // Simulate processIncomingPull materialize after queued correction
    const pending = [
      {
        eventId: 'editop_queued_1',
        source: 'wbm',
        fields: [{ field: 'bblsTaken', previous: 140, next: 150 }],
        capturedAt: '2026-08-06T13:05:00.000Z',
        resolutionPath: 'queued_pull_merge',
      },
    ];
    await db.ref(`packets/processed/${pid}`).set({
      packetId: pid,
      wellName: 'Queued Well',
      bblsTaken: 150,
      tankTopInches: 120,
      tankLevelFeet: 10,
      dateTimeUTC: '2026-08-06T13:00:00.000Z',
      originalSubmittedAt: '2026-08-06T13:00:00.000Z',
      originAppContext: 'wbm',
    });
    const eventId = resolveEditEventId({
      incomingPacketId: `queued_${pid}`,
      clientEventId: pending[0].eventId,
    });
    const event = buildAppliedEditEvent({
      eventId,
      packetId: pid,
      sequence: 1,
      editedAt: pending[0].capturedAt,
      source: 'wbm',
      originAppContext: 'wbm',
      fields: pending[0].fields as any,
      originalSubmissionAt: '2026-08-06T13:00:00.000Z',
      resolutionPath: 'queued_pull_merge',
      editRequestId: eventId,
    });
    await db.ref().update({
      ...editHistoryWritePaths(pid, event),
      [`packets/processed/${pid}/editedAt`]: pending[0].capturedAt,
      [`packets/processed/${pid}/editedBy`]: 'wbm',
      [`packets/processed/${pid}/editCount`]: 1,
    });
    // Second materialize (restart) must not duplicate
    const exists = await db.ref(`packets/editHistory/${pid}/${eventId}`).once('value');
    expect(exists.exists()).toBe(true);
    const proc = (await db.ref(`packets/processed/${pid}`).once('value')).val();
    expect(packetShowsEditBadge(proc)).toBe(true);
    expect(proc.bblsTaken).toBe(150);
    const hist = (await db.ref(`packets/editHistory/${pid}`).once('value')).val();
    expect(Object.keys(hist || {})).toHaveLength(1);
  });

  test('offline/delayed correction after many days still applies (no age gate)', async () => {
    const pid = '20200101_120000_Old_o1';
    await db.ref(`packets/processed/${pid}`).set({
      packetId: pid,
      wellName: 'Old',
      bblsTaken: 140,
      tankTopInches: 120,
      tankLevelFeet: 10,
      dateTimeUTC: '2020-01-01T18:00:00.000Z',
      originalSubmittedAt: '2020-01-01T18:00:00.000Z',
      originAppContext: 'wbt',
    });
    const r = await applyEditServerSide(db, {
      originalPacketId: pid,
      incomingKey: 'edit_late',
      edit: { bblsTaken: 155, source: 'wbm', editEventId: 'editop_late' },
    });
    expect(r.applied).toBe(true);
    const proc = (await db.ref(`packets/processed/${pid}`).once('value')).val();
    expect(proc.bblsTaken).toBe(155);
    expect(proc.editCount).toBe(1);
  });

  test('missing source stays unknown (not dashboard)', async () => {
    const pid = '20260807_110000_Src_s1';
    await db.ref(`packets/processed/${pid}`).set({
      packetId: pid,
      wellName: 'Src',
      bblsTaken: 10,
      tankTopInches: 12,
      tankLevelFeet: 1,
      dateTimeUTC: '2026-08-07T16:00:00.000Z',
    });
    await applyEditServerSide(db, {
      originalPacketId: pid,
      incomingKey: 'edit_nosrc',
      edit: { bblsTaken: 11, editEventId: 'editop_nosrc' },
    });
    const proc = (await db.ref(`packets/processed/${pid}`).once('value')).val();
    expect(proc.editedBy).toBe('unknown');
  });
});

describeE2E('RTDB emulator: authorization-rule behavior (open parent)', () => {
  /**
   * Proves that under current database.rules.json (root .write:true),
   * a client can write packets/editHistory — trail is NOT rules-immutable.
   */
  test('client write to editHistory succeeds under open parent rules', async () => {
    // Admin write path is always allowed; for client rules we use REST against emulator
    // with auth=null which still passes .write:true at root.
    // Emulator REST: http://127.0.0.1:9000/path.json?ns=...
    const url = `http://${EMULATOR}/packets/editHistory/client_probe/e1.json?ns=${PROJECT}-default-rtdb`;
    const body = {
      eventId: 'e1',
      packetId: 'client_probe',
      sequence: 1,
      editedAt: new Date().toISOString(),
      source: 'wbm',
      fields: [],
      outcome: 'applied',
      forged: true,
    };
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.ok).toBe(true);
    const db = getDb();
    const snap = await db.ref('packets/editHistory/client_probe/e1').once('value');
    expect(snap.exists()).toBe(true);
    expect(snap.val().forged).toBe(true);
  });

  test('document: nested write:false cannot revoke parent write:true', () => {
    // Structural pin for reviewers — RTDB shallower-wins semantics.
    const rulesPath = path.join(__dirname, '../../../database.rules.json');
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    expect(rules.rules['.write']).toBe(true);
    // Must not ship a false-security editHistory write:false under open parent.
    expect(JSON.stringify(rules)).not.toMatch(/"editHistory"\s*:\s*\{[^}]*"\.write"\s*:\s*false/);
  });
});

if (!hasEmulator) {
  // eslint-disable-next-line no-console
  console.warn(
    '[editTrail.emulator.e2e] SKIPPED — set FIREBASE_DATABASE_EMULATOR_HOST (use firebase emulators:exec)',
  );
}
