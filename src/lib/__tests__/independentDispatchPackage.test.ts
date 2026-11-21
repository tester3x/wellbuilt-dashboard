import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEPENDENT_DISPATCH_PACKAGE_ID, hasIndependentDispatchPackage, hasOnlyIndependentDispatchPackage } from '../independentDispatchPackage';

test('the independent dispatch card is available only with the exact active package', () => {
  assert.equal(INDEPENDENT_DISPATCH_PACKAGE_ID, 'independent-dispatch');
  assert.equal(hasIndependentDispatchPackage(['water-hauling']), false);
  assert.equal(hasIndependentDispatchPackage(['water-hauling', INDEPENDENT_DISPATCH_PACKAGE_ID]), true);
  assert.equal(hasIndependentDispatchPackage([]), false);
  assert.equal(hasIndependentDispatchPackage(undefined), false);
  assert.equal(hasIndependentDispatchPackage('independent-dispatch'), false);
  assert.equal(hasIndependentDispatchPackage(['Independent Dispatch', 'dispatch']), false);
  assert.equal(hasIndependentDispatchPackage([{ id: INDEPENDENT_DISPATCH_PACKAGE_ID }]), false);
});

test('only an Independent Dispatch-only company skips the standard workspace', () => {
  assert.equal(hasOnlyIndependentDispatchPackage(['independent-dispatch']), true);
  assert.equal(hasOnlyIndependentDispatchPackage(['water-hauling', 'independent-dispatch']), false);
  assert.equal(hasOnlyIndependentDispatchPackage(['water-hauling']), false);
  assert.equal(hasOnlyIndependentDispatchPackage([]), false);
  assert.equal(hasOnlyIndependentDispatchPackage(undefined), false);
});
