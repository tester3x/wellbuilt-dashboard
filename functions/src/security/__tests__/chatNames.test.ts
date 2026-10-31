import { chatNameDirectory, realChatName, presentChatThread, presentChatMessage, UNKNOWN_CHAT_NAME } from '../chatNames';

const aliases = new Map([['driver:old-hash', 'driver:canonical']]);
const profiles = {
  canonical: { companyId: 'company-a', legalName: 'Michael Burger', displayName: 'bigpapapump', dashboardUid: 'owner-uid' },
  inactive: { companyId: 'company-a', legalName: 'Former Employee', active: false },
  missing: { companyId: 'company-a', displayName: 'OnlyALogin', name: 'OnlyALogin' },
  foreign: { companyId: 'company-b', legalName: 'Other Company Employee' },
};
const users = {
  'owner-uid': { companyId: 'company-a', driverId: 'canonical', displayName: 'bigpapapump' },
  dispatch: { companyId: 'company-a', legalName: 'Office Employee', displayName: 'OfficeLogin' },
  foreign: { companyId: 'company-b', legalName: 'Private Employee', driverId: 'canonical' },
};
const names = chatNameDirectory('company-a', profiles, {}, users, aliases);

test('only real-name fields are used, never login, email or display aliases', () => {
  expect(realChatName(profiles.canonical)).toBe('Michael Burger');
  expect(realChatName(profiles.missing)).toBe('');
  expect(realChatName({ profile: { legalName: 'Nested Name' } })).toBe('Nested Name');
  expect(realChatName({ firstName: 'First', lastName: 'Last' })).toBe('First Last');
  expect(names.get('driver:missing')).toBe(UNKNOWN_CHAT_NAME);
  expect(names.get('user:owner-uid')).toBe('Michael Burger');
  expect(names.get('driver:inactive')).toBe('Former Employee');
  expect(names.has('driver:foreign')).toBe(false);
  expect(names.has('user:foreign')).toBe(false);
});

test('verified legacy links use the canonical name over saved aliases', () => {
  expect(names.get('driver:old-hash')).toBe('Michael Burger');
  const fallback = chatNameDirectory('company-a', { canonical: { companyId: 'company-a' } },
    { 'old-hash': { companyId: 'company-a', legalName: 'Legacy Real Name' } }, {}, aliases);
  expect(fallback.get('driver:canonical')).toBe('Legacy Real Name');
});

test.each(['shift', 'direct'])('existing %s thread title and participant names resolve without writes', type => {
  const row = { id: 'thread', type, title: 'Driver', participants: ['driver:old-hash', 'user:dispatch'],
    participantNames: { 'driver:old-hash': 'bigpapapump', 'user:dispatch': 'OfficeLogin' },
    lastRead: { 'user:dispatch': '2026-10-30' },
    lastMessage: { type: 'text', text: 'Original message', senderId: 'driver:old-hash', senderName: 'bigpapapump', timestamp: '2026-10-31' } };
  const out = presentChatThread(row, names, aliases);
  expect(out.title).toBe('Michael Burger');
  expect(out.participants).toEqual(['driver:canonical', 'user:dispatch']);
  expect(out.participantNames).toEqual({ 'driver:canonical': 'Michael Burger', 'user:dispatch': 'Office Employee' });
  expect(out.lastMessage.senderName).toBe('Michael Burger');
  expect(out.lastMessage.text).toBe('Original message');
  expect(out.lastRead).toBe(row.lastRead);
  expect(row.title).toBe('Driver');
});

test('project, crew and well titles are retained; unknown people never show saved aliases', () => {
  for (const type of ['project', 'service_group', 'well']) {
    expect(presentChatThread({ type, title: 'Site Work', participants: ['driver:canonical'] }, names, aliases).title).toBe('Site Work');
  }
  expect(presentChatMessage({ senderId: 'driver:unknown', senderName: 'OldNickname' }, names).senderName).toBe(UNKNOWN_CHAT_NAME);
  expect(presentChatMessage({ senderId: 'system', senderName: 'System', text: 'Original event' }, names).senderName).toBe('System');
});
