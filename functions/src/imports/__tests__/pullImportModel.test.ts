import { reviewPulls, canonicalHistory, calibration, buildHistoricalPackets, type JsonRecord } from '../pullImportModel';
import { parsePullChat } from '../pullParser';
import { historicalAverage } from '../historicalAverage';
const config = { 'Kahuna 5': { bblPerFoot: 180, tanks: 9, tankHeight: 20, ndicName: 'KAHUNA 5-6-7H' } };
const pulls = () => parsePullChat('[9/20/26, 3:00 PM] Driver: Kahuna 5- 8.0/7.0\n180 bbls\n[9/20/26, 5:00 PM] Driver: Kahuna 5- 8.0/7.0\n180 bbls');
test('stored bank is not multiplied by active tank count', () => { expect(calibration(config['Kahuna 5'])).toBe(180); });
test('catalogue aliases map before validation', () => {
  const input = pulls(); input[0].wellName = 'KAHUNA 5-6-7H';
  expect(reviewPulls(input, config, {}, {}, new Set())[0].wellName).toBe('Kahuna 5');
});
test('canonical and idem receipt count once; edited canonical remains visible', () => {
  const packet = { wellName:'Kahuna 5', dateTimeUTC:'2026-09-20T20:00:00Z', tankLevelFeet:8, bblsTaken:180, wasEdited:true };
  expect(canonicalHistory({ abc:packet, idem_abc:packet, history_old:packet, edit_one:packet })).toHaveLength(1);
});
test('same pull from another export is a duplicate, even with another message id', () => {
  const input = pulls(); const reviewed = reviewPulls(input, config, {}, {}, new Set());
  const packets = buildHistoricalPackets(reviewed, {}, 'batch','staff','company');
  input[0].id = 'other-export:88';
  expect(reviewPulls(input, config, { 'Kahuna 5':packets }, {}, new Set())[0].status).toBe('duplicate');
});
test('existing native pull within 90 seconds skips; nearby ambiguous event requires review', () => {
  const row = pulls()[0];
  const history: JsonRecord = { 'Kahuna 5': { native: { ...row, dateTimeUTC:'2026-09-20T20:01:00Z' } } };
  expect(reviewPulls([row],config,history,{},new Set())[0].status).toBe('duplicate');
  history['Kahuna 5'].native.dateTimeUTC = '2026-09-20T20:20:00Z';
  expect(reviewPulls([row],config,history,{},new Set())[0].status).toBe('review');
});
test('acknowledgment cannot waive impossible levels, missing barrels or future time', () => {
  const row = pulls()[0]; row.tankLevelFeet=100; row.bblsTaken=null; row.dateTimeUTC='2099-01-01T00:00:00Z';
  const result = reviewPulls([row],config,{}, {},new Set([row.id]));
  expect(result[0].status).toBe('review'); expect(result[0].issues).toHaveLength(3);
});
test('calibrated recovery accounts for previous removal and preserves source provenance', () => {
  const packets = Object.values(buildHistoricalPackets(reviewPulls(pulls(),config,{}, {},new Set()),{},'batch','staff','company'));
  expect(packets[1].flowRateDays * 1440).toBeCloseTo(120);
  expect(packets[1].tankAfterInches).toBe(84);
  expect(packets[1].historicalOnly).toBe(true);
  expect(packets[1].historicalImport.bblPerFoot).toBe(180);
  expect(packets[1].driverId).toBeUndefined(); expect(packets[1].invoiceDocId).toBeUndefined();
});
test('negative recovery does not invent production', () => {
  const rows=pulls(); rows[1].tankLevelFeet=6; rows[1].bottomLevelFeet=5;
  const packets=Object.values(buildHistoricalPackets(reviewPulls(rows,config,{}, {},new Set()),{},'batch','staff','company'));
  expect(packets[1].flowRateDays).toBe(0);
});
test('a sustained rate change resets the adaptive average', () => {
  expect(historicalAverage([1,1,1,1,3,3,3])).toBe(3);
  expect(historicalAverage([1,1,1,1,1,9,1])).toBeCloseTo(1);
});

test('a different full NDIC identifier is not silently assigned to the short well',()=>{
 const rows=pulls();rows[0].wellName='Kahuna 5-99-99H';expect(reviewPulls(rows,config,{}, {},new Set())[0].status).toBe('review');
});

test('nearby native pull with matching top but differing barrels is held',()=>{const row=pulls()[0];const history={'Kahuna 5':{native:{...row,bblsTaken:140,dateTimeUTC:'2026-09-20T20:02:00Z'}}};expect(reviewPulls([row],config,history,{},new Set())[0].status).toBe('review');});
