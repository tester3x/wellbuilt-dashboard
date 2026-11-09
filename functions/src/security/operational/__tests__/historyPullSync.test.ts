import { reconcileHistoryPull } from '../syncHistoryPull';
import { historyPullEvidence, historyPullKey } from '../historyPullPlan';

const mockRows = new Map<string, any>();
const mockWrites: string[] = [];
jest.mock('firebase-admin', () => ({
  firestore: () => ({ doc: () => ({ get: async () => ({ data: () => ({ wellMonitoring: true }) }) }) }),
  database: () => ({
    ref: (path: string) => ({
      get: async () => ({ val: () => mockRows.get(path) }),
      orderByChild: (field: string) => ({
        equalTo: (value: unknown) => ({
          once: async () => ({
            val: () => Object.fromEntries([...mockRows.entries()]
              .filter(([p, row]) => p.startsWith(path + '/') && row[field] === value)
              .map(([p, row]) => [p.slice(path.length + 1), row])),
          }),
        }),
      }),
      transaction: async (update: (current: any) => any) => {
        const next = update(mockRows.get(path));
        if (next !== undefined) {
          mockRows.set(path, next);
          mockWrites.push(path);
        }
        return { snapshot: { val: () => mockRows.get(path) } };
      },
    }),
  }),
}));
jest.mock('../../canonicalDriverAuthority', () => ({
  loadCanonicalDriverAuthority: async () => ({ active: true, companyId: 'test-hauler' }),
  productionCanonicalDriverReaders: () => ({}),
}));

const packetId = '20261109_133329_Sample5_fixture';
const owner = { companyId: 'test-hauler', driverId: 'driver', invoiceDocId: 'invoice' };
const intent = { ...owner, revision: { toMillis: () => 10 } };
const pickup = '2026-11-09T19:33:29.895Z';
const ticket = { ...owner, packetId, ticketNumber: '42', top: "11'9", bottom: "4'9", bbls: '140',
  type: 'Production Water', wellName: 'SAMPLE 5-36-25', apiNo: '33-001-12345' };
const invoice = {
  packetId, commodityType: 'Production Water', closedAt: '2026-11-09T20:55:23.278Z',
  timeline: [{ type: 'depart_site', timestamp: '2026-11-09T19:34:00.000Z', recordedTimestamp: pickup }],
};
const livePath = 'wells/Sample 5/status/lastPull';
const pendingPath = 'packets/incoming/' + packetId;
const processedPath = 'packets/processed/' + packetId;
const existing = { ...owner, packetId, requestType: 'pull', wellName: 'Sample 5', dateTimeUTC: pickup,
  tankLevelFeet: 11.75, tankAfterInches: 57, bblsTaken: 140 };

beforeEach(() => {
  mockRows.clear();
  mockWrites.length = 0;
  mockRows.set('drivers/profiles/driver', { assignedWells: ['Sample 5'] });
  mockRows.set('well_config', { 'Sample 5': { companyId: 'test-hauler', ndicApiNo: '3300112345', bblPerFoot: 20 } });
});

test('missing original queues the same ID and original pickup time, then retries without a second pull', async () => {
  await expect(reconcileHistoryPull(intent, ticket, invoice)).rejects.toThrow('awaiting processor receipt');
  expect(mockRows.get(pendingPath)).toMatchObject({ packetId, dateTimeUTC: pickup, tankLevelFeet: 11.75, bblsTaken: 140 });
  await expect(reconcileHistoryPull(intent, ticket, invoice)).rejects.toThrow('still processing');
  mockRows.set(processedPath, { ...existing, source: 'wbt_history_correction', canonicalProcessingComplete: true });
  mockRows.delete(pendingPath);
  await expect(reconcileHistoryPull(intent, ticket, invoice)).resolves.toMatchObject({ status: 'complete', packetId });
  expect(mockWrites).toEqual([pendingPath]);
});

test('a newer current reading keeps the recovery historical, preserving the reported bottom and live level', async () => {
  const newer = { dateTimeUTC: '2026-11-09T20:33:00.000Z', bottomLevelInches: 100 };
  mockRows.set(livePath, newer);
  await expect(reconcileHistoryPull(intent, ticket, invoice)).resolves.toMatchObject({ status: 'historical', packetId });
  await expect(reconcileHistoryPull(intent, ticket, invoice)).resolves.toMatchObject({ status: 'historical', packetId });
  expect(mockRows.get(livePath)).toEqual(newer);
  expect(mockRows.get(processedPath)).toMatchObject({ historicalOnly: true, dateTimeUTC: pickup, tankAfterInches: 57 });
  expect(mockWrites).toEqual([processedPath]);
});

test('owned original is edited in place without resetting its timestamp', async () => {
  mockRows.set(processedPath, { ...existing, bblsTaken: 130 });
  await expect(reconcileHistoryPull(intent, ticket, invoice)).resolves.toMatchObject({ status: 'queued', packetId });
  await expect(reconcileHistoryPull(intent, ticket, invoice)).resolves.toMatchObject({ status: 'queued', packetId });
  expect(mockWrites).toHaveLength(1);
  expect(mockRows.get(mockWrites[0])).toMatchObject({ requestType: 'edit', originalPacketId: packetId, bblsTaken: 140 });
  expect(mockRows.get(mockWrites[0]).dateTimeUTC).toBeUndefined();
});

test('an equivalent differently keyed reading, conflicting owner and missing pickup time all hold', async () => {
  mockRows.set('packets/processed/other', { ...existing, invoiceDocId: 'other' });
  await expect(reconcileHistoryPull(intent, ticket, invoice)).resolves.toBe('review');
  mockRows.delete('packets/processed/other');
  mockRows.set(processedPath, { ...existing, driverId: 'other' });
  await expect(reconcileHistoryPull(intent, ticket, invoice)).resolves.toBe('review');
  mockRows.delete(processedPath);
  await expect(reconcileHistoryPull(intent, ticket, { ...invoice, timeline: [] })).resolves.toBe('review');
  expect(mockWrites).toHaveLength(0);
  expect(historyPullEvidence({ ...ticket, top: '' }, invoice)).toBeNull();
  expect(historyPullKey(ticket, { ...invoice, packetId: 'different_id' }, 'invoice')).toBeUndefined();
});
