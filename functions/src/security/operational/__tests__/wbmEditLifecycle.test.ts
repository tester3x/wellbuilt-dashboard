import { evaluateWbmEdit, expectedEditIdempotencyKey } from '../wbmEditAuthorize';
import { applyWbmEditLifecycle, planWbmEditLifecycle } from '../wbmEditLifecycle';
import { runIngestWbmEdit } from '../ingestWbmEdit';

const PID = '20260823_112300_Gabriel5_orig';
const KEY = expectedEditIdempotencyKey(PID, 'Gabriel 5') as string;
const DRIVER = 'driver-a';
const COMPANY = 'liquid-gold';

const original = {
  packetId: PID,
  wellName: 'Gabriel 5',
  driverId: DRIVER,
  dateTimeUTC: '2026-08-23T16:23:00.000Z',
  dateTime: '8/23/2026 11:23 AM',
  tankLevelFeet: 10.5,
  bblsTaken: 160,
};

const packet = {
  requestType: 'edit',
  wellName: 'Gabriel 5',
  originalPacketId: PID,
  packetId: PID,
  tankLevelFeet: 9.5,
  bblsTaken: 140,
  wellDown: false,
  idempotencyKey: KEY,
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
  it('pending write, exact replay is duplicate, different digest is conflict', async () => {
    const store: Record<string, Record<string, unknown>> = {};
    const writeIncoming: Parameters<typeof runIngestWbmEdit>[0]['writeIncoming'] = async (path, decide) => {
      const current = store[path] || null;
      const gate = decide(current);
      if (gate.action === 'write') {
        store[path] = gate.stamped;
        return { committed: true, outcome: 'write', abortReason: '' };
      }
      if (gate.action === 'duplicate') {
        return { committed: true, outcome: 'duplicate', abortReason: '' };
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
      writeIncoming,
    };
    const first = await runIngestWbmEdit(args);
    expect(first).toMatchObject({ ok: true, status: 'pending', originalPacketId: PID, idempotencyKey: KEY });
    const replay = await runIngestWbmEdit(args);
    expect(replay).toMatchObject({ ok: true, status: 'duplicate', originalPacketId: PID });
    const conflict = await runIngestWbmEdit({
      ...args,
      packet: { ...packet, bblsTaken: 165 },
    });
    expect(conflict).toMatchObject({ ok: false, status: 'conflict' });
  });

  it('invalidates cross-company, cross-driver, and unassigned wells', async () => {
    const writeIncoming: Parameters<typeof runIngestWbmEdit>[0]['writeIncoming'] = async () => {
      throw new Error('must_not_write');
    };
    const base = {
      ...scope,
      packet,
      uid: 'uid-a',
      displayName: 'Pat',
      authSource: 'secure',
      original,
      writeIncoming,
    };
    expect(await runIngestWbmEdit({
      ...base,
      original: { ...original, driverId: 'other-driver' },
    })).toMatchObject({ ok: false, status: 'invalid', reason: 'cross_driver' });
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

describe('applyWbmEditLifecycle outgoing visibility', () => {
  it('patches processed and matching outgoing without reminting the original id', async () => {
    const tree: Record<string, unknown> = {
      [`packets/processed/${PID}`]: { ...original },
      'packets/outgoing/response_g5': {
        wellName: 'Gabriel 5',
        lastPullPacketId: PID,
        lastPullBbls: '160',
        lastPullDateTimeUTC: original.dateTimeUTC,
      },
    };
    const decided = evaluateWbmEdit({ ...scope, packet, original });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    const plan = planWbmEditLifecycle({ original, payload: decided.payload });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    await applyWbmEditLifecycle({
      plan,
      update: async (path, values) => {
        const cur = (tree[path] && typeof tree[path] === 'object')
          ? tree[path] as Record<string, unknown>
          : {};
        tree[path] = { ...cur, ...values };
      },
      readOutgoing: async () => ({
        response_g5: tree['packets/outgoing/response_g5'],
      }),
    });
    expect(tree[`packets/processed/${PID}`]).toMatchObject({
      packetId: PID,
      bblsTaken: 140,
      dateTimeUTC: original.dateTimeUTC,
    });
    expect(tree['packets/outgoing/response_g5']).toMatchObject({
      isEdit: true,
      originalPacketId: PID,
      lastPullPacketId: PID,
      lastPullBbls: '140',
      lastPullDateTimeUTC: original.dateTimeUTC,
    });
  });
});
