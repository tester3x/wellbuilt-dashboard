import { applyDispatchSwdDirectory } from '../dispatchSwdDirectory';
test('company SWD rename preserves API/coordinates and updates searchable name', () => {
  const rows = applyDispatchSwdDirectory([{ well_name: 'Old SWD', operator: 'Owner', api_no: 'test-api', latitude: 1 }], [{ ndicWellName: 'Old SWD', displayName: 'New SWD', isCustom: false }]);
  expect(rows[0]).toMatchObject({ well_name: 'New SWD', api_no: 'test-api', latitude: 1, search_name: 'new swd' });
});
test('blacklisted SWDs are removed and permitted custom entries are added', () => {
  const rows = applyDispatchSwdDirectory([{ well_name: 'Blocked SWD' }], [{ ndicWellName: 'Blocked SWD', isBlacklisted: true }, { displayName: 'Custom SWD', isCustom: true, county: 'Test' }, { displayName: 'Blocked Custom', isCustom: true, isBlacklisted: true }]);
  expect(rows.map(r => r.well_name)).toEqual(['Custom SWD']);
});
