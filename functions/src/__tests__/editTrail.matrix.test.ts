/**
 * Emulator-free regression matrix for the canonical edit trail contract.
 * Pure helpers + structural wiring (no live RTDB mutation).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  buildAppliedEditEvent,
  buildFieldDiff,
  nextEditCount,
  normalizeEditSource,
  normalizeOriginAppContext,
  packetShowsEditBadge,
  resolveEditAuditContext,
  resolveEditEventId,
  WBM_HAS_EDIT_DEADLINE,
} from '../editHistory';

const indexSrc = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
const guardsSrc = fs.readFileSync(path.join(__dirname, '../packetGuards.ts'), 'utf8');

describe('E2E matrix (contract)', () => {
  test('before Send is not an edit event (no requestType edit without server apply)', () => {
    // Client form changes never create editHistory without CF apply.
    expect(packetShowsEditBadge({ requestType: 'pull' })).toBe(false);
  });

  test('after Send correction → badge via editedAt/editCount', () => {
    expect(packetShowsEditBadge({ editedAt: '2026-08-07T00:00:00.000Z', editCount: 1 })).toBe(true);
  });

  test('processed 140→150 field diff', () => {
    const d = buildFieldDiff({ bblsTaken: 140 }, { bblsTaken: 150 });
    expect(d).toEqual([{ field: 'bblsTaken', previous: 140, next: 150 }]);
  });

  test('140→150→145 is two sequences', () => {
    expect(nextEditCount({})).toBe(1);
    expect(nextEditCount({ editCount: 1 })).toBe(2);
  });

  test('retry same editEventId is stable', () => {
    const id = resolveEditEventId({
      incomingPacketId: 'edit_20260801_120000_Well',
      clientEventId: 'editop_pkt1',
    });
    expect(
      resolveEditEventId({
        incomingPacketId: 'edit_20260801_120000_Well',
        clientEventId: 'editop_pkt1',
      }),
    ).toBe(id);
  });

  test('WB-T origin + WB-M correction provenance', () => {
    const ev = buildAppliedEditEvent({
      eventId: 'e1',
      packetId: 'p1',
      sequence: 1,
      editedAt: 't',
      source: 'wbm',
      originAppContext: 'wbt',
      fields: [{ field: 'bblsTaken', previous: 140, next: 150 }],
      originalSubmissionAt: 'orig',
      resolutionPath: 'direct',
      editRequestId: 'edit_x',
    });
    expect(ev.originAppContext).toBe('wbt');
    expect(ev.source).toBe('wbm');
  });

  test('correction after 25h and days later allowed (no WB-M deadline)', () => {
    expect(WBM_HAS_EDIT_DEADLINE).toBe(false);
    expect(
      resolveEditAuditContext({
        originalSubmittedAt: '2020-01-01T00:00:00.000Z',
        originAppContext: 'wbt',
      }).allowed,
    ).toBe(true);
  });

  test('missing source never becomes dashboard', () => {
    expect(normalizeEditSource(undefined)).toBe('unknown');
    expect(normalizeOriginAppContext(undefined)).toBe('unknown');
  });

  test('legacy Mikezfold-style editedAt badges without mutation', () => {
    expect(packetShowsEditBadge({ editedAt: '2026-08-06T19:12:16.000Z' })).toBe(true);
  });

  test('unedited does not badge', () => {
    expect(packetShowsEditBadge({ bblsTaken: 140, requestType: 'pull' })).toBe(false);
  });

  test('wiring: no EDIT_WINDOW_EXPIRED in processEditRequest path', () => {
    expect(indexSrc).not.toMatch(/EDIT_WINDOW_EXPIRED/);
    expect(indexSrc).toMatch(/resolveEditAuditContext/);
    expect(indexSrc).toMatch(/packets\/editHistory/);
    expect(indexSrc).toMatch(/materializeQueuedEditTrail/);
    expect(guardsSrc).toMatch(/resolveEditTarget/);
    expect(guardsSrc).toMatch(/quarantineIncomingPacket/);
  });

  test('wiring: invoice fallback + quarantine present', () => {
    expect(indexSrc).toMatch(/invoiceDocId_fallback/);
    expect(indexSrc).toMatch(/quarantineIncomingPacket/);
  });
});
