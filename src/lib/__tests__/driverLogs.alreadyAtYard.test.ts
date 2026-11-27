import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDriverTimeline, calculateDriveAndOnSiteTime } from '../driverLogs';

describe('already-at-yard close attribution', () => {
  it('preserves mode through the timeline and excludes unmeasured shop time', () => {
    const timeline = buildDriverTimeline({ events: [
      { type: 'login', timestamp: '2026-11-26T12:00:00Z', lat: 48, lng: -103 },
      { type: 'close', timestamp: '2026-11-27T01:00:00Z', lat: 48, lng: -103 },
      { type: 'logout', timestamp: '2026-11-27T04:00:00Z', lat: 48.1, lng: -103, endMode: 'already_at_yard' },
    ] } as any, []);
    assert.equal(timeline[2].endMode, 'already_at_yard');
    assert.equal(calculateDriveAndOnSiteTime(timeline).driveMinutes, 0);
    assert.equal(calculateDriveAndOnSiteTime(timeline).driveMiles, 0);
    assert.equal(calculateDriveAndOnSiteTime(timeline.map(({endMode, ...e}) => e)).driveMinutes, 180);
  });
});
