import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerCoordinator} from './worker-coordinator.mjs';

test('backup grace blocks intake; verified existing message never sends again', async () => {
  const calls = [];
  let receipt;
  const coordinator = new WorkerCoordinator({data: {}}, {workerId: 'od-backup'}, async (endpoint, body) => {
    calls.push(endpoint);
    if (endpoint === 'claimWatchdogMessageV2') return receipt ? {receipt} : {granted: false, reason: 'main_grace_period'};
    assert.fail('Unexpected send ' + endpoint);
  });
  const body = {chatId: 'group', messageId: 'photo1', rowIndex: 0};
  await assert.rejects(coordinator.deliver(body), /worker_wait/);
  receipt = {identity: 'app:packet', packetId: 'packet', status: 'complete', alreadyRecorded: true};
  assert.deepEqual(await coordinator.deliver(body), receipt);
  assert.deepEqual(await coordinator.route('getWatchdogPullReceiptV2', {identity: 'app:packet'}), receipt);
  assert.deepEqual(calls, ['claimWatchdogMessageV2', 'claimWatchdogMessageV2']);
});

test('a lost intake response is reconciled by message ID without another send', async () => {
  let sends = 0;
  const coordinator = new WorkerCoordinator({data: {}}, {workerId: 'rog-main'}, async endpoint => {
    if (endpoint === 'claimWatchdogMessageV2') return sends ? {receipt: {identity: 'original', packetId: 'one', status: 'queued'}} : {granted: true};
    sends++;
    throw Error('response_lost');
  });
  const body = {chatId: 'group', messageId: 'photo1', rowIndex: 0};
  await assert.rejects(coordinator.deliver(body), /response_lost/);
  assert.equal((await coordinator.deliver(body)).packetId, 'one');
  assert.equal(sends, 1);
});

test('heartbeat is not treated as delivery proof; audit catches a missing processed packet', async () => {
  const reports = [];
  const queue = {data: {messages: {one: {id: 'photo1', channel: 'group', rows: [{id: 'row1'}]}},
    deliveries: {row1: {status: 'complete', identity: 'original', packetId: 'one'}}}, save() {}};
  const coordinator = new WorkerCoordinator(queue, {workerId: 'rog-main', sourceCommit: 'abc1234'}, async (endpoint, body) => {
    if (endpoint === 'reportWatchdogWorkerV2') { reports.push(body); return {}; }
    return {receipt: {identity: 'original', packetId: 'one', status: 'queued', alreadyRecorded: false}};
  });
  await coordinator.tick({state: 'Connected', channels: [{id: 'group'}]});
  assert.equal(reports.length, 1);
  assert.equal(queue.data.deliveries.row1.status, 'incomplete');
});
