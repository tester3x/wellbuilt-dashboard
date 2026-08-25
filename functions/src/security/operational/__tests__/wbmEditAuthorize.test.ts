import {
  decideWbmEditTransaction,
  evaluateWbmEdit,
  expectedEditIdempotencyKey,
} from '../wbmEditAuthorize';

const PID = '20260823_112300_Gabriel2_abc123';
const KEY = expectedEditIdempotencyKey(PID, 'Gabriel 2') as string;

const basePacket = {
  requestType: 'edit',
  wellName: 'Gabriel 2',
  originalPacketId: PID,
  packetId: PID,
  tankLevelFeet: 10.5,
  bblsTaken: 140,
  wellDown: false,
  idempotencyKey: KEY,
};

const original = {
  packetId: PID,
  wellName: 'Gabriel 2',
  driverId: 'driver-a',
  dateTimeUTC: '2026-08-23T16:23:00.000Z',
  dateTime: '8/23/2026 11:23 AM',
  tankLevelFeet: 10.5,
  bblsTaken: 160,
};

const scope = {
  companyId: 'liquid-gold',
  driverId: 'driver-a',
  assignedRoutes: ['Gabriels'],
  assignedWells: [],
  wellConfig: { 'Gabriel 2': { route: 'Gabriels', companyId: 'liquid-gold' } },
};

describe('evaluateWbmEdit', () => {
  it('accepts a valid level/BBL edit and omits empty operational time', () => {
    const decided = evaluateWbmEdit({
      ...scope,
      packet: { ...basePacket, dateTime: '', dateTimeUTC: '' },
      original,
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.payload.dateTimeUTC).toBeUndefined();
    expect(decided.payload.dateTime).toBeUndefined();
    expect(decided.idempotencyKey).toBe(KEY);
    expect(decided.payload.driverId).toBeUndefined();
  });

  it('includes operational time only when the user explicitly sent it', () => {
    const decided = evaluateWbmEdit({
      ...scope,
      packet: {
        ...basePacket,
        dateTimeUTC: '2026-08-23T16:40:00.000Z',
        dateTime: '8/23/2026 11:40 AM',
      },
      original,
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.payload.dateTimeUTC).toBe('2026-08-23T16:40:00.000Z');
  });

  it('rejects missing original with no implied write', () => {
    expect(evaluateWbmEdit({ ...scope, packet: basePacket, original: null }).ok).toBe(false);
    expect((evaluateWbmEdit({ ...scope, packet: basePacket, original: null }) as { reason: string }).reason)
      .toBe('missing_original');
  });

  it('rejects cross-driver, cross-company, forged-well, and malformed edits', () => {
    expect((evaluateWbmEdit({
      ...scope,
      packet: basePacket,
      original: { ...original, driverId: 'driver-b' },
    }) as { reason: string }).reason).toBe('cross_driver');
    expect((evaluateWbmEdit({
      ...scope,
      packet: { ...basePacket, wellName: 'Gabriel 1', idempotencyKey: expectedEditIdempotencyKey(PID, 'Gabriel 1') },
      original,
    }) as { reason: string }).reason).toBe('forged_well');
    expect((evaluateWbmEdit({
      ...scope,
      wellConfig: { 'Gabriel 2': { route: 'Gabriels', companyId: 'other-co' } },
      packet: basePacket,
      original,
    }) as { reason: string }).reason).toBe('cross_company_well');
    expect((evaluateWbmEdit({
      ...scope,
      packet: { ...basePacket, bblsTaken: '140' },
      original,
    }) as { reason: string }).reason).toBe('invalid_bblsTaken');
    expect((evaluateWbmEdit({
      ...scope,
      packet: { ...basePacket, extra: true },
      original,
    }) as { reason: string }).reason).toBe('unexpected_field');
  });

  it('rejects an unassigned well in the same company', () => {
    expect((evaluateWbmEdit({
      ...scope,
      assignedRoutes: ['Watford'],
      assignedWells: [],
      packet: basePacket,
      original,
    }) as { reason: string }).reason).toBe('well_out_of_scope');
  });

  it('same digest is a duplicate; different digest after write is a conflict', () => {
    const a = evaluateWbmEdit({ ...scope, packet: basePacket, original });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(decideWbmEditTransaction({
      existing: { driverId: 'driver-a', payloadDigest: a.payloadDigest },
      driverId: 'driver-a',
      payloadDigest: a.payloadDigest,
    }).action).toBe('duplicate');
    expect(decideWbmEditTransaction({
      existing: { driverId: 'driver-a', payloadDigest: 'other' },
      driverId: 'driver-a',
      payloadDigest: a.payloadDigest,
    }).action).toBe('abort');
  });
});
