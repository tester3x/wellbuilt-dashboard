const mockThread = { companyId: 'company-a', type: 'shift', title: 'Driver', status: 'active',
  participants: ['driver:old-hash', 'user:dispatch'], participantNames: { 'driver:old-hash': 'bigpapapump' },
  lastMessage: { senderId: 'driver:old-hash', senderName: 'bigpapapapump', text: 'Hello', timestamp: '2026-10-31' } };
const mockMessage = { senderId: 'driver:old-hash', senderName: 'Old Login', text: 'Hello', timestamp: '2026-10-31' };
const mockWrite = jest.fn(() => { throw Error('Read path must not write'); });
jest.mock('firebase-functions/v2/https', () => ({
  onCall: (_: unknown, handler: unknown) => handler,
  HttpsError: class extends Error { constructor(public code: string, message: string) { super(message); } },
}));
jest.mock('../trustedStaffAuthority', () => ({
  requireTrustedCompanyCapability: jest.fn(async () => ({ uid: 'dispatch', companyId: 'company-a' })),
}));
jest.mock('firebase-admin', () => ({
  database: () => ({ ref: (path: string) => {
    const rows: Record<string, any> = {
      'users/dispatch': { companyId: 'company-a', driverId: 'office-driver', displayName: 'OfficeLogin' },
      users: { dispatch: { companyId: 'company-a', driverId: 'office-driver', displayName: 'OfficeLogin' } },
      'drivers/profiles': {
        canonical: { companyId: 'company-a', legalName: 'Michael Burger', displayName: 'bigpapapump' },
        'office-driver': { companyId: 'company-a', legalName: 'Office Employee' },
      },
      'drivers/approved': {},
      'drivers/identityBindings/byDriver': { canonical: { driverId: 'canonical', approvedKey: 'old-hash', opId: 'verified' } },
      'drivers/identityBindings/byApproved': { 'old-hash': { driverId: 'canonical', approvedKey: 'old-hash', opId: 'verified' } },
    };
    const query: any = { orderByChild: () => query, equalTo: () => query, once: async () => ({ val: () => rows[path] }) };
    return query;
  } }),
  firestore: () => ({ collection: () => {
    const query: any = {
      where: () => query,
      get: async () => ({ docs: [{ id: 'thread', data: () => mockThread }] }),
      doc: () => ({ get: async () => ({ exists: true, get: (field: string) => (mockThread as any)[field] }),
        update: mockWrite,
        collection: () => {
          const messages: any = { orderBy: () => messages, limit: () => messages,
            get: async () => ({ docs: [{ id: 'message', data: () => mockMessage }] }) };
          return messages;
        } }),
    };
    return query;
  } }),
}));
import { staffChat } from '../staffChat';
const call = (data: any) => (staffChat as any)({ auth: { uid: 'dispatch' }, data });

test('governed thread and message reads replace stale names without writes', async () => {
  const threads = await call({ action: 'threads', companyId: 'company-a', ownOnly: true });
  expect(threads.rows).toHaveLength(1);
  expect(threads.rows[0].title).toBe('Michael Burger');
  expect(threads.rows[0].lastMessage.senderName).toBe('Michael Burger');
  expect(threads.rows[0].participantNames['user:dispatch']).toBe('Office Employee');
  const messages = await call({ action: 'messages', companyId: 'company-a', threadId: 'thread' });
  expect(messages.rows[0].senderName).toBe('Michael Burger');
  expect(messages.rows[0].text).toBe('Hello');
  expect(mockWrite).not.toHaveBeenCalled();
});

test('driver picker uses real names; company override remains denied', async () => {
  const result = await call({ action: 'directory' });
  expect(result.drivers).toContainEqual({ hash: 'canonical', name: 'Michael Burger' });
  await expect(call({ action: 'threads', companyId: 'other-company' })).rejects.toThrow('Chat outside your company');
});
