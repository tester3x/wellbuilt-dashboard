// Normalized revision comparison + ordering safety (7/25).
//
// WB-T sends the complete canonical pull state on every Depart / Close /
// Split / History save. Identical revisions must acknowledge successfully
// without rewriting the pull or recomputing derived analytics; an older
// revision arriving late must never revert newer business state; retries
// never apply twice.
import * as fs from 'fs';
import * as path from 'path';
import {
  EditResolutionDb,
  editMaterialChange,
  isStaleRevision,
  resolveEditTarget,
} from '../packetGuards';

const PROCESSED_ID = '20260725_132315_GABRIEL1-36-25H_7guae0';
const PHANTOM_ID = '20260725_132315_GABRIEL1-36-25H_q1jwti';
const GAUGE = '2026-07-25T18:23:15.646Z';

/** Stored processed pull (CF-enriched; 19852-shaped, pre-correction). */
const processed: Record<string, unknown> = {
  packetId: PROCESSED_ID,
  requestType: 'pull',
  wellName: 'Gabriel 1',
  invoiceDocId: 'bosYvJhlcbM48av8qONh',
  dateTimeUTC: GAUGE,
  tankLevelFeet: 11.916666666666666,
  tankTopInches: 143,
  bblsTaken: 140,
  tankAfterInches: 59,
  flowRate: '0:20:00',
  processedAt: '2026-07-25T18:24:18.377Z',
};

/** A canonical milestone revision carrying identical business values plus
 *  transport/audit noise that must never look material. */
const identicalRevision: Record<string, unknown> = {
  requestType: 'edit',
  originalPacketId: PROCESSED_ID,
  wellName: 'Gabriel 1',
  dateTimeUTC: GAUGE,
  tankLevelFeet: 11.916666666666666,
  bblsTaken: '140', // formatting-only difference (string vs number)
  jobOrigin: 'split-milestone',
  splitRevisionNonce: 'opX_s2',
  queuedOffline: true,
  gaugeTime: GAUGE,
  source: 'wbt',
};

describe('editMaterialChange — normalized comparison', () => {
  test('1/2/3. identical Depart/Close/Split revisions → no material change', () => {
    for (const origin of ['depart-revision', 'close', 'split-milestone']) {
      const v = editMaterialChange({ ...identicalRevision, jobOrigin: origin }, processed);
      expect(v.changed).toBe(false);
      expect(v.fields).toEqual([]);
    }
  });

  test('4. changed 140→165 is material on bblsTaken only', () => {
    const v = editMaterialChange({ ...identicalRevision, bblsTaken: 165 }, processed);
    expect(v.changed).toBe(true);
    expect(v.fields).toEqual(['bblsTaken']);
  });

  test('5. changed gauge level is material', () => {
    const v = editMaterialChange({ ...identicalRevision, tankLevelFeet: 10.5 }, processed);
    expect(v.changed).toBe(true);
    expect(v.fields).toContain('topInches');
  });

  test('6. formatting-only differences are no-ops', () => {
    const v = editMaterialChange(
      {
        ...identicalRevision,
        bblsTaken: '140', // string vs stored number
        wellName: ' Gabriel 1 ', // whitespace
        tankTopInches: 143.0, // float representation of the same inches
      },
      processed,
    );
    expect(v.changed).toBe(false);
  });

  test('material: deliberate date correction and asserted wellDown flip', () => {
    expect(editMaterialChange({ ...identicalRevision, dateTimeUTC: '2026-07-25T19:00:00.000Z' }, processed).fields)
      .toEqual(['dateTimeUTC']);
    expect(editMaterialChange({ ...identicalRevision, wellDown: true }, processed).fields)
      .toEqual(['wellDown']);
    // No assertion → no change (partial edits stay supported).
    expect(editMaterialChange({ requestType: 'edit', originalPacketId: PROCESSED_ID }, processed).changed)
      .toBe(false);
  });

  test('real changes are never silently ignored (well identity)', () => {
    const v = editMaterialChange({ ...identicalRevision, wellName: 'Gabriel 2' }, processed);
    expect(v.changed).toBe(true);
    expect(v.fields).toEqual(['wellName']);
  });
});

