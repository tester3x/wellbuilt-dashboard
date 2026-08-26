import { evaluateWbmEdit } from '../wbmEditAuthorize';
import { planWbmEditLifecycle } from '../wbmEditLifecycle';
import { runIngestWbmEdit } from '../ingestWbmEdit';

const PID = '20260823_112300_Gabriel5_fx0001';
const EVENT_A = 'editevt_fx0001_corr_a';
const DRIVER = 'driver-a';
const COMPANY = 'liquid-gold';

const original = {
  packetId: PID,
  wellName: 'Gabriel 5',
  driverId: DRIVER,
  companyId: COMPANY,
  dateTimeUTC: '2026-08-23T16:23:00.000Z',
  dateTime: '8/23/2026 11:23 AM',
  tankLevelFeet: 10.5,
  bblsTaken: 160,
};

const packet = {
  requestType: 'edit',
  schemaVersion: 2,
  editedFields: ['tankLevelFeet', 'bblsTaken'],
  wellName: 'Gabriel 5',
  originalPacketId: PID,
  packetId: PID,
  editEventId: EVENT_A,
  correctionCreatedAtUTC: '2026-08-24T10:30:00.000Z',
  tankLevelFeet: 9.5,
  bblsTaken: 140,
  wellDown: false,
  idempotencyKey: EVENT_A,
};

const scope = {
  companyId: COMPANY,
  driverId: DRIVER,
  assignedRoutes: ['Gabriels'],
  assignedWells: [],
  wellConfig: {
    'Gabriel 5': { route: 'Gabriels', companyId: COMPANY },
  },
};

describe('planWbmEditLifecycle', () => {
  it('preserves original operational event time when the edit omits it', () => {
    const decided = evaluateWbmEdit({ ...scope, packet, original });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    const plan = planWbmEditLifecycle({ original, payload: decided.payload });
    expect(plan).toMatchObject({
      ok: true,
      originalPacketId: PID,
      preservedOriginalEventTime: true,
      originalEventTimeUtc: '2026-08-23T16:23:00.000Z',
    });
    if (!('ok' in plan) || !plan.ok) return;
    expect(plan.processedPatch.dateTimeUTC).toBe('2026-08-23T16:23:00.000Z');
    expect(plan.processedPatch.bblsTaken).toBe(140);
    expect(plan.outgoingPatch.lastPullPacketId).toBe(PID);
  });
});

describe('runIngestWbmEdit', () => {
  it('pending while queued, accepted after receipt, conflict on different digest', async () => {
    const store: Record<string, Record<string, unknown>> = {};
    const receipts: Record<string, Record<string, unknown>> = {};
    const writeIncoming: Parameters<typeof runIngestWbmEdit>[0]['writeIncoming'] = async (path, decide) => {
      const current = store[path] || null;
      const gate = decide(current);
      if (gate.action === 'write') {
        store[path] = gate.stamped;
        return { committed: true, outcome: 'write', abortReason: '' };
      }
      if (gate.action === 'queued') {
        return { committed: true, outcome: 'queued', abortReason: '' };
      }
      return { committed: false, outcome: 'abort', abortReason: gate.reason };
    };
    const args = {
      ...scope,
      packet,
      uid: 'uid-a',
      displayName: 'Pat',
      authSource: 'secure',
      original,
      readReceipt: async (id: string) => receipts[id] || null,
      writeIncoming,
    };
    const first = await runIngestWbmEdit(args);
    expect(first).toMatchObject({
      ok: true,
      status: 'pending',
      originalPacketId: PID,
      editEventId: EVENT_A,
    });
    if (!first.ok) return;
    const queued = await runIngestWbmEdit(args);
    expect(queued).toMatchObject({ ok: true, status: 'pending', editEventId: EVENT_A });

    receipts[EVENT_A] = { payloadDigest: first.payloadDigest, status: 'accepted' };
    const applied = await runIngestWbmEdit(args);
    expect(applied).toMatchObject({ ok: true, status: 'accepted', editEventId: EVENT_A });

    const conflict = await runIngestWbmEdit({
      ...args,
      packet: { ...packet, bblsTaken: 165 },
    });
    expect(conflict).toMatchObject({ ok: false, status: 'conflict' });
  });

  it('invalidates cross-company, cross-driver, missing owner, and unassigned wells', async () => {
    const writeIncoming: Parameters<typeof runIngestWbmEdit>[0]['writeIncoming'] = async () => {
      throw new Error('must_not_write');
    };
    const readReceipt = async () => null;
    const base = {
      ...scope,
      packet,
      uid: 'uid-a',
      displayName: 'Pat',
      authSource: 'secure',
      original,
      readReceipt,
      writeIncoming,
    };
    expect(await runIngestWbmEdit({
      ...base,
      original: { ...original, driverId: 'other-driver' },
    })).toMatchObject({ ok: false, status: 'invalid', reason: 'cross_driver' });
    expect(await runIngestWbmEdit({
      ...base,
      original: { ...original, driverId: undefined },
    })).toMatchObject({ ok: false, status: 'invalid', reason: 'original_owner_unavailable' });
    expect(await runIngestWbmEdit({
      ...base,
      wellConfig: { 'Gabriel 5': { route: 'Gabriels', companyId: 'other-co' } },
    })).toMatchObject({ ok: false, status: 'invalid', reason: 'cross_company_well' });
    expect(await runIngestWbmEdit({
      ...base,
      assignedRoutes: ['Watford'],
      assignedWells: [],
    })).toMatchObject({ ok: false, status: 'invalid', reason: 'well_out_of_scope' });
  });
});
