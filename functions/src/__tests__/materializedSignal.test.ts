import {
  buildMaterializedEvent,
  coalesceByWell,
  decideApplyMaterialized,
  isUnsafeVersionNumber,
  materializedPath,
  nextIncomingVersion,
  unsafeStringIncrement,
} from '../materializedSignal';
import {
  applyMaterializedWithRetry,
  preserveUiSession,
  wellChangeIsolated,
} from '../../../src/lib/wellRealtimeCore';

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
    let v: unknown = '2';
    for (let i = 0; i < 20; i++) v = unsafeStringIncrement(v);
    expect(String(v).length).toBeGreaterThan(15);
  });

  it('safe nextIncomingVersion does not concatenate', () => {
    expect(nextIncomingVersion('5')).toBe(6);
    expect(nextIncomingVersion(12)).toBe(13);
  });
});

describe('materialized event', () => {
  it('event id changes for pull, edit, and delete even when packet id is reused', () => {
    const pull = buildMaterializedEvent({
      kind: 'pull', wellName: 'Demo Well 1', companyId: 'wellbuilt-demo',
      packetId: 'pkt1', atMs: 1000,
    });
    const edit = buildMaterializedEvent({
      kind: 'edit', wellName: 'Demo Well 1', companyId: 'wellbuilt-demo',
      packetId: 'pkt1', atMs: 2000,
    });
    const del = buildMaterializedEvent({
      kind: 'delete', wellName: 'Demo Well 1', companyId: 'wellbuilt-demo',
      packetId: 'pkt1', atMs: 3000,
    });
    expect(new Set([pull.eventId, edit.eventId, del.eventId]).size).toBe(3);
    expect(materializedPath('wellbuilt-demo', 'Demo Well 1')).toBe(
      'packets/materialized/wellbuilt-demo/DemoWell1',
    );
  });

  it('pull applies when outgoing packet id matches; early signal waits', () => {
    const ev = buildMaterializedEvent({
      kind: 'pull', wellName: 'W', companyId: 'c', packetId: 'p1', atMs: 1,
    });
    expect(decideApplyMaterialized(ev, null)).toBe('wait');
    expect(decideApplyMaterialized(ev, { lastPullPacketId: 'old' })).toBe('ignore');
    expect(decideApplyMaterialized(ev, { lastPullPacketId: 'p1' })).toBe('apply');
  });

  it('edit of the same packet id still applies', () => {
    const ev = buildMaterializedEvent({
      kind: 'edit', wellName: 'W', companyId: 'c', packetId: 'p1', atMs: 2,
    });
    expect(decideApplyMaterialized(ev, { lastPullPacketId: 'p1' })).toBe('apply');
  });

  it('delete waits until outgoing no longer shows the deleted packet', () => {
    const ev = buildMaterializedEvent({
      kind: 'delete', wellName: 'W', companyId: 'c', packetId: 'gone', atMs: 3,
    });
    expect(decideApplyMaterialized(ev, { lastPullPacketId: 'gone' })).toBe('wait');
    expect(decideApplyMaterialized(ev, { lastPullPacketId: 'survivor' })).toBe('apply');
  });

  it('rapid signals coalesce to the latest per well', () => {
    const a = buildMaterializedEvent({
      kind: 'pull', wellName: 'W', companyId: 'c', packetId: 'p1', atMs: 1,
    });
    const b = buildMaterializedEvent({
      kind: 'edit', wellName: 'W', companyId: 'c', packetId: 'p1', atMs: 2,
    });
    const pending = coalesceByWell(coalesceByWell({}, a), b);
    expect(Object.keys(pending)).toHaveLength(1);
    expect(pending['c:W'].kind).toBe('edit');
  });

  it('bounded retry then ignore if projections never converge', () => {
    const ev = buildMaterializedEvent({
      kind: 'pull', wellName: 'W', companyId: 'c', packetId: 'p1', atMs: 1,
    });
    let attempt = 0;
    let decision: string = 'wait';
    for (let i = 0; i < 6; i++) {
      const r = applyMaterializedWithRetry(ev, null, attempt, 4);
      decision = r.decision;
      attempt = r.nextAttempt;
    }
    expect(decision).toBe('ignore');
  });

  it('one well changing does not corrupt another', () => {
    const before = { A: { currentLevel: "10'0\"" }, B: { currentLevel: "8'0\"" } };
    const after = { A: { currentLevel: "3'0\"" }, B: { currentLevel: "8'0\"" } };
    expect(wellChangeIsolated(before, after, 'A')).toBe(true);
    const corrupted = { A: { currentLevel: "3'0\"" }, B: { currentLevel: "1'0\"" } };
    expect(wellChangeIsolated(before, corrupted, 'A')).toBe(false);
  });

  it('data refresh preserves UI session / demo presence', () => {
    const session = {
      expandedRoutes: ['Demo Route'],
      wellSearch: 'Demo',
      viewMode: 'table',
      demoPresenceActive: true,
    };
    expect(preserveUiSession(session)).toEqual(session);
    expect(preserveUiSession(session).demoPresenceActive).toBe(true);
  });

  it('does not encode a full-page reload', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../../src/app/mobile/page.tsx'),
      'utf8',
    );
    expect(src).not.toMatch(/window\.location\.reload/);
  });
});
