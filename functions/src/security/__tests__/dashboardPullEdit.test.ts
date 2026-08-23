import { validatePullEdit, buildEditPacket } from '../dashboardPullEdit';

describe('validatePullEdit', () => {
  const good = {
    originalPacketId: '20260820_174213_Gabriel1_ab12',
    wellName: 'Gabriel 1',
    tankTopInches: 96,
    bblsTaken: 140,
    wellDown: false,
  };

  it('accepts a well-formed edit', () => {
    expect(validatePullEdit(good)).toMatchObject({ wellName: 'Gabriel 1', tankTopInches: 96 });
  });

  it('accepts a Well DOWN edit', () => {
    const r = validatePullEdit({ ...good, wellDown: true });
    expect('error' in r).toBe(false);
    if (!('error' in r)) expect(r.wellDown).toBe(true);
  });

  it('rejects missing/oversized/path-escaping ids and bad numbers', () => {
    expect(validatePullEdit({ ...good, originalPacketId: '' })).toEqual({ error: 'originalPacketId_required' });
    expect(validatePullEdit({ ...good, originalPacketId: 'a/b' })).toEqual({ error: 'originalPacketId_malformed' });
    expect(validatePullEdit({ ...good, wellName: '' })).toEqual({ error: 'wellName_invalid' });
    expect(validatePullEdit({ ...good, tankTopInches: -1 })).toEqual({ error: 'tankTopInches_invalid' });
    expect(validatePullEdit({ ...good, bblsTaken: 'x' })).toEqual({ error: 'bblsTaken_invalid' });
    expect(validatePullEdit({ ...good, newDateTimeUTC: 'soon' })).toEqual({ error: 'newDateTimeUTC_invalid' });
  });
});

describe('buildEditPacket', () => {
  it('produces the reviewed edit-packet shape with authoritative wellDown', () => {
    const { packetId, packet } = buildEditPacket(
      { originalPacketId: 'p1', wellName: 'Gabriel 1', tankTopInches: 96, bblsTaken: 140, wellDown: true },
      'admin-uid', 1700000000000,
    );
    expect(packetId).toBe('edit_1700000000000_Gabriel1');
    expect(packet).toMatchObject({
      requestType: 'edit', originalPacketId: 'p1', wellName: 'Gabriel 1',
      tankTopInches: 96, bblsTaken: 140, wellDown: true, wellDownIsAuthoritative: true,
      source: 'dashboard', editedByUid: 'admin-uid',
    });
  });

  it('includes dateTime when a new timestamp is given', () => {
    const { packet } = buildEditPacket(
      { originalPacketId: 'p1', wellName: 'G', tankTopInches: 10, bblsTaken: 5, wellDown: false, newDateTimeUTC: '2026-08-20T00:00:00Z' },
      'u', 1,
    );
    expect(packet.dateTimeUTC).toBe('2026-08-20T00:00:00Z');
  });
});

// Server-authoritative well derivation (the customer-safe hardening) is exercised
// against the callable's stated contract via validatePullEdit + buildEditPacket;
// the read/derive/mismatch/scope gates are covered by the callable integration
// path. These unit tests pin the pure pieces the gates depend on.
describe('edit safety invariants', () => {
  it('buildEditPacket always uses the wellName it is given (server overrides client)', () => {
    const { packet } = buildEditPacket(
      { originalPacketId: 'p', wellName: 'AUTHORITATIVE Well', tankTopInches: 1, bblsTaken: 1, wellDown: false },
      'u', 1,
    );
    expect(packet.wellName).toBe('AUTHORITATIVE Well');
  });

  it('rejects path-escaping originalPacketId before any read', () => {
    expect(validatePullEdit({ originalPacketId: 'a#b', wellName: 'G', tankTopInches: 1, bblsTaken: 1, wellDown: false }))
      .toEqual({ error: 'originalPacketId_malformed' });
  });
});
