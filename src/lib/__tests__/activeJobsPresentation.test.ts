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

test('the larger operational/state pills use the shared 104px slot; stage/status keeps it', () => {
  // The row renders its operational/state pills through the shared 104px slot…
  assert.match(rowSource, /<CategoryBadge/, 'row uses the shared CategoryBadge slot');
  // …and the stage/status badge adopts that same 104px slot.
  assert.match(rowSource, /<StageBadge job=\{job\} slot \/>/, 'stage/status badge uses the 104px slot');
});

test('job-type badges are their OWN compact ~40x20 group — NOT the 104px categorical slot', () => {
  // A dedicated compact slot, sized ~40x20 (w-10 h-5), centered.
  const jt = source.match(/const JOB_TYPE_BADGE_SLOT =\s*\n?\s*'([^']+)'/);
  assert.ok(jt, 'JOB_TYPE_BADGE_SLOT exists');
  const slot = jt![1];
  assert.match(slot, /\bw-10\b/, 'fixed ~40px width (w-10)');
  assert.match(slot, /\bh-5\b/, 'fixed 20px height (h-5)');
  assert.match(slot, /justify-center/, 'centered horizontally');
  assert.match(slot, /items-center/, 'centered vertically');
  assert.doesNotMatch(slot, /min-w-\[6\.5rem\]|\bw-\[6\.5rem\]/, 'job type is NOT the 104px categorical slot');
  // The badge renders a canonical two-letter code and preserves the full name.
  const fn = source.slice(source.indexOf('function JobTypeBadge'), source.indexOf('function JobTypeBadge') + 700);
  assert.match(fn, /jobTypeAcronym\(type\)/, 'code + full name come from the canonical mapping');
  assert.match(fn, /className=\{`\$\{JOB_TYPE_BADGE_SLOT\}/, 'uses the compact job-type slot');
  assert.doesNotMatch(fn, /<CategoryBadge/, 'job-type badge never uses the 104px CategoryBadge');
  assert.match(fn, /title=\{title\}/, 'full name in tooltip');
  assert.match(fn, /aria-label=\{title\}/, 'full name in accessibility label');
  // The Active Job row uses JobTypeBadge WITHOUT the 104px slot prop.
  assert.match(rowSource, /<JobTypeBadge type=\{job\.jobType\} serviceType=\{job\.serviceType\} \/>/, 'row job-type badge takes no 104px slot');
  assert.doesNotMatch(rowSource, /<JobTypeBadge[^/]*\bslot\b/, 'job-type badge is not put in the 104px slot');
});

test('driver-group summaries use the two-letter mapping without global header totals', () => {
  assert.doesNotMatch(source, /\{pwLoads\} \{jobTypeCode\('pw'\)\}/, 'header omits misleading global PW load total');
  assert.doesNotMatch(source, /\{swLoads\} \{jobTypeCode\('service'\)\}/, 'header omits misleading global SW load total');
  assert.match(source, /\{pwCount\} \{jobTypeCode\('pw'\)\}/, 'driver-group PW summary uses the mapping');
  assert.match(source, /\{swCount\} \{jobTypeCode\('service'\)\}/, 'driver-group SW summary uses the mapping');
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

test('DispatchJobRow moves status/action badges to their own row below well name and destination', () => {
  // Well name is on Row 1 with break-words and minWidth: 100 removed to prevent compression
  assert.match(rowSource, /<span className="text-white font-medium text-sm break-words flex-1 min-w-0"/);
  assert.doesNotMatch(rowSource, /minWidth:\s*100/);

  // Destination sits on Row 2, status/action badges on Row 3
  const wellIdx = rowSource.indexOf('job.ndicWellName || job.wellName');
  const destIdx = rowSource.indexOf('→ {dropoff}');
  const badgeRowIdx = rowSource.indexOf('border-t border-gray-800/60');
  const controlsIdx = rowSource.indexOf('Controls always remain');

  assert.ok(wellIdx >= 0, 'well name present');
  assert.ok(destIdx > wellIdx, 'destination row follows well name');
  assert.ok(badgeRowIdx > destIdx, 'status/action badge row follows destination');
  assert.ok(controlsIdx > badgeRowIdx, 'controls sit in status/action badge row');
});

test('stacked jobs render a compact tinted header with well name, load count, and expand/collapse arrow', () => {
  const stackedStart = source.indexOf('details key={row.key}');
  assert.ok(stackedStart >= 0, 'stacked details found');
  const stackedChunk = source.slice(stackedStart, stackedStart + 3000);

  const summaryStart = stackedChunk.indexOf('<summary');
  const summaryEnd = stackedChunk.indexOf('</summary>');
  assert.ok(summaryStart >= 0 && summaryEnd > summaryStart, 'summary element found');
  const summaryChunk = stackedChunk.slice(summaryStart, summaryEnd);

  // Compact tinted header structure
  assert.match(summaryChunk, /bg-gray-800\/80 hover:bg-gray-800/, 'compact tinted header background');
  assert.match(summaryChunk, /row\.jobs\[0\]\.ndicWellName \|\| row\.jobs\[0\]\.wellName/, 'header contains well name');
  assert.match(summaryChunk, /break-words text-sm font-semibold text-white/, 'well name uses break-words font-semibold');
  assert.match(summaryChunk, /\{row\.remainingLoads\} \{row\.remainingLoads === 1 \? 'load' : 'loads'\}/, 'header displays load count text (e.g. 3 loads)');
  assert.match(summaryChunk, /group-open:rotate-180/, 'expand/collapse arrow with group-open rotation');

  // Summary header MUST NOT duplicate status badges, destination, or actions (those belong on child cards)
  assert.doesNotMatch(summaryChunk, /border-t border-gray-800\/60/, 'no badge row separator on header');
  assert.doesNotMatch(summaryChunk, /→ \{row\.jobs\[0\]\.hauledTo/, 'no destination on header');
  assert.doesNotMatch(summaryChunk, /<CategoryBadge/, 'no CategoryBadge pills on header');
  assert.doesNotMatch(summaryChunk, /StageBadge/, 'no StageBadge on header');

  // Child cards container renders each job via renderJob
  const childrenChunk = stackedChunk.slice(summaryEnd);
  assert.match(childrenChunk, /row\.jobs\.map\(job => <div key=\{job\.id\}>\{renderJob\(job\)\}<\/div>\)/, 'renders all child jobs individually');
});

