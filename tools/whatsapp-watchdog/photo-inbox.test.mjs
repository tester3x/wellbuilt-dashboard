import test from 'node:test';
import assert from 'node:assert/strict';
import {PhotoInbox} from './photo-inbox.mjs';

test('a repeated message uploads once and never invokes load delivery', async () => {
  const queue = {data: {messages: {a: {id: 'message', channel: 'group', postedAt: '2026-11-01T00:00:00Z', body: 'Dwyer', rows: [{photo: {}}]}}}, save() {}};
  const calls = [];
  const transport = {secret: 'test', request: async (endpoint, body) => {
    calls.push(endpoint);
    return {messageHash: (await import('node:crypto')).createHash('sha256').update('group:message').digest('hex'), uploadUrl: 'https://storage.invalid/test'};
  }};
  const originalFetch = globalThis.fetch;
  let uploads = 0;
  globalThis.fetch = async () => { uploads++; return {ok: true}; };
  try {
    const inbox = new PhotoInbox(queue, transport, async () => ({mimetype: 'image/jpeg', data: Buffer.from('synthetic photo').toString('base64')}));
    await inbox.tick([{id: 'group'}]);
    await inbox.tick([{id: 'group'}]);
    assert.equal(inbox.error, '');
    assert.equal(uploads, 1);
    assert.deepEqual(calls, ['syncWatchdogPhotoInboxV2', 'syncWatchdogPhotoInboxV2']);
  } finally { globalThis.fetch = originalFetch; }
});

test('missing media stays pending and does not mark a photo complete', async () => {
  const queue = {data: {messages: {a: {id: 'm', channel: 'g', rows: [{photo: {}}]}}}, save() {}};
  const inbox = new PhotoInbox(queue, {secret: 'test'}, async () => null);
  await inbox.tick([{id: 'g'}]);
  assert.match(inbox.error, /unavailable/);
  assert.deepEqual(queue.data.photoInbox, {});
});
