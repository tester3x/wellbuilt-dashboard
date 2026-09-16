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
