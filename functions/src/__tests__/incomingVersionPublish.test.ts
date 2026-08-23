import {
  nextIncomingVersion,
  shouldPublishIncomingVersion,
  publishIncomingVersionAfterOutgoing,
} from '../incomingVersionPublish';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');

describe('incoming_version publish contract', () => {
  it('outgoing write completes, then version increments', () => {
    const index = src('src/index.ts');
    const outgoing = index.indexOf('packets/outgoing/${responseId}');
    const pullPublish = index.indexOf('publishIncomingVersionAfterOutgoing', outgoing);
    expect(outgoing).toBeGreaterThan(0);
    expect(pullPublish).toBeGreaterThan(outgoing);
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

  it('edit/delete share the same transaction helper', () => {
    const index = src('src/index.ts');
    const matches = index.match(/publishIncomingVersionAfterOutgoing/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
    expect(index).not.toMatch(/Edit: Incremented incoming_version to \$\{currentVersion \+ 1\}/);
  });
});
