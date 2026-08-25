import {
  decideWbmEditReceipt,
  decideWbmEditTransaction,
  evaluateWbmEdit,
  isAbsoluteInstant,
  resolveOriginalEditAuthority,
} from '../wbmEditAuthorize';

const PID = '20260823_112300_Gabriel2_abc123';
const EVENT_A = 'editevt_g2_corr_a';
const EVENT_B = 'editevt_g2_corr_b';

const basePacket = {
  requestType: 'edit',
  wellName: 'Gabriel 2',
  originalPacketId: PID,
  packetId: PID,
  editEventId: EVENT_A,
  tankLevelFeet: 10.5,
  bblsTaken: 140,
  wellDown: false,
  idempotencyKey: EVENT_A,
};

const original = {
  packetId: PID,
  wellName: 'Gabriel 2',
  driverId: 'driver-a',
  companyId: 'liquid-gold',
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

describe('isAbsoluteInstant', () => {
  it('accepts Z and numeric offsets; rejects offsetless', () => {
    expect(isAbsoluteInstant('2026-08-23T16:40:00.000Z')).toBe(true);
    expect(isAbsoluteInstant('2026-08-23T11:40:00-05:00')).toBe(true);
    expect(isAbsoluteInstant('2026-08-23T16:40:00')).toBe(false);
    expect(isAbsoluteInstant('')).toBe(false);
  });
});

describe('resolveOriginalEditAuthority', () => {
  it('fails closed when original driverId is missing — well assignment is not ownership', () => {
    expect(resolveOriginalEditAuthority({
      original: { ...original, driverId: '' },
      driverId: 'driver-a',
      companyId: 'liquid-gold',
    }).ok).toBe(false);
    expect((resolveOriginalEditAuthority({
      original: { wellName: 'Gabriel 2', companyId: 'liquid-gold' },
      driverId: 'driver-a',
      companyId: 'liquid-gold',
    }) as { reason: string }).reason).toBe('original_owner_unavailable');
  });

  it('fails closed when original companyId is missing', () => {
    expect((resolveOriginalEditAuthority({
      original: { ...original, companyId: undefined },
      driverId: 'driver-a',
      companyId: 'liquid-gold',
    }) as { reason: string }).reason).toBe('original_company_unavailable');
  });
});

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
    expect(decided.editEventId).toBe(EVENT_A);
    expect(decided.originalPacketId).toBe(PID);
    expect(decided.payload.packetId).toBe(PID);
    expect(decided.payload.driverId).toBeUndefined();
  });

  it('includes operational time only when the user explicitly sent an offset-aware instant', () => {
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

  it('rejects offsetless explicit timestamps', () => {
    expect((evaluateWbmEdit({
      ...scope,
      packet: { ...basePacket, dateTimeUTC: '2026-08-23T16:40:00' },
      original,
    }) as { reason: string }).reason).toBe('invalid_dateTimeUTC');
  });

  it('requires a distinct client-minted editEventId and does not remint originalPacketId', () => {
    expect((evaluateWbmEdit({
      ...scope,
      packet: { ...basePacket, editEventId: undefined },
      original,
    }) as { reason: string }).reason).toBe('missing_editEventId');
    expect((evaluateWbmEdit({
      ...scope,
      packet: { ...basePacket, editEventId: PID, idempotencyKey: PID },
      original,
    }) as { reason: string }).reason).toBe('editEventId_collides_with_original');
    const a = evaluateWbmEdit({ ...scope, packet: basePacket, original });
    const b = evaluateWbmEdit({
      ...scope,
      packet: { ...basePacket, editEventId: EVENT_B, idempotencyKey: EVENT_B, bblsTaken: 130 },
      original,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.editEventId).not.toBe(b.editEventId);
    expect(a.originalPacketId).toBe(b.originalPacketId);
  });

  it('rejects missing original with no implied write', () => {
    expect(evaluateWbmEdit({ ...scope, packet: basePacket, original: null }).ok).toBe(false);
    expect((evaluateWbmEdit({ ...scope, packet: basePacket, original: null }) as { reason: string }).reason)
      .toBe('missing_original');
  });

  it('rejects missing original owner even when the well is currently assigned', () => {
    expect((evaluateWbmEdit({
      ...scope,
      packet: basePacket,
      original: { ...original, driverId: undefined },
    }) as { reason: string }).reason).toBe('original_owner_unavailable');
  });

  it('rejects cross-driver, cross-company, forged-well, and malformed edits', () => {
    expect((evaluateWbmEdit({
      ...scope,
      packet: basePacket,
      original: { ...original, driverId: 'driver-b' },
    }) as { reason: string }).reason).toBe('cross_driver');
    expect((evaluateWbmEdit({
      ...scope,
      packet: { ...basePacket, wellName: 'Gabriel 1', idempotencyKey: EVENT_A },
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
      packet: basePacket,
      original: { ...original, companyId: 'other-co' },
    }) as { reason: string }).reason).toBe('cross_company');
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

  it('same digest on incoming is queued; different digest is conflict; applied receipt is accepted', () => {
    const a = evaluateWbmEdit({ ...scope, packet: basePacket, original });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(decideWbmEditTransaction({
      existing: { driverId: 'driver-a', payloadDigest: a.payloadDigest },
      driverId: 'driver-a',
      payloadDigest: a.payloadDigest,
    }).action).toBe('queued');
    expect(decideWbmEditTransaction({
      existing: { driverId: 'driver-a', payloadDigest: 'other' },
      driverId: 'driver-a',
      payloadDigest: a.payloadDigest,
    }).action).toBe('abort');
    expect(decideWbmEditReceipt({
      receipt: { payloadDigest: a.payloadDigest, status: 'accepted' },
      payloadDigest: a.payloadDigest,
    }).action).toBe('accepted');
    expect(decideWbmEditReceipt({
      receipt: { payloadDigest: 'other', status: 'accepted' },
      payloadDigest: a.payloadDigest,
    }).action).toBe('abort');
  });
});
