import {
  buildMaterializedEvent,
  coalesceByWell,
  decideApplyMaterialized,
  decideMaterializedCas,
  deleteOpId,
  editOpId,
  isUnsafeVersionNumber,
  materializedCasUpdater,
  materializedPath,
  nextIncomingVersion,
  pullOpId,
  unsafeStringIncrement,
} from '../materializedSignal';
import { notifyMaterializedBestEffort, shouldPublishMaterialized } from '../incomingVersionPublish';
import { readFileSync } from 'fs';
import { join } from 'path';

function applyMaterializedWithRetry(
  event: ReturnType<typeof buildMaterializedEvent>,
  outgoing: { lastPullPacketId?: string | null } | null,
  attempt: number,
  maxAttempts = 4,
): { decision: 'apply' | 'wait' | 'ignore'; nextAttempt: number } {
  const decision = decideApplyMaterialized(event, outgoing);
  if (decision === 'wait' && attempt + 1 < maxAttempts) {
    return { decision, nextAttempt: attempt + 1 };
  }
  return { decision: decision === 'wait' ? 'ignore' : decision, nextAttempt: attempt };
}

function ev(partial: {
  kind: 'pull' | 'edit' | 'delete';
  opId: string;
  packetId?: string | null;
  survivorPacketId?: string | null;
  resultAtMs: number;
  atMs?: number;
}) {
  return buildMaterializedEvent({
    kind: partial.kind,
    wellName: 'W',
    companyId: 'c',
    opId: partial.opId,
    packetId: partial.packetId ?? null,
    survivorPacketId: partial.survivorPacketId,
    atMs: partial.atMs ?? partial.resultAtMs,
    resultAtMs: partial.resultAtMs,
  });
}

describe('unsafe incoming_version +1', () => {
  it('values beyond MAX_SAFE_INTEGER cannot serve as a +1 trigger', () => {
    const poison = 4.300535314662255e20;
    expect(poison > Number.MAX_SAFE_INTEGER).toBe(true);
    expect(poison + 1).toBe(poison);
    expect(isUnsafeVersionNumber(poison)).toBe(true);
    expect(nextIncomingVersion(poison)).toBe(poison);
  });

  it('historic CF `val + 1` concatenates strings', () => {
    expect(unsafeStringIncrement('5')).toBe('51');
    expect(unsafeStringIncrement('51')).toBe('511');
  });

  it('safe nextIncomingVersion does not concatenate or reset poison', () => {
    expect(nextIncomingVersion('5')).toBe(6);
    expect(nextIncomingVersion(12)).toBe(13);
    expect(nextIncomingVersion(4.300535314662255e20)).toBe(4.300535314662255e20);
  });
});

