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
import {
  applyMaterializedWithRetry,
  preserveUiSession,
  wellChangeIsolated,
} from '../../../src/lib/wellRealtimeCore';
import { notifyMaterializedBestEffort } from '../incomingVersionPublish';
import { readFileSync } from 'fs';
import { join } from 'path';

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

  it('delete signals survivor identity', () => {
    const del = ev({
      kind: 'delete',
      opId: deleteOpId('del_req', 'gone', 'survivor'),
      packetId: 'gone',
      survivorPacketId: 'survivor',
      resultAtMs: 3000,
    });
    expect(decideApplyMaterialized(del, { lastPullPacketId: 'gone' })).toBe('wait');
    expect(decideApplyMaterialized(del, { lastPullPacketId: 'survivor' })).toBe('apply');
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

  it('one well changing does not corrupt another', () => {
    const before = { A: { currentLevel: "10'0\"" }, B: { currentLevel: "8'0\"" } };
    const after = { A: { currentLevel: "3'0\"" }, B: { currentLevel: "8'0\"" } };
    expect(wellChangeIsolated(before, after, 'A')).toBe(true);
  });

  it('data refresh preserves UI session / demo presence', () => {
    const session = {
      expandedRoutes: ['Demo Route'],
      wellSearch: 'Demo',
      viewMode: 'table',
      demoPresenceActive: true,
    };
    expect(preserveUiSession(session).demoPresenceActive).toBe(true);
    expect(preserveUiSession(session).expandedRoutes).toEqual(['Demo Route']);
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

  it('no window.location.reload in Dashboard WB-M flow', () => {
    const mobile = readFileSync(join(__dirname, '../../../src/app/mobile/page.tsx'), 'utf8');
    const wells = readFileSync(join(__dirname, '../../../src/lib/wells.ts'), 'utf8');
    expect(mobile).not.toMatch(/window\.location\.reload/);
    expect(wells).not.toMatch(/window\.location\.reload/);
    expect(mobile).not.toMatch(/\[initialSetupDone\]/);
  });

  it('pull signal is published after canonicalProcessingComplete', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8');
    const pull = index.slice(
      index.indexOf('export const processIncomingPull'),
      index.indexOf('export const processEditRequest'),
    );
    const complete = pull.indexOf('canonicalProcessingComplete: true');
    const signal = pull.indexOf('notifyMaterializedBestEffort');
    expect(complete).toBeGreaterThan(0);
    expect(signal).toBeGreaterThan(complete);
  });

  it('materialized path is company-scoped', () => {
    expect(materializedPath('wellbuilt-demo', 'Demo Well 1')).toBe(
      'packets/materialized/wellbuilt-demo/DemoWell1',
    );
  });
});
