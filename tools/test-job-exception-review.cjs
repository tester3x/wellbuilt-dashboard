const fs = require('node:fs'), assert = require('node:assert/strict'), cp = require('node:child_process');
const review = fs.readFileSync('src/components/JobExceptionReviews.tsx', 'utf8');
assert(review.includes("'reviewJobExceptions'"));
assert(review.includes('Approve this job exception'));
assert(review.includes('!note.trim()'));
assert(review.includes('item.scope.jobId') && review.includes('item.scope.pickup') && review.includes('item.scope.dropoff'));
const page = fs.readFileSync('src/app/location-review/page.tsx', 'utf8');
assert(page.includes('<JobExceptionReviews allowed={allowed}'));
assert(page.includes('min-h-screen bg-[#0b1220] text-white') && page.includes('Location Review'));
assert(page.includes('All caught up. No location requests need review.'));
assert(review.includes('All caught up. No job exceptions need review.'));
assert(page.includes('role="status"') && review.includes('role="status"'));
const call = cp.spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['jest', '--runInBand', '--runTestsByPath', 'src/security/__tests__/jobExceptions.test.ts', 'src/security/__tests__/arrivalLocations.test.ts'],
  { cwd: 'functions', stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
assert.equal(call.status, 0, 'exception authority and existing arrival review tests');
console.log('PASS explicit staff job exception review, bound details and retained location approval.');
