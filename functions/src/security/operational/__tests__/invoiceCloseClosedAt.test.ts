import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '..', 'invoiceOps.ts'), 'utf8');

describe('upsertDriverInvoice stamps stable server closedAt', () => {
  it('sets closedAt on first terminal transition', () => {
    expect(src).toMatch(/TERMINAL_STATUSES\.has\(nextStatus\) && !TERMINAL_STATUSES\.has\(prevStatus\)/);
    expect(src).toMatch(/inv\.closedAt = FieldValue\.serverTimestamp\(\)/);
  });
  it('does not overwrite closedAt on idempotent retry', () => {
    expect(src).toMatch(/TERMINAL_STATUSES\.has\(prevStatus\)[\s\S]{0,80}delete inv\.closedAt/);
  });
  it('still refuses reopen', () => {
    expect(src).toMatch(/Cannot reopen terminal invoice/);
  });
});
