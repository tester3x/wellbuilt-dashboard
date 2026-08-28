import {
  nextIncomingVersion,
  shouldPublishIncomingVersion,
  publishIncomingVersionAfterOutgoing,
  notifyIncomingVersionBestEffort,
} from '../incomingVersionPublish';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');

describe('incoming_version publish contract', () => {
  it('the ONE canonical commit precedes the publication signal (no sequential writes)', () => {
    const index = src('src/index.ts');
    const pull = index.slice(index.indexOf('export const processIncomingPull'), index.indexOf('export const processEditRequest'));
    // Canonical state (outgoing/performance/wells-status/production/afr) is now
    // composed into ONE atomic patch via assembleCanonicalPatch and submitted by
    // runCanonicalMutation — the publish signal fires AFTER that commit.
    const commit = pull.indexOf('runCanonicalMutation(makeCoordinatorIO(db, wellName)');
    const assemble = pull.indexOf('assembleCanonicalPatch({');
    const notify = pull.indexOf('notifyIncomingVersionBestEffort');
    expect(commit).toBeGreaterThan(0);
    expect(assemble).toBeGreaterThan(commit);
    expect(notify).toBeGreaterThan(assemble);
    // The legacy sequential canonical writes are GONE from the pull handler.
    expect(pull).not.toMatch(/packets\/outgoing\/\$\{responseId\}`\)\.set\(/);
    expect(pull).not.toMatch(/wells\/\$\{wellName\}\/status`\)\.set\(wellStatus\)/);
    expect(pull).not.toMatch(/performance\/\$\{wellKey\}\/rows\/\$\{perf\.perfTimestamp\}`\)\.set\(/);
    expect(pull).not.toMatch(/well_config\/\$\{wellName\}`\)\.update\(/);
  });

  it('{committed:false} returns no published version', async () => {
    const ref = {
      transaction: async () => ({ committed: false, snapshot: { val: () => 99 } }),
    };
    const published = await publishIncomingVersionAfterOutgoing(ref, {
      outgoingCommitted: true,
      pullAccepted: true,
    });
    expect(published).toBeNull();
  });

  it('outgoing write fails / pull not accepted → version does not increment', async () => {
    expect(shouldPublishIncomingVersion({ outgoingCommitted: false, pullAccepted: true })).toBe(false);
    expect(shouldPublishIncomingVersion({ outgoingCommitted: true, pullAccepted: false })).toBe(false);
    let calls = 0;
    const ref = {
      transaction: async (fn: (c: unknown) => number) => {
        calls += 1;
        return { committed: true, snapshot: { val: () => fn(0) } };
      },
    };
    const skipped = await publishIncomingVersionAfterOutgoing(ref, {
      outgoingCommitted: false,
      pullAccepted: true,
    });
    expect(skipped).toBeNull();
    expect(calls).toBe(0);
  });

  it('skipped flags return null without logging or incrementing', async () => {
    let calls = 0;
    const logs: unknown[] = [];
    const ref = {
      transaction: async () => {
        calls += 1;
        return { committed: true, snapshot: { val: () => 2 } };
      },
    };
    const skipped = await notifyIncomingVersionBestEffort(
      ref,
      { outgoingCommitted: false, pullAccepted: true },
      (err) => logs.push(err),
    );
    const skippedPull = await notifyIncomingVersionBestEffort(
      ref,
      { outgoingCommitted: true, pullAccepted: false },
      (err) => logs.push(err),
    );
    expect(skipped).toBeNull();
    expect(skippedPull).toBeNull();
    expect(calls).toBe(0);
    expect(logs).toEqual([]);
  });

  it('a noncommitted transaction logs one redacted failure and returns null', async () => {
    const logs: unknown[] = [];
    const published = await notifyIncomingVersionBestEffort(
      {
        transaction: async () => ({ committed: false, snapshot: { val: () => 99 } }),
      },
      { outgoingCommitted: true, pullAccepted: true },
      (err) => logs.push(err),
    );
    expect(published).toBeNull();
    expect(logs).toEqual([{ reason: 'not_committed' }]);
  });

  it('a thrown counter transaction after outgoing does not propagate', async () => {
    const ref = {
      transaction: async () => {
        throw new Error('transaction_failed');
      },
    };
    const logs: unknown[] = [];
    const published = await notifyIncomingVersionBestEffort(
      ref,
      { outgoingCommitted: true, pullAccepted: true },
      (err) => logs.push(err),
    );
    expect(published).toBeNull();
    expect(logs).toEqual([{ reason: 'threw' }]);
  });

  it('two concurrent pulls cannot lose a version increment', async () => {
    let value: unknown = 10;
    let lock = Promise.resolve();
    const ref = {
      transaction: async (fn: (c: unknown) => number) => {
        const run = lock.then(() => {
          value = fn(value);
          const committed = value;
          return { committed: true, snapshot: { val: () => committed } };
        });
        lock = run.then(() => undefined);
        return run;
      },
    };
    const [a, b] = await Promise.all([
      publishIncomingVersionAfterOutgoing(ref, { outgoingCommitted: true, pullAccepted: true }),
      publishIncomingVersionAfterOutgoing(ref, { outgoingCommitted: true, pullAccepted: true }),
    ]);
    expect(new Set([a, b])).toEqual(new Set([11, 12]));
    expect(value).toBe(12);
    expect(nextIncomingVersion(12)).toBe(13);
  });

  it('a thrown counter after outgoing does not rerun or duplicate the business mutation', async () => {
    let mutations = 0;
    const ref = {
      transaction: async () => {
        throw new Error('transaction_failed');
      },
    };
    const processAcceptedPull = async () => {
      mutations += 1;
      await notifyIncomingVersionBestEffort(ref, {
        outgoingCommitted: true,
        pullAccepted: true,
      }, () => undefined);
    };
    let retried = false;
    try {
      await processAcceptedPull();
    } catch {
      retried = true;
      await processAcceptedPull();
    }
    expect(retried).toBe(false);
    expect(mutations).toBe(1);
  });

  it('edit/delete notification failure does not prevent remaining audit/archive completion', async () => {
    const ref = {
      transaction: async () => {
        throw new Error('transaction_failed');
      },
    };
    const edit: string[] = [];
    edit.push('edit-rtdb');
    edit.push('edit-request-removed');
    await notifyIncomingVersionBestEffort(ref, { outgoingCommitted: true, pullAccepted: true }, () => undefined);
    edit.push('edit-complete');

    const del: string[] = [];
    del.push('outgoing-rebuild');
    del.push('archive');
    del.push('incoming-removed');
    await notifyIncomingVersionBestEffort(ref, { outgoingCommitted: true, pullAccepted: true }, () => undefined);
    del.push('delete-complete');

    expect(edit).toEqual(['edit-rtdb', 'edit-request-removed', 'edit-complete']);
    expect(del).toEqual(['outgoing-rebuild', 'archive', 'incoming-removed', 'delete-complete']);
  });

  it('edit/delete notification is best-effort and delete archives first', () => {
    const index = src('src/index.ts');
    expect(index.match(/await notifyIncomingVersionBestEffort/g)?.length).toBe(3);
    expect(index).not.toMatch(/publishIncomingVersionAfterOutgoing\(/);
    expect(index).not.toMatch(/packets\/incoming_version'\)\.once\('value'\)/);
    expect(index).not.toMatch(/packets\/incoming_version'\)\.set\(/);
    const del = index.slice(index.indexOf('export const processDeleteRequest'));
    const archive = del.indexOf('packets/processed/delete_${targetPacketId}');
    const notify = del.indexOf('notifyIncomingVersionBestEffort');
    expect(archive).toBeGreaterThan(0);
    expect(notify).toBeGreaterThan(archive);
    // The edit request is now consumed AS PART OF the canonical atomic patch
    // (packets/incoming/<id> = null inside buildPatch), never a separate remove.
    const edit = index.slice(index.indexOf('export const processEditRequest'), index.indexOf('export const processDeleteRequest'));
    expect(edit).not.toMatch(/await snapshot\.ref\.remove\(\)/);          // no lone request-remove write
    expect(edit).toMatch(/patch\[`packets\/incoming\/\$\{context\.params\.packetId\}`\] = null/); // consumed in the patch
    expect(edit.indexOf('runCanonicalMutation')).toBeGreaterThan(0);
    expect(edit.indexOf('notifyIncomingVersionBestEffort')).toBeGreaterThan(edit.indexOf('runCanonicalMutation'));
  });
});
