// Phase-3: watchdog recovery semantics against the canonical coordinator —
// timing edges of the DERIVED takeover horizon (120 s explicit trigger
// timeout + 60 s recovery margin = 180 s), same-operation-id recovery, and
// the source call-graph proof that the watchdog drives the ONE canonical
// entry instead of writing anything itself.
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CANONICAL_COMMIT_TIMEOUT_SECONDS,
  DEFAULT_TIMEOUTS,
  commitHorizonMs,
  planLockAcquire,
  type LockRecord,
} from '../chronoCommitCoordinator';
import { estimatePacketAge, isStranded } from '../watchdogAge';

const T0 = 1_787_927_108_195; // Crossbow ingestedAt — a real production instant

describe('derived takeover horizon — no scattered magic 180000', () => {
  test('horizon = explicit 120 s trigger timeout + 60 s recovery margin', () => {
    expect(CANONICAL_COMMIT_TIMEOUT_SECONDS).toBe(120);
    expect(DEFAULT_TIMEOUTS.functionMaxMs).toBe(120_000);
    expect(DEFAULT_TIMEOUTS.recoveryMarginMs).toBe(60_000);
    expect(commitHorizonMs(DEFAULT_TIMEOUTS)).toBe(180_000);
  });

  const committing = (atMs: number): LockRecord => ({
    token: 'worker-A', fence: 4, phase: 'committing', at: atMs, operationId: 'op-A',
  });

  test.each([
    [694, 'contended'],           // Crossbow-style: worker just started
    [119_000, 'contended'],       // 119 s — inside the trigger lifetime
    [120_000, 'contended'],       // 120 s — trigger max, still within margin
    [179_999, 'contended'],       // 179.999 s — one ms inside the horizon
  ])('committing lock aged %i ms → NEVER taken over (%s)', (ageMs) => {
    const d = planLockAcquire(committing(T0), 'watchdog', T0 + (ageMs as number), DEFAULT_TIMEOUTS, 'op-A');
    expect(d).toEqual({ kind: 'contended', reason: 'committing_in_flight' });
  });

  test.each([[180_000], [180_001], [3_600_000]])(
    'committing lock aged %i ms → handed to receipt-consulting recovery',
    (ageMs) => {
      const d = planLockAcquire(committing(T0), 'watchdog', T0 + ageMs, DEFAULT_TIMEOUTS, 'op-A');
      expect(d.kind).toBe('recover');
    },
  );

  test('a still-PLANNING worker is protected only for its lease, then taken over with a HIGHER fence', () => {
    const planning: LockRecord = { token: 'worker-A', fence: 4, phase: 'planning', at: T0, operationId: 'op-A' };
    expect(planLockAcquire(planning, 'watchdog', T0 + 10_000, DEFAULT_TIMEOUTS, 'op-A').kind).toBe('contended');
    const after = planLockAcquire(planning, 'watchdog', T0 + DEFAULT_TIMEOUTS.planningLeaseMs + 1, DEFAULT_TIMEOUTS, 'op-A');
    expect(after).toMatchObject({ kind: 'acquire', next: { fence: 5 } }); // stale worker fenced out
  });
});

describe('watchdog stranding decision uses ONLY trusted age', () => {
  test('the Crossbow packet is not stranded 694 ms after ingest; it is after the threshold', () => {
    expect(isStranded(estimatePacketAge({ ingestedAt: T0 }, T0 + 694))).toBe(false);
    expect(isStranded(estimatePacketAge({ ingestedAt: T0 }, T0 + 2 * 60 * 1000 + 1))).toBe(true);
  });
});

describe('source call graph — the watchdog drives the canonical entry, never a legacy path', () => {
  const src = readFileSync(join(__dirname, '../index.ts'), 'utf8');
  const wd = src.slice(src.indexOf('export const watchdogStrandedPackets'), src.indexOf('export const healthCheck'));

  test('recovery is a call into processIncomingPullPacket with the SAME key (operation id)', () => {
    expect(wd).toContain('await processIncomingPullPacket(data, key)');
  });

  test('the watchdog writes NO canonical business state itself', () => {
    // Reads (completion checks against processed/receipt) are fine; WRITES are
    // not. The only mutating calls allowed in the watchdog section: the
    // proven-committed incoming cleanup (.remove()), the lossless quarantine
    // helper, and its own health node (.set on system_health/watchdog).
    const writes = wd.match(/\.(set|update)\(/g) ?? [];
    expect(writes).toEqual(['.set(']); // exactly one — the health node
    const setIdx = wd.indexOf('.set(');
    expect(wd.slice(Math.max(0, setIdx - 120), setIdx)).toContain('system_health/watchdog');
    for (const legacy of ['runCanonicalMutation(', 'assembleCanonicalPatch(', 'fencedSourceWrite(']) {
      expect(wd).not.toContain(legacy); // it drives the entry; it never composes/commits itself
    }
  });

  test('the trigger and the watchdog share ONE entry — the trigger body is a pure delegation', () => {
    const trigger = src.slice(
      src.indexOf('export const processIncomingPull ='),
      src.indexOf('export async function processIncomingPullPacket'),
    );
    expect(trigger).toContain('processIncomingPullPacket(snapshot.val() as PullPacket, context.params.packetId)');
    expect(trigger).not.toContain('runCanonicalMutation');   // no second body in the trigger
  });
});
