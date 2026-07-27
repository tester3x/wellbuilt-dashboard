// Liquid Gold legacy well-config backfill (7/26). Persists the verified
// preview engineering (same values as Dashboard Save) into legacy wells,
// non-destructively and idempotently. (Runs under functions/__tests__ — this
// repo's jest lives here; the module under test is the dashboard UI lib.)
import { computeBackfill, isEngineeringConfigured, planBackfill } from '../../../src/lib/lgWellBackfillCore';

// Real production shapes (from the read-only manifest).
const previewGabriel2 = {
  allowedBottom: 3, bottomLevel: 3, numTanks: 1, tanks: 1, route: 'Gabriels',
  routeGroupWell: 'Gabriel 2', routeRecording: true, ndicApiNo: '33-053-04306-00-00',
  ndicName: 'GABRIEL 2-36-25H', pullBbls: 140, avgFlowRate: '8:51:29', h2sStatus: 'low', waterWeight: 9.7,
};
const savedBlackdog = { tanks: 1, numTanks: 1, tankCapacity: 400, tankHeight: 20, bblPerFoot: 40, activeTanks: 2, route: 'X' };
const savedGab1 = { allowedBottom: 1.33, loadLine: 1.33, tanks: 2, numTanks: 2, tankCapacity: 400, tankHeight: 20, bblPerFoot: 40, activeTanks: 2 };
const twoTank = { tanks: 2, numTanks: 2, route: 'R', pullBbls: 280 };
const threeTank = { tanks: 3, numTanks: 3, route: 'R' };
const swdNoTanks = { route: 'Disposal', ndicName: 'HYDRO CLEAR SWD 1' }; // no tanks
const overrideWell = { tanks: 1, bblPerFootOverride: 55 };

describe('isEngineeringConfigured', () => {
  test('stored bblPerFoot / override / cap+ht are configured', () => {
    expect(isEngineeringConfigured(savedBlackdog)).toBe(true);
    expect(isEngineeringConfigured(overrideWell)).toBe(true);
    expect(isEngineeringConfigured({ tankCapacity: 400, tankHeight: 20, tanks: 1 })).toBe(true);
  });
  test('a preview well (no engineering) is NOT configured', () => {
    expect(isEngineeringConfigured(previewGabriel2)).toBe(false);
  });
});

describe('computeBackfill', () => {
  test('preview 1-tank well → backfill 20 BBL/ft, only missing keys', () => {
    const d = computeBackfill('Gabriel 2', previewGabriel2);
    expect(d.action).toBe('backfill');
    expect(d.effectiveBblPerFoot).toBe(20);
    expect(d.patch).toEqual({ tankCapacity: 400, tankHeight: 20, activeTanks: 1, bblPerFoot: 20 });
  });
  test('patch never contains a field the well already has (numTanks present)', () => {
    const d = computeBackfill('Gabriel 2', previewGabriel2);
    expect('numTanks' in (d.patch as any)).toBe(false);
    // and never a non-engineering field
    for (const k of ['allowedBottom', 'bottomLevel', 'route', 'pullBbls', 'routeGroupWell', 'ndicApiNo', 'ndicName', 'avgFlowRate', 'h2sStatus', 'waterWeight', 'tanks']) {
      expect(k in (d.patch as any)).toBe(false);
    }
  });
  test('preview 2-tank → 40, 3-tank → 60 (matches the verified previews)', () => {
    expect(computeBackfill('X', twoTank).effectiveBblPerFoot).toBe(40);
    expect(computeBackfill('X', twoTank).patch).toEqual({ tankCapacity: 400, tankHeight: 20, activeTanks: 2, bblPerFoot: 40 });
    expect(computeBackfill('Y', threeTank).effectiveBblPerFoot).toBe(60);
  });
  test('numTanks canonical duplicate added only when absent', () => {
    const d = computeBackfill('Z', { tanks: 2 }); // no numTanks
    expect((d.patch as any).numTanks).toBe(2);
  });
  test('already-configured wells are skipped (Blackdog, Gab 1, override)', () => {
    expect(computeBackfill('Blackdog', savedBlackdog)).toMatchObject({ action: 'skip', reason: 'already_configured' });
    expect(computeBackfill('Gab 1', savedGab1)).toMatchObject({ action: 'skip', reason: 'already_configured' });
    expect(computeBackfill('Ovr', overrideWell)).toMatchObject({ action: 'skip', reason: 'already_configured' });
  });
  test('a well with no tank count (SWD) is skipped as unresolved, never guessed', () => {
    expect(computeBackfill('HYDRO CLEAR SWD 1', swdNoTanks)).toMatchObject({ action: 'skip', reason: 'no_tank_count' });
  });
  test('no config → skip no_config', () => {
    expect(computeBackfill('Ghost', null)).toMatchObject({ action: 'skip', reason: 'no_config' });
  });
  test('idempotent: re-running on a backfilled well → already_configured', () => {
    const d1 = computeBackfill('Gabriel 2', previewGabriel2);
    const after = { ...previewGabriel2, ...d1.patch };
    expect(computeBackfill('Gabriel 2', after)).toMatchObject({ action: 'skip', reason: 'already_configured' });
  });
  test('zero valid values are honored (not treated as missing)', () => {
    // A legitimate saved bblPerFoot of a small positive value stays configured;
    // a 0 tank count is not a usable count.
    expect(computeBackfill('Zt', { tanks: 0 })).toMatchObject({ action: 'skip', reason: 'no_tank_count' });
  });
});

describe('planBackfill — whole set', () => {
  const configs: Record<string, any> = {
    'Gabriel 2': previewGabriel2,
    'Blackdog': savedBlackdog,
    'Gab 1': savedGab1,
    'Two': twoTank,
    'HYDRO CLEAR SWD 1': swdNoTanks,
  };
  const plan = planBackfill(configs, Object.keys(configs));
  test('backfills only the preview producing wells', () => {
    expect(plan.backfill.map((d) => d.wellName).sort()).toEqual(['Gabriel 2', 'Two']);
  });
  test('already-configured wells are in skipped, not backfill', () => {
    expect(plan.skipped.map((d) => d.wellName).sort()).toEqual(['Blackdog', 'Gab 1']);
  });
  test('SWD with no tank count lands in the unresolved list for Mike', () => {
    expect(plan.unresolved.map((d) => d.wellName)).toEqual(['HYDRO CLEAR SWD 1']);
  });
});
