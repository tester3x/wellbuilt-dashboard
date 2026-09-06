/**
 * upsertDriverInvoice close stamp: server closedAt once; retry must not
 * rewrite or extend the window. Run: node tools/test-invoiceCloseClosedAt.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'functions/src/security/operational/invoiceOps.ts'), 'utf8');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const firstClose = src.includes('if (TERMINAL_STATUSES.has(nextStatus) && !TERMINAL_STATUSES.has(prevStatus))')
  && /inv\.closedAt = FieldValue\.serverTimestamp\(\)/.test(src);
check('first terminal close stamps server closedAt', firstClose);

const retryDeletes = src.includes('} else {\n          delete inv.closedAt;\n        }')
  || /TERMINAL_STATUSES\.has\(prevStatus\)[\s\S]{0,400}delete inv\.closedAt/.test(src);
check('already-terminal retry deletes client closedAt', retryDeletes);

check('create-path terminal also stamps server closedAt',
  src.includes("TERMINAL_STATUSES.has(String(inv.status || '').toLowerCase())")
  && src.includes('inv.closedAt = FieldValue.serverTimestamp()'));

check('packetId frozen on retry', src.includes('if (prev.packetId) delete inv.packetId'));
check('canonicalJobId frozen on retry', src.includes('if (prev.canonicalJobId) delete inv.canonicalJobId'));
check('cannot reopen terminal invoice', src.includes('Cannot reopen terminal invoice'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
