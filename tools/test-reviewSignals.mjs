/**
 * Phase-8 — Dashboard review surfaces: review tags are informational (never
 * rejection gates), potential duplicates are never labeled proven, quarantine
 * rows are described losslessly, and the well page wires chips + quarantine
 * without hiding any pull.
 *
 * Run: node --experimental-strip-types tools/test-reviewSignals.mjs
 */
import {
  REVIEW_SIGNAL_CHIPS,
  chipsForPacket,
  describeQuarantineRow,
  hasReviewSignals,
  reviewSignalsFromPacket,
} from '../src/lib/reviewSignals.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
};

// ── Signal extraction: explicit true only ─────────────────────────────────
const s1 = reviewSignalsFromPacket({ lateEntry: true, anomaly: 'yes', potentialDuplicate: 1 });
check('only explicit true counts', s1.lateEntry === true && !s1.anomaly && !s1.potentialDuplicate && !s1.needsReview, JSON.stringify(s1));
check('legacy packets (no fields) are unflagged', !hasReviewSignals(reviewSignalsFromPacket({ bblsTaken: 140 })));
check('null-safe', !hasReviewSignals(reviewSignalsFromPacket(null)));

// ── Chips: order, labels, and honest language ─────────────────────────────
check('four chips defined in display order', REVIEW_SIGNAL_CHIPS.map((c) => c.key).join(',') === 'lateEntry,anomaly,potentialDuplicate,needsReview');
const dupChip = REVIEW_SIGNAL_CHIPS.find((c) => c.key === 'potentialDuplicate');
check('potential duplicate is NEVER phrased as proven', dupChip.label === 'Potential Duplicate' && /BOTH survive/i.test(dupChip.title), dupChip.title);
const flagged = chipsForPacket({ lateEntry: true, needsReview: true });
check('chipsForPacket returns exactly the raised flags', flagged.map((c) => c.key).join(',') === 'lateEntry,needsReview');
check('unflagged packet renders zero chips', chipsForPacket({}).length === 0);

// ── Quarantine description (the real Crossbow 1 wrapper shape) ────────────
const crossbow = describeQuarantineRow('20260828_142508_Crossbow1_c8neoe', {
  wellName: 'Crossbow 1',
  reason: 'STALE_PULL_TIME',
  readableReason: 'Incoming pull time … is not newer than the well’s outgoing watermark …',
  rejectedAt: '2026-08-28T14:25:13.435Z',
  packetId: '20260828_142508_Crossbow1_c8neoe',
  incomingDateTimeUTC: '2026-08-28T14:24:41.920Z',
  packet: {
    wellName: 'Crossbow 1',
    idempotencyKey: '20260828_092503_Crossbow1_dstw6f',
    _originalKey: '20260828_092503_Crossbow1_dstw6f',
    dateTimeUTC: '2026-08-28T14:24:41.920Z',
  },
});
check('quarantine row surfaces the held BUSINESS material (reviewable alternative), never credentials', (() => {
  const conflict = describeQuarantineRow('vB_conflict', {
    wellName: 'Gabriel 6', reason: 'CORRECTION_CONFLICT', readableReason: 'differs in bblsTaken',
    rejectedAt: '2026-08-30T00:00:00.000Z', packetId: 'vB_conflict',
    packet: { wellName: 'Gabriel 6', idempotencyKey: 'vB', _originalKey: 'vB', dateTimeUTC: '2026-08-28T02:00:00.000Z', tankLevelFeet: 11, bblsTaken: 55, wellDown: false, authToken: 'never-shown' },
  });
  return conflict
    && conflict.material.bblsTaken === 55
    && conflict.material.tankLevelFeet === 11
    && conflict.material.wellDown === false
    && conflict.originalId === 'vB'
    && !JSON.stringify(conflict).includes('never-shown'); // raw auth material never in the row model
})());
check('quarantine row keeps reason + exact identities + timestamps', crossbow
  && crossbow.reason === 'STALE_PULL_TIME'
  && crossbow.originalId === '20260828_092503_Crossbow1_dstw6f'
  && crossbow.eventTimeUTC === '2026-08-28T14:24:41.920Z'
  && crossbow.rejectedAt === '2026-08-28T14:25:13.435Z', JSON.stringify(crossbow));
check('malformed quarantine rows are skipped, not thrown', describeQuarantineRow('x', null) === null && describeQuarantineRow('x', { reason: 'y' }) === null);

// ── Page + lib wiring (source) ────────────────────────────────────────────
const wellPage = readFileSync(join(root, 'src/app/well/page.tsx'), 'utf8');
check('well page renders review chips on history rows', wellPage.includes('chipsForPacket(') && wellPage.includes('chip.title'));
check('well page shows the quarantine evidence section', wellPage.includes('fetchWellQuarantine(') && wellPage.includes('Quarantined packets'));
check('quarantine fetch failure never blocks the pull history', /fetchWellQuarantine\(wellName\)\s*\n?\s*\.then/.test(wellPage) && wellPage.includes('.catch(() => { if (!cancelled) setQuarantine([]); })'));
check('review chips never filter the pulls list (no signal-based filtering)', !/filteredPulls\s*=[^;]*(lateEntry|potentialDuplicate|needsReview)/.test(wellPage));

const wellsLib = readFileSync(join(root, 'src/lib/wells.ts'), 'utf8');
check('history mapping passes the four review flags through', ['lateEntry: data.lateEntry === true', 'anomaly: data.anomaly === true', 'potentialDuplicate: data.potentialDuplicate === true', 'needsReview: data.needsReview === true'].every((s) => wellsLib.includes(s)));
check('no Gabriel-recovery code was merged for this surface', !wellsLib.includes('recoverRejectedPull') && !wellPage.includes('recoverRejectedPull'));

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'} (${pass + fail} checks)`);
process.exit(fail === 0 ? 0 : 1);