describe('stable op ids + CAS', () => {
  it('pull uses packet id; edit of same packet is a distinct op', () => {
    expect(pullOpId('pkt1')).toBe('pull:pkt1');
    expect(editOpId('edit_req', 'pkt1')).toBe('edit:edit_req:pkt1');
    expect(editOpId('edit_req', 'pkt1')).not.toBe(pullOpId('pkt1'));
  });

  it('same-operation replay is idempotent', () => {
    const a = ev({ kind: 'pull', opId: pullOpId('p1'), packetId: 'p1', resultAtMs: 1000 });
    const replay = ev({ kind: 'pull', opId: pullOpId('p1'), packetId: 'p1', resultAtMs: 9999 });
    expect(decideMaterializedCas(a, replay)).toBe('idempotent');
    const updater = materializedCasUpdater(replay);
    expect(updater(a)).toBeUndefined();
  });

  it('older retry cannot regress a newer signal', () => {
    const newer = ev({ kind: 'pull', opId: pullOpId('p2'), packetId: 'p2', resultAtMs: 2000 });
    const older = ev({ kind: 'pull', opId: pullOpId('p1'), packetId: 'p1', resultAtMs: 1000 });
    expect(decideMaterializedCas(newer, older)).toBe('reject_stale');
    expect(materializedCasUpdater(older)(newer)).toBeUndefined();
  });

  it('forced interleaving: late retry of A does not overwrite B', async () => {
    let stored: unknown = null;
    const root = {
      child: () => ({
        transaction: async (fn: (c: unknown) => unknown) => {
          const next = fn(stored);
          if (next === undefined) return { committed: false, snapshot: { val: () => stored } };
          stored = next;
          return { committed: true, snapshot: { val: () => stored } };
        },
      }),
    };
    await notifyMaterializedBestEffort(root, {
      companyId: 'c', wellName: 'W', kind: 'pull', opId: pullOpId('B'),
      packetId: 'B', resultAtMs: 2000, nowMs: 2000,
    });
    const late = await notifyMaterializedBestEffort(root, {
      companyId: 'c', wellName: 'W', kind: 'pull', opId: pullOpId('A'),
      packetId: 'A', resultAtMs: 1000, nowMs: 3000,
    });
    expect(late).toBeNull();
    expect((stored as { packetId: string }).packetId).toBe('B');
  });

  it('skips publication when projection was not reconciled', async () => {
    let stored: unknown = 'untouched';
    const root = {
      child: () => ({
        transaction: async (fn: (c: unknown) => unknown) => {
          stored = fn(stored);
          return { committed: true, snapshot: { val: () => stored } };
        },
      }),
    };
    const skipped = await notifyMaterializedBestEffort(root, {
      companyId: 'c', wellName: 'W', kind: 'pull', opId: pullOpId('A'),
      packetId: 'A', resultAtMs: 1000, nowMs: 1000, projectionReconciled: false,
    });
    expect(skipped).toBeNull();
    expect(stored).toBe('untouched');
  });

  it('current delete signals the surviving packet; historical delete signals none', () => {
    const current = ev({
      kind: 'delete',
      opId: deleteOpId('del_req', 'gone', 'survivor'),
      packetId: 'gone',
      survivorPacketId: 'survivor',
      resultAtMs: 3000,
    });
    expect(decideApplyMaterialized(current, { lastPullPacketId: 'gone' })).toBe('wait');
    expect(decideApplyMaterialized(current, { lastPullPacketId: 'survivor' })).toBe('apply');

    const historical = ev({
      kind: 'delete',
      opId: deleteOpId('del_hist', 'old', 'current'),
      packetId: 'old',
      survivorPacketId: 'current',
      resultAtMs: 3000,
    });
    expect(decideApplyMaterialized(historical, { lastPullPacketId: 'current' })).toBe('apply');

    const lastPullGone = ev({
      kind: 'delete',
      opId: deleteOpId('del_last', 'gone', null),
      packetId: 'gone',
      survivorPacketId: null,
      resultAtMs: 3000,
    });
    expect(decideApplyMaterialized(lastPullGone, { lastPullPacketId: 'gone' })).toBe('wait');
    expect(decideApplyMaterialized(lastPullGone, { lastPullPacketId: null })).toBe('apply');
  });

  it('pull applies when outgoing matches; early signal waits', () => {
    const pull = ev({ kind: 'pull', opId: pullOpId('p1'), packetId: 'p1', resultAtMs: 1 });
    expect(decideApplyMaterialized(pull, null)).toBe('wait');
    expect(decideApplyMaterialized(pull, { lastPullPacketId: 'old' })).toBe('ignore');
    expect(decideApplyMaterialized(pull, { lastPullPacketId: 'p1' })).toBe('apply');
  });

  it('rapid signals coalesce to the latest resultAtMs per well', () => {
    const a = ev({ kind: 'pull', opId: pullOpId('p1'), packetId: 'p1', resultAtMs: 1 });
    const b = ev({ kind: 'edit', opId: editOpId('e1', 'p1'), packetId: 'p1', resultAtMs: 2 });
    const pending = coalesceByWell(coalesceByWell({}, a), b);
    expect(Object.keys(pending)).toHaveLength(1);
    expect(pending['c:W'].kind).toBe('edit');
  });

  it('one well changing does not coalesce into another well key', () => {
    const a = ev({ kind: 'pull', opId: pullOpId('pA'), packetId: 'pA', resultAtMs: 1 });
    const b = buildMaterializedEvent({
      kind: 'pull',
      wellName: 'Other',
      companyId: 'c',
      opId: pullOpId('pB'),
      packetId: 'pB',
      atMs: 2,
      resultAtMs: 2,
    });
    const pending = coalesceByWell(coalesceByWell({}, a), b);
    expect(Object.keys(pending).sort()).toEqual(['c:Other', 'c:W']);
    expect(pending['c:W'].packetId).toBe('pA');
    expect(pending['c:Other'].packetId).toBe('pB');
  });

  it('does not publish until projection is reconciled', () => {
    expect(shouldPublishMaterialized({ projectionReconciled: false })).toBe(false);
    expect(shouldPublishMaterialized({ projectionReconciled: true })).toBe(true);
  });

  it('bounded retry then ignore if projections never converge', () => {
    const pull = ev({ kind: 'pull', opId: pullOpId('p1'), packetId: 'p1', resultAtMs: 1 });
    let attempt = 0;
    let decision = 'wait';
    for (let i = 0; i < 6; i++) {
      const r = applyMaterializedWithRetry(pull, null, attempt, 4);
      decision = r.decision;
      attempt = r.nextAttempt;
    }
    expect(decision).toBe('ignore');
  });

  it('pull signal is published after canonicalProcessingComplete and only if high-water held', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8');
    const pull = index.slice(
      index.indexOf('export const processIncomingPull'),
      index.indexOf('export const processEditRequest'),
    );
    const complete = pull.indexOf('canonicalProcessingComplete: true');
    const signal = pull.indexOf('notifyMaterializedBestEffort');
    expect(complete).toBeGreaterThan(0);
    expect(signal).toBeGreaterThan(complete);
    expect(pull).toMatch(/if \(holdsHighWater\) \{[\s\S]*notifyMaterializedBestEffort/);
    expect(pull).toMatch(/resultAtMs: Number\.isFinite\(pullTimeMs\) \? pullTimeMs : Date\.now\(\)/);
  });

  it('edit of a non-current packet does not publish a well signal', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8');
    const edit = index.slice(
      index.indexOf('export const processEditRequest'),
      index.indexOf('export const processDeleteRequest'),
    );
    expect(edit).toMatch(/if \(isLatestPull\) \{[\s\S]*notifyMaterializedBestEffort/);
  });

  it('materialized path is company-scoped', () => {
    expect(materializedPath('wellbuilt-demo', 'Demo Well 1')).toBe(
      'packets/materialized/wellbuilt-demo/DemoWell1',
    );
  });
});
