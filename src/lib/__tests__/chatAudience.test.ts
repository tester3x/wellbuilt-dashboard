import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatAudienceLabel, matchesChatFilter, isThreadUnread, type ChatThread } from '../../components/chat/ChatTypes';
test('dispatch and private filters never mix with historical Direct conversations', () => {
  const legacy = { type: 'direct' } as ChatThread;
  const team = { ...legacy, audience: 'dispatch_team' } as ChatThread;
  const privateChat = { ...legacy, audience: 'private_driver' } as ChatThread;
  assert.equal(matchesChatFilter(team, 'dispatch_team'), true);
  assert.equal(matchesChatFilter(privateChat, 'private_driver'), true);
  assert.equal(matchesChatFilter(privateChat, 'dispatch_team'), false);
  assert.equal(matchesChatFilter(team, 'private_driver'), false);
  assert.equal(matchesChatFilter(legacy, 'direct'), true);
  assert.equal(matchesChatFilter(team, 'direct'), false);
  assert.equal(matchesChatFilter(privateChat, 'direct'), false);
  assert.equal(chatAudienceLabel(team), 'Dispatch team');
  assert.equal(chatAudienceLabel(privateChat), 'Private · you and driver');
});

test('dispatch badges count incoming messages only, including shared conversations', () => {
  for (const audience of [undefined, 'dispatch_team', 'private_driver'] as const) {
    const thread = { audience, lastMessage: { senderId: 'user:me', timestamp: '2026-11-01T11:00:00Z' }, lastRead: {} } as ChatThread;
    assert.equal(isThreadUnread(thread, 'user:me'), false, 'outgoing is not unread even with no read receipt');
    assert.equal(isThreadUnread({ ...thread, lastRead: { 'user:me': '2026-11-01T10:00:00Z' } }, 'user:me'), false);
    for (const senderId of ['driver:real-driver', 'user:other-dispatcher']) {
      const incoming = { ...thread, lastMessage: { ...thread.lastMessage!, senderId } };
      assert.equal(isThreadUnread(incoming, 'user:me'), true);
      assert.equal(isThreadUnread({ ...incoming, lastRead: { 'user:me': '2026-11-01T12:00:00Z' } }, 'user:me'), false);
    }
    assert.equal(isThreadUnread(thread, ''), false);
  }
});
