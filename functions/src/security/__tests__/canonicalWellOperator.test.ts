import { canonicalWellOperator, type OperatorLookup } from '../canonicalWellOperator';
const lookup = (records: Record<string, { operator?: unknown }[]>): OperatorLookup => async (collection, field, value) => records[`${collection}:${field}:${value}`] || [];
test('linked active API determines the official operator', async () => {
  expect(await canonicalWellOperator(lookup({'wells:api_no:api':[{operator:' Official Operator '}]}),'api','Pad')).toBe('Official Operator');
});
test('inactive well still gets its NDIC operator', async () => {
  expect(await canonicalWellOperator(lookup({'wells_inactive:api_no:api':[{operator:'Inactive Operator'}]}),'api','Pad')).toBe('Inactive Operator');
});
test('active metadata wins over an old inactive record', async () => {
  expect(await canonicalWellOperator(lookup({'wells:api_no:api':[{operator:'Current'}],'wells_inactive:api_no:api':[{operator:'Previous'}]}),'api','Pad')).toBe('Current');
});
test('ambiguous catalogue identity never invents an operator', async () => {
  expect(await canonicalWellOperator(lookup({'wells:api_no:api':[{operator:'A'},{operator:'B'}]}),'api','Pad')).toBeUndefined();
});
test('name fallback works only if API metadata is absent', async () => {
  expect(await canonicalWellOperator(lookup({'wells_inactive:well_name:Pad':[{operator:'Official'}]}),'api','Pad')).toBe('Official');
  expect(await canonicalWellOperator(lookup({}),'api','Pad')).toBeUndefined();
});
