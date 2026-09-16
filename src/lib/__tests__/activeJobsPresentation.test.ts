import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../app/dispatch/page.tsx', import.meta.url), 'utf8');
const rowStart = source.indexOf('function DispatchJobRow(');
const rowEnd = source.indexOf('// Driver-centric active dispatch panel', rowStart);
const rowSource = source.slice(rowStart, rowEnd);

test('pending assignment age is attached to the Pending badge, not loose card text', () => {
  assert.match(source, /const pendingAge = job\.status === 'pending' \? timeAgo\(job\.assignedAt\) : '';/);
  assert.match(source, /\{fb\.label\}\{pendingAge \? ` · \$\{pendingAge\}` : ''\}/);
  assert.doesNotMatch(rowSource, /Time since assigned/);
  assert.doesNotMatch(source, /driverTimeAgo/);
});

test('active-job badges have stable semantic zones before the controls', () => {
  const identity = rowSource.indexOf('Identity: type, well, quantity');
  const flags = rowSource.indexOf('Operational flags: recommendations');
  const state = rowSource.indexOf('Job state: origin/progress');
  const controls = rowSource.indexOf('Controls always remain');

  assert.ok(identity >= 0, 'identity zone is present');
  assert.ok(flags > identity, 'operational flags follow identity');
  assert.ok(state > flags, 'job-state badges follow operational flags');
  assert.ok(controls > state, 'controls remain the final group');
});

test('there is ONE reusable FIXED-size categorical badge slot (identical width/height, centered)', () => {
  const slotMatch = source.match(/const CATEGORY_BADGE_SLOT =\s*\n?\s*'([^']+)'/);
  assert.ok(slotMatch, 'CATEGORY_BADGE_SLOT constant exists');
  const slot = slotMatch![1];
  assert.match(slot, /\bh-5\b/, 'fixed height');
  // FIXED width, not a minimum: every badge is exactly the same size.
  assert.match(slot, /\bw-\[6\.5rem\]/, 'fixed width w-[6.5rem]');
  assert.doesNotMatch(slot, /min-w-\[/, 'must NOT use a minimum width (that is not a fixed width)');
  assert.doesNotMatch(slot, /\bmax-w-\[/, 'no competing max-width');
  assert.match(slot, /justify-center/, 'content horizontally centered');
  assert.match(slot, /items-center/, 'content vertically centered');
  assert.match(slot, /text-center/, 'text centered');
  assert.match(slot, /whitespace-nowrap/, 'never wraps (no clipping into two lines)');
  assert.match(slot, /flex-shrink-0/, 'never shrinks below the fixed width');
});

test('categorical pills in the Active Job row use the shared slot (CategoryBadge / slot props)', () => {
  // The row renders its own categorical pills through the shared slot component…
  assert.match(rowSource, /<CategoryBadge/, 'row uses the shared CategoryBadge slot');
  // …and passes `slot` to the shared type/stage badges so they adopt the same slot.
  assert.match(rowSource, /<JobTypeBadge[^/]*\bslot\b[^>]*\/>/, 'PW/SW badge uses the slot');
  assert.match(rowSource, /<StageBadge job=\{job\} slot \/>/, 'stage/status badge uses the slot');
});

test('the DOWN warning is shortened to "⚠ DOWN" but keeps its actionable meaning', () => {
  assert.match(rowSource, /⚠ DOWN/, 'row shows the shortened DOWN warning');
  assert.doesNotMatch(rowSource, /WELL DOWN/, 'no longer the long "WELL DOWN" label');
  // Meaning preserved: still gated on the live canonical DOWN state, still actionable.
  assert.match(rowSource, /isWellDown/, 'DOWN badge is driven by the live canonical well state');
  assert.match(rowSource, /may still hold pullable water/, 'tooltip preserves the actionable meaning');
});

test('long informational chips are NOT forced into the fixed slot (kept truncated/constrained)', () => {
  // Transfer reason and driver-name chips stay separately constrained + truncated.
  const reasonIdx = rowSource.indexOf('Reason: {job.transferReason}');
  assert.ok(reasonIdx >= 0, 'transfer reason chip is present');
  const reasonChunk = rowSource.slice(reasonIdx - 260, reasonIdx);
  assert.match(reasonChunk, /max-w-\[220px\] truncate/, 'reason stays a truncated info chip');
  assert.doesNotMatch(reasonChunk, /<CategoryBadge/, 'reason is NOT put into the fixed categorical slot');
});
