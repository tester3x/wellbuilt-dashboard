import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { matchIndependentOperator } from '../independentOperatorMatch';

const operators = [
  { name: 'XTO ENERGY INC' },
  { name: 'EXXONMOBIL OIL CORPORATION' },
  { name: 'MONGOOSE LLC' },
  { name: 'ROS OILFIELD SERVICES' },
  { name: 'ROS TRANSPORT LLC' },
];

test('matches customer names and common ExxonMobil abbreviation to unique catalog operators', () => {
  assert.equal(matchIndependentOperator(['XTO'], operators), 'XTO ENERGY INC');
  assert.equal(matchIndependentOperator(['Exmo'], operators), 'EXXONMOBIL OIL CORPORATION');
  assert.equal(matchIndependentOperator(['Mongoose Service'], operators), 'MONGOOSE LLC');
});

test('does not auto-select an ambiguous operator alias', () => {
  assert.equal(matchIndependentOperator(['ROS'], operators), '');
  assert.equal(matchIndependentOperator(['Unknown customer'], operators), '');
});
