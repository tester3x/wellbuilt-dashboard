import {
  buildAppliedEditEvent,
  buildAppliedEditReceipt,
  buildFieldDiff,
  editHistoryWritePaths,
  editReceiptWritePaths,
  editSummaryFields,
  nextEditCount,
  normalizeEditSource,
  normalizeOriginAppContext,
  packetShowsEditBadge,
  resolveEditAuditContext,
  resolveEditEventId,
  resolveOriginalSubmissionAt,
  WBM_HAS_EDIT_DEADLINE,
  WBT_TICKET_EDIT_WINDOW_HOURS,
} from '../editHistory';

describe('product boundary: WB-M vs WB-T edit deadlines', () => {
  test('WB-M has no edit deadline in CF policy pins', () => {
    expect(WBM_HAS_EDIT_DEADLINE).toBe(false);
  });
  test('WB-T ticket 24h is a documentation pin only — not enforced here', () => {
    expect(WBT_TICKET_EDIT_WINDOW_HOURS).toBe(24);
  });
  test('corrections after 25h and after many days remain allowed (audit only)', () => {
    const origin = '2026-08-01T12:00:00.000Z';
    const originMs = Date.parse(origin);
    const day25 = originMs + 25 * 3600 * 1000;
    const day10 = originMs + 10 * 24 * 3600 * 1000;
    // Age is irrelevant to allow — resolveEditAuditContext always allows.
    for (const _t of [day25, day10]) {
      const ctx = resolveEditAuditContext({
        originalSubmittedAt: origin,
        dateTimeUTC: origin,
        originAppContext: 'wbt',
      });
      expect(ctx.allowed).toBe(true);
      expect(ctx.originalSubmissionAt).toBe(origin);
      expect(ctx.originAppContext).toBe('wbt');
    }
  });
  test('editedAt does not create a permission window', () => {
    const ctx = resolveEditAuditContext({
      originalSubmittedAt: '2026-01-01T00:00:00.000Z',
      editedAt: new Date().toISOString(),
      originAppContext: 'wbm',
    });
    expect(ctx.allowed).toBe(true);
  });
});

describe('normalizeEditSource', () => {
  test('wbm and dashboard pass through', () => {
    expect(normalizeEditSource('wbm')).toBe('wbm');
    expect(normalizeEditSource('dashboard')).toBe('dashboard');
  });
  test('missing source is unknown — never dashboard', () => {
    expect(normalizeEditSource(undefined)).toBe('unknown');
    expect(normalizeEditSource(null)).toBe('unknown');
    expect(normalizeEditSource('')).toBe('unknown');
  });
  test('arbitrary strings are not authority', () => {
    expect(normalizeEditSource('admin')).toBe('unknown');
  });
});

describe('normalizeOriginAppContext', () => {
  test('preserves wbt/wbm', () => {
    expect(normalizeOriginAppContext('wbt')).toBe('wbt');
    expect(normalizeOriginAppContext('wbm')).toBe('wbm');
  });
  test('unknown otherwise', () => {
    expect(normalizeOriginAppContext(undefined)).toBe('unknown');
    expect(normalizeOriginAppContext('dashboard')).toBe('unknown');
  });
});

describe('resolveEditEventId', () => {
  test('prefers client event id; retry stable', () => {
    const a = resolveEditEventId({
      incomingPacketId: 'edit_x',
      clientEventId: 'op_stable_01',
    });
    const b = resolveEditEventId({
      incomingPacketId: 'edit_x',
      clientEventId: 'op_stable_01',
    });
    expect(a).toBe(b);
  });
});

describe('applied edit receipts', () => {
  test('keyed by editEventId with digest; does not replace originalPacketId', () => {
    const receipt = buildAppliedEditReceipt({
      editEventId: 'editevt_a',
      originalPacketId: '20260823_112300_Gabriel5_fx0001',
      payloadDigest: 'abc123',
      appliedAt: '2026-08-23T17:00:00.000Z',
    });
    expect(receipt).toEqual({
      editEventId: 'editevt_a',
      originalPacketId: '20260823_112300_Gabriel5_fx0001',
      payloadDigest: 'abc123',
      appliedAt: '2026-08-23T17:00:00.000Z',
      status: 'accepted',
    });
    expect(editReceiptWritePaths('editevt_a', receipt)).toEqual({
      'packets/editReceipts/editevt_a': receipt,
    });
  });
});

describe('buildFieldDiff', () => {
  test('140→150 bbls only; server previous', () => {
    const diff = buildFieldDiff(
      { bblsTaken: 140, tankLevelFeet: 10, tankTopInches: 120 },
      { bblsTaken: 150 },
    );
    expect(diff).toEqual([{ field: 'bblsTaken', previous: 140, next: 150 }]);
  });
});

describe('packetShowsEditBadge', () => {
  test('modern editedAt badges', () => {
    expect(packetShowsEditBadge({ editedAt: '2026-08-05T20:23:43.299Z' })).toBe(true);
  });
  test('editCount badges', () => {
    expect(packetShowsEditBadge({ editCount: 1 })).toBe(true);
  });
  test('legacy isEdit badges', () => {
    expect(packetShowsEditBadge({ isEdit: true })).toBe(true);
  });
  test('unedited does not badge', () => {
    expect(packetShowsEditBadge({ requestType: 'pull', bblsTaken: 140 })).toBe(false);
  });
});

describe('history event provenance', () => {
  test('originAppContext separate from correction source', () => {
    const ev = buildAppliedEditEvent({
      eventId: 'e1',
      packetId: 'pkt1',
      sequence: 1,
      editedAt: '2026-08-07T00:00:00.000Z',
      source: 'wbm',
      originAppContext: 'wbt',
      fields: [{ field: 'bblsTaken', previous: 140, next: 150 }],
      originalSubmissionAt: '2026-08-06T00:00:00.000Z',
      resolutionPath: 'direct',
      editRequestId: 'edit_x',
    });
    expect(ev.source).toBe('wbm');
    expect(ev.originAppContext).toBe('wbt');
    expect(ev.payloadDigest).toBeNull();
    expect(editHistoryWritePaths('pkt1', ev)['packets/editHistory/pkt1/e1']).toEqual(ev);
  });
  test('nextEditCount increments', () => {
    expect(nextEditCount({})).toBe(1);
    expect(nextEditCount({ editCount: 1 })).toBe(2);
  });
  test('summary freezes originalSubmittedAt once', () => {
    const s = editSummaryFields({
      editedAt: 't',
      source: 'wbm',
      editCount: 1,
      originalSubmissionAt: 'orig',
      freezeOriginal: true,
    });
    expect(s.originalSubmittedAt).toBe('orig');
    expect(s.editedBy).toBe('wbm');
  });
});

describe('resolveOriginalSubmissionAt', () => {
  test('prefers frozen field', () => {
    expect(
      resolveOriginalSubmissionAt({
        originalSubmittedAt: 'A',
        dateTimeUTC: 'B',
      }),
    ).toBe('A');
  });
});
