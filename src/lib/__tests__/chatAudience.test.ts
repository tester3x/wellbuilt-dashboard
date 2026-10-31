import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatAudienceLabel, matchesChatFilter, type ChatThread } from '../../components/chat/ChatTypes';
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
