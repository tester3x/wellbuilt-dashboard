import { deliverLevelReport, resolveLevelChatDriver, levelReportText, levelReportMessageId, isLevelChatRecipient, LevelChatDeps } from '../levelReportDelivery';
import { readFileSync } from 'fs';
import { join } from 'path';

const packet = { driverId: 'canonical', companyId: 'company-a', wellName: 'Fixture Well',
  tankLevelFeet: 11, tankTopInches: 132, tankAfterInches: 81, bblsTaken: 170,
  dateTimeUTC: '2026-10-30T21:59:00.000Z', timezone: 'America/Chicago' };
const recipient = { companyId: 'company-a', type: 'direct', participants: ['driver:old-hash', 'user:dispatch'] };
function fixture() {
  const records: Record<string, any> = {
    'drivers/profiles/canonical': { companyId: 'company-a', legalName: 'Real Employee', displayName: 'LoginAlias' },
    'drivers/identityBindings/byDriver/canonical': { driverId: 'canonical', approvedKey: 'old-hash', opId: 'proof' },
    'drivers/identityBindings/byApproved/old-hash': { driverId: 'canonical', approvedKey: 'old-hash', opId: 'proof' },
  };
  const settings = { sendLevelToDispatch: true, levelReportTemplate: '{driverName}\n{well}\n{top} -> {bottom}\n{bbls} {date} {time}' };
  const messages = new Map<string, any>();
  let attempts = 0, failSecond = false;
  const deps: LevelChatDeps = {
    read: async path => records[path] || null,
    company: async () => settings,
    threads: async () => [{ id: 'first', row: recipient }, { id: 'second', row: recipient },
      { id: 'foreign', row: { ...recipient, companyId: 'company-b' } },
      { id: 'unrelated', row: { ...recipient, participants: ['driver:other', 'user:dispatch'] } }],
    writeOnce: async (thread, messageId, _company, _keys, message) => {
      attempts++;
      if (failSecond && thread === 'second') throw Error('Transient network failure');
      const key = `${thread}/${messageId}`;
      if (!messages.has(key)) messages.set(key, message);
    },
  };
  return { deps, records, settings, messages, attempts: () => attempts, fail: (value: boolean) => { failSecond = value; } };
}

test('canonical driver with no approved record reaches verified legacy dispatch chats', async () => {
  const f = fixture();
  expect(await deliverLevelReport(packet, 'packet-1', f.deps)).toEqual({ result: 'delivered', recipients: 2 });
  expect(f.messages.size).toBe(2);
  const message = [...f.messages.values()][0];
  expect(message.senderId).toBe('driver:canonical');
  expect(message.senderName).toBe('Real Employee');
  expect(message.text).toContain('11\'0" -> 6\'9"'); // 2 equalized tanks, no single-tank recalculation.
  expect(message.text).toContain('10/30/2026 4:59 PM');
  expect(message.text).not.toContain('LoginAlias');
});

test('legacy packet identity resolves only reciprocal links, scoped to the profile company', async () => {
  const f = fixture();
  expect((await resolveLevelChatDriver({ ...packet, driverId: 'old-hash' }, f.deps))?.driverId).toBe('canonical');
  f.records['drivers/identityBindings/byApproved/old-hash'].opId = 'wrong';
  expect(await resolveLevelChatDriver({ ...packet, driverId: 'old-hash' }, f.deps)).toBeNull();
  expect(await resolveLevelChatDriver({ ...packet, companyId: 'company-b' }, f.deps)).toBeNull();
  expect(await resolveLevelChatDriver({ ...packet, driverId: '', driverName: 'Real Employee' }, f.deps)).toBeNull();
});

test('disabled company, missing identity, or unmeasured pull never produces a message', async () => {
  const f = fixture();
  f.settings.sendLevelToDispatch = false;
  expect(await deliverLevelReport(packet, 'disabled', f.deps)).toEqual({ result: 'disabled' });
  f.settings.sendLevelToDispatch = true;
  expect(await deliverLevelReport({ ...packet, driverId: undefined }, 'missing', f.deps)).toEqual({ result: 'unresolved_driver' });
  expect(await deliverLevelReport({ ...packet, noLevel: true }, 'no-level', f.deps)).toEqual({ result: 'no_measured_level' });
  expect(f.attempts()).toBe(0);
});

test('recipient creation race and partial fan-out failures remain retryable', async () => {
  const f = fixture();
  await expect(deliverLevelReport(packet, 'race', { ...f.deps, threads: async () => [] })).rejects.toThrow('recipient_not_ready');
  f.fail(true);
  await expect(deliverLevelReport(packet, 'retry', f.deps)).rejects.toThrow('Transient');
  expect(f.messages.size).toBe(1);
  f.fail(false);
  await deliverLevelReport(packet, 'retry', f.deps);
  await deliverLevelReport(packet, 'retry', f.deps);
  expect(f.messages.size).toBe(2);
  expect(levelReportMessageId('idem_retry', 'company-a', 'canonical')).toBe(levelReportMessageId('retry', 'company-a', 'canonical'));
  expect(levelReportMessageId('another', 'company-a', 'canonical')).not.toBe(levelReportMessageId('retry', 'company-a', 'canonical'));
});

test('report uses processed bottom exactly and refuses to invent missing or invalid measurements', () => {
  expect(levelReportText({ ...packet, tankAfterInches: 37 }, {}, 'Real Name')).toContain('Bottom: 3\'1"');
  expect(levelReportText({ ...packet, tankAfterInches: undefined }, {}, 'Real Name')).toBeNull();
  expect(levelReportText({ ...packet, tankAfterInches: Infinity }, {}, 'Real Name')).toBeNull();
  expect(isLevelChatRecipient({ ...recipient, broadcast: true }, 'company-a', ['old-hash'])).toBe(false);
});

test('processed-event worker remains exported and retryable independently of the incoming fast path', () => {
  const worker = readFileSync(join(__dirname, '../levelReportDelivery.ts'), 'utf8');
  const index = readFileSync(join(__dirname, '../index.ts'), 'utf8');
  expect(worker).toContain('failurePolicy: true');
  expect(worker).toContain(".database.ref('packets/processed/{packetId}').onCreate");
  expect(index).toContain("export { deliverProcessedLevelReport } from './levelReportDelivery'");
  const fastPath = index.slice(index.indexOf('async function sendLevelToChat('), index.indexOf('// ── onShiftCreate:'));
  expect(fastPath).toContain('await deliverLevelReport(');
  expect(fastPath).not.toContain(".collection('messages').doc()");
});
