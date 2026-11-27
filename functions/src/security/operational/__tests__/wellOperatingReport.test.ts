const mockRow: any = {};
let mockJob: any;
const mockDelivery = jest.fn();
jest.mock('../../../levelReportDelivery', () => ({ deliverLevelReport: (...args: any[]) => mockDelivery(...args) }));
jest.mock('firebase-admin', () => ({
  firestore: () => ({ doc: () => ({ get: async () => ({ data: () => mockJob }) }) }),
  database: () => ({ ref: () => ({ once: async () => ({ val: () => mockRow }), update: async (p: any) => Object.assign(mockRow, p) }) }),
}));
import { checkedOperatingLevels, operatingReportContext, deliverOperatingReport } from '../wellOperatingReport';
beforeEach(() => {
  for (const k of Object.keys(mockRow)) delete mockRow[k];
  mockDelivery.mockReset().mockResolvedValue({ result: 'delivered' });
  mockJob = { companyId: 'co', driverHash: 'driver', wellConfigKey: 'Well' };
});
test('only finite bounded job readings become message context, never a pickup write', async () => {
  const levels = { tankTopInches: 120, tankAfterInches: 117, bblsTaken: 10 };
  expect(checkedOperatingLevels(levels)).toEqual(levels);
  for (const bad of [{ ...levels, tankTopInches: NaN }, { ...levels, tankAfterInches: 130 }, { ...levels, bblsTaken: -1 }, { ...levels, tankTopInches: '120' }])
    expect(() => checkedOperatingLevels(bad)).toThrow('context');
  expect(await operatingReportContext({ reportVersion: 1, jobId: 'job', levelReport: levels }, 'co', 'driver', 'Well', {})).toEqual({ jobId: 'job', levels });
  expect(await operatingReportContext({}, 'co', 'driver', 'Well', {})).toBeUndefined();
  expect(await operatingReportContext({jobId:'old',levelReport:levels}, 'co','driver','Well',{})).toBeUndefined();
});
test('job driver, company and corrected well are independently fenced; missing offline job waits', async () => {
  for (const patch of [{ companyId: 'other' }, { driverHash: 'other' }, { wellConfigKey: 'Corrected' }]) {
    mockJob = { companyId: 'co', driverHash: 'driver', wellConfigKey: 'Well', ...patch };
    await expect(operatingReportContext({ reportVersion: 1, jobId: 'job' }, 'co', 'driver', 'Well', {})).rejects.toThrow('does not match');
  }
  mockJob = undefined;
  await expect(operatingReportContext({ reportVersion: 1, jobId: 'job' }, 'co', 'driver', 'Well', {})).rejects.toThrow('waiting');
});
function applied(down = true) {
  Object.assign(mockRow, { companyId: 'co', actor: 'driver', status: 'applied', previousDown: !down, down,
    wellConfigKey: 'Well', at: '2026-11-27T12:00:00.000Z', reportContext: { jobId: 'job', levels: { tankTopInches: 120, tankAfterInches: 117, bblsTaken: 10 } } });
}
test('Down and Up changes carry their job levels and share one deterministic delivery ID on retry', async () => {
  applied(); mockDelivery.mockRejectedValueOnce(Error('lost response'));
  await expect(deliverOperatingReport('co', 'driver', 'op')).rejects.toThrow('lost response');
  expect(mockRow.reportDelivery).toBeUndefined();
  await deliverOperatingReport('co', 'driver', 'op'); await deliverOperatingReport('co', 'driver', 'op');
  expect(mockDelivery).toHaveBeenCalledTimes(2);
  expect(mockDelivery.mock.calls[0][1]).toBe(mockDelivery.mock.calls[1][1]);
  expect(mockDelivery.mock.calls[1][0]).toMatchObject({ wellDown: true, wellDownIsAuthoritative: true, tankTopInches: 120, tankAfterInches: 117, bblsTaken: 10 });
  delete mockRow.reportDelivery; applied(false); await deliverOperatingReport('co', 'driver', 'up');
  expect(mockDelivery.mock.calls[2][0].wellDown).toBe(false);
});
test('unchanged, pending, foreign and legacy operations never announce current status', async () => {
  applied(); mockRow.previousDown = mockRow.down; await deliverOperatingReport('co', 'driver', 'op');
  applied(); mockRow.status = 'pending'; await deliverOperatingReport('co', 'driver', 'op');
  applied(); await deliverOperatingReport('co', 'other', 'op');
  applied(); delete mockRow.reportContext; await deliverOperatingReport('co', 'driver', 'op');
  expect(mockDelivery).not.toHaveBeenCalled();
});
