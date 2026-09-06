/**
 * Dashboard ticket photo rendering does not consume gsUri/storagePath.
 * gs:// durable refs are deferred — not a completed Dashboard image path.
 * Run: node tools/test-dashboardPhotoGsUriDeferred.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modal = readFileSync(join(root, 'src/components/TicketDetailModal.tsx'), 'utf8');
const dispatch = readFileSync(join(root, 'src/app/dispatch/page.tsx'), 'utf8');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const photoBlock = modal.slice(modal.indexOf('PHOTOS'), modal.indexOf('PHOTOS') + 2500);
check('TicketDetailModal image href uses photo.uri only', photoBlock.includes('photo?.uri') && !photoBlock.includes('photo.gsUri') && !photoBlock.includes('photo.storagePath'));
check('empty uri skips the image (gs-only refs do not render)', photoBlock.includes('if (!url) return null'));
check('dispatch ticket photos also use uri, not gsUri', /ticketDetailData\.invoice\.photos/.test(dispatch) && !dispatch.includes('photo.gsUri'));
check('Dashboard gsUri/storagePath rendering is not implemented', !modal.includes('gsUri') && !photoBlock.includes('storagePath'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
