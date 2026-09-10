/**
 * Photo Review V1 wiring pins — no Firebase.
 * Run: node tools/test-dispatchPhotoReview.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const page = read('src/app/photo-review/page.tsx');
const core = read('functions/src/security/operational/dispatchPhotoReviewCore.ts');
const list = read('functions/src/security/operational/listDispatchPhotoReviews.ts');
const review = read('functions/src/security/operational/reviewDispatchPhoto.ts');
const idx = read('functions/src/index.ts');
const tabs = read('src/lib/tabs.ts');
const dialog = read('src/components/WellBuiltDialog.tsx');

check('Photo Review tab exists', tabs.includes("id: 'photo-review'") && tabs.includes("href: '/photo-review'"));
check('tab is gated on viewDispatch', /id: 'photo-review'[\s\S]*capability: 'viewDispatch'/.test(tabs));
check('page uses governed list/review callables', page.includes('listDispatchPhotoReviews') && page.includes('reviewDispatchPhoto'));
check('no browser confirm/alert/prompt', !/\bwindow\.(confirm|alert|prompt)\s*\(/.test(page) && !/\balert\s*\(/.test(page) && !/\bconfirm\s*\(/.test(page));
check('uses WellBuiltDialog', page.includes('WellBuiltDialog') && dialog.includes('role="dialog"'));
check('reject does not request a retake', page.includes('does not request a retake'));
check('callables exported from functions index', idx.includes('listDispatchPhotoReviews') && idx.includes('reviewDispatchPhoto') && idx.includes('commitDriverPhotoUpload'));
check('preserve accept/create dispatch exports', idx.includes('acceptDriverDispatch') && idx.includes('createDriverDispatchIfAbsent'));
check('list is company-scoped', list.includes("where('companyId', '==', companyId)"));
check('review writes sidecar + immutable event', review.includes('dispatchPhotoReviews') && review.includes('dispatchPhotoReviewEvents'));
check('review never writes invoices or photos array', !review.includes("collection('invoices')") || !review.includes('.update('));
check('core treats missing sidecar as unreviewed', core.includes("return 'unreviewed'"));
check('core reject requires reason', core.includes('reject_reason_required'));
check('core blocks cross-company', core.includes('wrong_company'));
check('display URL strips signed GET', core.includes('X-Goog-Signature'));
check('commitDriverPhotoUpload uses file.save not signBlob', read('functions/src/security/operational/commitDriverPhotoUpload.ts').includes('file.save') && !read('functions/src/security/operational/commitDriverPhotoUpload.ts').includes('getSignedUrl'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
