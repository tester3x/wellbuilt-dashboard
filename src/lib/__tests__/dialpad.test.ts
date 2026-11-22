import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialpadCallHref } from '../dialpad';

test('Dialpad call link requires a valid international number and carries only the job ID', () => {
  assert.equal(dialpadCallHref('+17015550111', 'job-123'),
    'dialpad://+17015550111?confirmPhone=1&customData=wellbuilt-independent%3Ajob-123');
  assert.equal(dialpadCallHref('+17015550111'), 'dialpad://+17015550111?confirmPhone=1');
  assert.equal(dialpadCallHref('701-555-0111', 'job-123'), null);
  assert.equal(dialpadCallHref('+17015550111', 'bad/job'), 'dialpad://+17015550111?confirmPhone=1');
});