describe('isStaleRevision — ordering safety', () => {
  test('8. older revision after newer cannot revert', () => {
    const applied = { ...processed, lastRevisionAt: '2026-07-25T19:17:00.000Z' };
    const late = { ...identicalRevision, bblsTaken: 150, revisionAt: '2026-07-25T18:30:00.000Z' };
    expect(isStaleRevision(late, applied)).toBe(true);
  });

  test('later revision may update; equal is not stale', () => {
    const applied = { ...processed, lastRevisionAt: '2026-07-25T18:30:00.000Z' };
    expect(isStaleRevision({ revisionAt: '2026-07-25T19:00:00.000Z' }, applied)).toBe(false);
    expect(isStaleRevision({ revisionAt: '2026-07-25T18:30:00.000Z' }, applied)).toBe(false);
  });

  test('clients without revision metadata keep last-write-wins (backward compatible)', () => {
    expect(isStaleRevision(identicalRevision, { ...processed, lastRevisionAt: '2026-07-25T19:00:00.000Z' })).toBe(false);
    expect(isStaleRevision({ revisionAt: '2026-07-25T18:00:00.000Z' }, processed)).toBe(false);
  });
});

describe('13/14. fallback resolution + comparison compose (19852 fixture)', () => {
  const db: EditResolutionDb = {
    async readProcessed(pid) {
      return pid === PROCESSED_ID ? processed : null;
    },
    async queryProcessedByInvoiceDocId(inv) {
      return inv === 'bosYvJhlcbM48av8qONh' ? [{ key: PROCESSED_ID, val: processed }] : [];
    },
  };

  test('corrected 165 via the phantom id resolves to the real pull and is material once', async () => {
    const r = await resolveEditTarget(db, PHANTOM_ID, 'bosYvJhlcbM48av8qONh');
    expect(r.kind).toBe('fallback');
    if (r.kind !== 'fallback') return;
    const v = editMaterialChange({ ...identicalRevision, bblsTaken: 165 }, r.packet);
    expect(v).toEqual({ changed: true, fields: ['bblsTaken'] });
    // 7. retry of the SAME 165 after application would compare against the
    // updated pull and no-op — no second recompute.
    const afterApply = { ...processed, bblsTaken: 165 };
    expect(editMaterialChange({ ...identicalRevision, bblsTaken: 165 }, afterApply).changed).toBe(false);
  });

  test('identical revision through the fallback also no-ops', async () => {
    const r = await resolveEditTarget(db, PHANTOM_ID, 'bosYvJhlcbM48av8qONh');
    if (r.kind !== 'fallback') throw new Error('expected fallback');
    expect(editMaterialChange(identicalRevision, r.packet).changed).toBe(false);
  });
});

describe('processEditRequest wiring (structural)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export const processEditRequest'), src.indexOf('export const', src.indexOf('export const processEditRequest') + 10));

  test('9/10/11. no-op consumes the incoming packet without touching the pull', () => {
    const noopIdx = fn.indexOf('[EDIT_NOOP_IDENTICAL]');
    expect(noopIdx).toBeGreaterThan(-1);
    const noopBlock = fn.slice(noopIdx, noopIdx + 1200);
    expect(noopBlock).toContain('consumeGovernedIncoming');
    expect(noopBlock).toContain("status: 'acknowledged'");
    expect(noopBlock).toContain('removeIncomingPacket');
    expect(noopBlock).toContain('return null');
    expect(noopBlock).not.toContain('packets/processed');
    // Ordering: stale check and no-op run BEFORE well-config / tank math.
    expect(fn.indexOf('isStaleRevision(')).toBeLessThan(fn.indexOf('well_config'));
    expect(fn.indexOf('editMaterialChange(')).toBeLessThan(fn.indexOf('well_config'));
  });

  test('applied revisions may stamp lastRevisionAt (audit) — both apply paths', () => {
    const stamps = fn.match(/lastRevisionAt: data\.revisionAt/g) || [];
    expect(stamps.length).toBe(2);
    // Original operational instant is never regenerated by the server: the
    // applied dateTimeUTC comes only from a validated offset-aware edit or
    // the stored original. Standalone display dateTime cannot redefine it.
    expect(fn).toContain('const newDateTimeUTC = utcOk ? String(data.dateTimeUTC).trim() : origPacket.dateTimeUTC;');
  });

  test('12. CREATE path (processIncomingPull) is untouched by revision logic', () => {
    const createFn = src.slice(src.indexOf('export const processIncomingPull'), src.indexOf('export const processEditRequest'));
    expect(createFn).not.toContain('editMaterialChange');
    expect(createFn).not.toContain('isStaleRevision');
  });

  test('stale revisions acknowledge and drop without any write', () => {
    const staleIdx = fn.indexOf('[EDIT_STALE_REVISION]');
    expect(staleIdx).toBeGreaterThan(-1);
    const block = fn.slice(staleIdx, staleIdx + 1200);
    expect(block).toContain('consumeGovernedIncoming');
    expect(block).toContain("status: 'rejected'");
    expect(block).toContain('stale_revision');
    expect(block).toContain('removeIncomingPacket');
    expect(block).not.toContain('packets/processed');
  });
});
