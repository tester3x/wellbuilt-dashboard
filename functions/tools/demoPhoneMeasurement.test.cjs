const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifiedPickupDraftLog } = require('./demoPhoneMeasurement.cjs');

const line = String.raw`1792040336.238 17681 17769 I ReactNativeJS: '[LiveBottomDiag]', '{"keypadActiveFieldKey":"top","keypadDraft":"10 0","committedBottom":"3\'0\\\"","topFeet":10,"bbls":140}'`;
const plan = { topFeet: 10, topInches: 120, bbls: 140 };

test('accepts the real logcat format despite invalid JSON foot-inch escaping', () => {
  assert.equal(verifiedPickupDraftLog(line, plan, 1792040335000), true);
});

test('rejects stale or mismatched measurements before Depart', () => {
  assert.equal(verifiedPickupDraftLog(line, plan, 1792040340000), false);
  assert.equal(verifiedPickupDraftLog(line, { ...plan, topInches: 117, topFeet: 9.75 }, 1792040335000), false);
  assert.equal(verifiedPickupDraftLog(line, { ...plan, bbls: 135 }, 1792040335000), false);
});
