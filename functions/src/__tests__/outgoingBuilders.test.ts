// Golden-fixture parity pin for the outgoing/current response builder extracted
// verbatim from processIncomingPull. Combined with the full suite staying green
// (behavior-preserving), this proves parity (formatting, keys, null-vs-omitted,
// injected server timestamp).
import { buildOutgoingResponse } from '../outgoingBuilders';

test('buildOutgoingResponse — golden pin', () => {
  const r = buildOutgoingResponse({
    wellName: 'Gabriel 5', currentLevelInches: 48, afr: 0.1443, bbls24hrs: '139', nextIsDown: false,
    estTimeToPull: '5:00', estDateTimePull: '2026-08-27T05:39:00.000Z', dateTime: '8/26/2026 7:39 PM',
    dateTimeUTC: '2026-08-27T00:39:00.000Z', bblsTaken: 60, driverId: 'd1', driverName: 'Mikezfold',
    tankTopInches: 84, tankAfterInches: 48, packetId: 'pk1', config: { companyId: 'liquid-gold' },
    timestampIso: '2026-08-27T13:00:00.000Z', windowBblsDay: 272, overnightBblsDay: 0,
  });
  expect(r).toEqual({
    wellName: 'Gabriel 5', currentLevel: '4\'0"', flowRate: '3:27:47', bbls24hrs: '139',
    timeTillPull: '5:00', nextPullTime: '08/27/2026 12:39 AM', nextPullTimeUTC: '2026-08-27T05:39:00.000Z',
    lastPullDateTime: '8/26/2026 7:39 PM', lastPullDateTimeUTC: '2026-08-27T00:39:00.000Z', lastPullBbls: '60',
    lastPullTopLevel: '7\'0"', lastPullBottomLevel: '4\'0"', lastPullDriverId: 'd1', lastPullDriverName: 'Mikezfold',
    lastPullPacketId: 'pk1', wellDown: false, companyId: 'liquid-gold', status: 'success',
    timestamp: '2026-08-27T13:00:00.000Z', timestampUTC: '2026-08-27T13:00:00.000Z',
    windowBblsDay: '272', overnightBblsDay: null, // 0 → null (not omitted)
  });
});

test('down well → timeTillPull Down, wellDown true; unknown afr → Unknown flowRate', () => {
  const r = buildOutgoingResponse({
    wellName: 'W', currentLevelInches: 40, afr: 0, bbls24hrs: '0', nextIsDown: true,
    estTimeToPull: '', estDateTimePull: '', dateTimeUTC: '2026-08-27T00:00:00.000Z', bblsTaken: 0,
    tankTopInches: 40, tankAfterInches: 40, packetId: 'p', config: {}, timestampIso: '2026-08-27T00:00:00.000Z',
    windowBblsDay: 0, overnightBblsDay: 0,
  });
  expect(r.timeTillPull).toBe('Down');
  expect(r.wellDown).toBe(true);
  expect(r.flowRate).toBe('Unknown');
  expect(r.nextPullTime).toBe('Unknown');
  expect(r.companyId).toBe('liquid-gold'); // default
});
