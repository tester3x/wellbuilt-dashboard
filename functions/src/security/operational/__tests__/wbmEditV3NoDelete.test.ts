import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The null-first-run transaction fallback (`cur ?? preOp`) is safe against
 * RESURRECTING a deleted op ONLY because the v3 lane has no delete path: a
 * `cur === null` inside a v3 transaction can therefore only be the admin SDK's
 * optimistic first run of an op that still exists on the server, never a genuine
 * deletion. This test enforces that invariant structurally: no production code
 * may remove/null the `wbmEdits/v3/ops` subtree.
 */
describe('wbmEdits/v3/ops has NO delete path (resurrection-safety invariant)', () => {
  const index = readFileSync(join(__dirname, '../../../index.ts'), 'utf8');

  test('index.ts never removes or nulls a wbmEdits/v3/ops node', () => {
    const lines = index.split(/\r?\n/);
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!/wbmEdits\/v3|WBM_EDIT_V3_OPS_PATH|wbmEditV3OpPath/.test(line)) return;
      // A delete would be a .remove( on such a ref, or a transaction/set that
      // returns null for the node. Transactions here only ever return an op or
      // undefined (abort) — never null.
      if (/\.remove\s*\(/.test(line)) offenders.push(`remove @${i + 1}: ${line.trim()}`);
      if (/\.set\s*\(\s*null/.test(line)) offenders.push(`set(null) @${i + 1}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });

  test('the lane module exposes no delete/remove helper for v3 ops', () => {
    const lane = readFileSync(join(__dirname, '../wbmEditV3Lane.ts'), 'utf8');
    expect(/delete|remove/i.test(lane.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))).toBe(false);
  });
});
