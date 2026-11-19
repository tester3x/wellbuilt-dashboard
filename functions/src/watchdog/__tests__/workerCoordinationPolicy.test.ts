import {claimDecision, workerId, backupGraceMs} from '../workerCoordinationPolicy';

test('main claims immediately; backup waits even when it first sees a new message', () => {
  expect(claimDecision({now: 1000, role: 'main', workerId: 'rog-main'}).granted).toBe(true);
  expect(claimDecision({now: 1000, role: 'backup', workerId: 'od-backup'}).granted).toBe(false);
});
test('backup takes a stuck message after grace and an expired claim, even with main heartbeat alive', () => {
  const previous = {firstSeenAt: 1000, owner: 'rog-main', leaseUntil: 90000};
  expect(claimDecision({now: 1000 + backupGraceMs, role: 'backup', workerId: 'od-backup', previous}).granted).toBe(true);
});
test('another live lease is never stolen and a backup cannot renew early', () => {
  const previous = {firstSeenAt: 1000, owner: 'rog-main', leaseUntil: 200000};
  expect(claimDecision({now: 130000, role: 'backup', workerId: 'od-backup', previous}).reason).toBe('other_worker_active');
  expect(claimDecision({now: 1200, role: 'main', workerId: 'rog-main', previous}).granted).toBe(true);
});
test.each(['../other', '', 'space id', 'x'.repeat(65)])('reject invalid host identity %s', id => {
  expect(() => workerId(id)).toThrow();
});
