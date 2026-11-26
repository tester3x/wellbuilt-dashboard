import { needsPickupWatermark, latestPhysicalPickup } from '../pickupWatermark';
import { evaluateIncomingPull } from '../packetGuards';
import * as fs from 'fs';
import * as path from 'path';

const incoming = { bblsTaken: 50, dateTimeUTC: '2026-11-26T19:09:28.869Z' };
const observation = { lastPullBbls: '0', lastPullDateTimeUTC: '2026-11-26T19:09:34.249Z' };
const pull = (dateTimeUTC: string, bblsTaken = 140) => ({ wellName: 'Gabriel 6', dateTimeUTC, bblsTaken });
function verdict(records: Record<string, any>) {
  const previous = latestPhysicalPickup(records, 'Gabriel 6');
  return evaluateIncomingPull({ incomingDateTimeUTC: incoming.dateTimeUTC,
    hasOutgoingResponse: !!previous, watermarkDateTimeUTC: previous?.dateTimeUTC,
    nowMs: Date.parse('2026-11-26T19:44:19Z') });
}
test('Gabriel 6: later zero-BBL report does not block its 50-BBL pickup', () => {
  expect(needsPickupWatermark(incoming, observation)).toBe(true);
  expect(verdict({ old: pull('2026-11-25T18:00:00Z'), report: pull(observation.lastPullDateTimeUTC, 0) }).action).toBe('process');
  expect(verdict({ report: pull(observation.lastPullDateTimeUTC, 0) }).action).toBe('process');
});
test('later or equal physical pickups still block stale/duplicate recovery', () => {
  expect(verdict({ later: pull('2026-11-26T19:10:00Z') }).reason).toBe('STALE_PULL_TIME');
  expect(verdict({ same: pull(incoming.dateTimeUTC, 50) }).reason).toBe('STALE_PULL_TIME');
  expect(needsPickupWatermark(incoming, { ...observation, lastPullBbls: 50 })).toBe(false);
});
test('zero reports, edits, deletes and other wells cannot become pickup watermark', () => {
  expect(latestPhysicalPickup({ report: pull(observation.lastPullDateTimeUTC, 0),
    edit_x: pull('2026-11-26T19:10:00Z'), other: { ...pull('2026-11-26T19:10:00Z'), wellName: 'Other' } }, 'Gabriel 6')).toBeNull();
  expect(needsPickupWatermark({ ...incoming, bblsTaken: 0 }, observation)).toBe(false);
});
test('future and malformed physical pickup watermarks remain protected', () => {
  expect(verdict({ future: pull('2026-11-27T19:10:00Z') }).reason).toBe('FUTURE_WELL_WATERMARK');
  expect(() => verdict({ bad: pull('bad') })).toThrow('unreadable');
});
test('handler resolves the physical pickup before guard and production math', () => {
  const source = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
  const handler = source.slice(source.indexOf('export const processIncomingPull'), source.indexOf('export const processEditRequest'));
  expect(handler.indexOf('needsPickupWatermark(data, prevResponse)')).toBeLessThan(handler.indexOf('const guardVerdict = evaluateIncomingPull'));
  expect(handler).toContain('prevTimestamp = previousPickup?.dateTimeUTC');
  expect(handler).toContain('prevTankAfterInches = previousPickup?.tankAfterInches');
});
