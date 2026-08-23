import { readFileSync } from 'fs';
import { join } from 'path';
import {
  fetchWellPerformanceWithFallback,
  projectStoredWellPerformance,
  rowsFromSecureWellPayload,
  isDeniedPerformanceRead,
} from '../../../../src/lib/wellPerformanceRead';
import { projectWellPerformance } from '../operational/selectWellPerformance';
import { requestedAdminWellName } from '../operational/staffWellPerformanceRequest';

const dashboardRoot = join(__dirname, '../../../..');
const src = (rel: string) => readFileSync(join(dashboardRoot, rel), 'utf8');

const gabrielRows = Array.from({ length: 501 }, (_, i) => ({
  d: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
  a: 100 + (i % 7),
  p: 100,
}));

describe('individual-well Performance drill-down', () => {
  it('a denied direct RTDB read falls back to the authorized secure per-well read', async () => {
    let secureCalls = 0;
    const rows = await fetchWellPerformanceWithFallback({
      wellName: 'Gabriel 1',
      readNode: async () => {
        throw { code: 'PERMISSION_DENIED', message: 'permission-denied' };
      },
      readSecure: async (name) => {
        secureCalls += 1;
        expect(name).toBe('Gabriel 1');
        return {
          wellName: 'Gabriel 1',
          rows: [{ d: '2026-08-01', a: 10, p: 11 }],
        };
      },
    });
    expect(isDeniedPerformanceRead({ code: 'PERMISSION_DENIED' })).toBe(true);
    expect(secureCalls).toBe(1);
    expect(rows).toEqual([{ d: '2026-08-01', a: 10, p: 11 }]);
    expect(src('src/lib/wells.ts')).toMatch(/adminGetWellPerformanceForWell/);
    expect(src('src/lib/wells.ts')).toMatch(/fetchWellPerformanceWithFallback/);
    expect(src('src/lib/wells.ts')).not.toMatch(/getDriverWellPerformance/);
    expect(src('src/app/performance/well/page.tsx')).not.toMatch(/getDriverWellPerformance/);
  });

  it('a populated summary well with N rows opens a detail page with exactly N rows', async () => {
    const node = { wellName: 'Gabriel 1', rows: Object.fromEntries(gabrielRows.map((r, i) => [`r${i}`, r])) };
    const fromNode = projectStoredWellPerformance({ requestedWellName: 'Gabriel 1', node });
    expect(fromNode).toHaveLength(501);
    const fromSecure = await fetchWellPerformanceWithFallback({
      wellName: 'Gabriel 1',
      readNode: async () => {
        throw { code: 'permission-denied' };
      },
      readSecure: async () => ({ wellName: 'Gabriel 1', rows: gabrielRows }),
    });
    expect(fromSecure).toHaveLength(501);
    const page = src('src/app/performance/well/page.tsx');
    expect(page).toMatch(/const rows = \[\.\.\.stats\.rows\]/);
    expect(page).not.toMatch(/sortedRows\.slice\(/);
    expect(page).not.toMatch(/stats\.rows\.slice\(/);
    expect(page).not.toMatch(/Showing last /);
  });

  it('no UI slice or pagination silently removes returned rows', () => {
    const page = src('src/app/performance/well/page.tsx');
    expect(page).toMatch(/sortedRows\.map\(\(row, i\) => \{/);
    expect(page).toMatch(/Showing \{sortedRows\.length\}/);
    expect(page).not.toMatch(/pageSize|pagination|slice\(0,\s*\d+/);
    const wells = src('src/lib/wells.ts');
    const fetchFn = wells.slice(wells.indexOf('export async function fetchWellPerformance'));
    expect(fetchFn.slice(0, 800)).not.toMatch(/\.slice\(/);
  });

  it('missing, empty, mismatched, and A B/A_B collision stored names return no foreign rows', () => {
    const rows = { r: { d: '2026-08-01', a: 10, p: 10 } };
    expect(projectStoredWellPerformance({
      requestedWellName: 'Gabriel 1',
      node: null,
    })).toEqual([]);
    expect(projectStoredWellPerformance({
      requestedWellName: 'Gabriel 1',
      node: {},
    })).toEqual([]);
    expect(projectStoredWellPerformance({
      requestedWellName: 'Gabriel 1',
      node: { rows },
    })).toEqual([]);
    expect(projectStoredWellPerformance({
      requestedWellName: 'Gabriel 1',
      node: { wellName: 'Gabriel 9', rows },
    })).toEqual([]);

    const nodeAB = { wellName: 'A_B', rows };
    expect(projectStoredWellPerformance({ requestedWellName: 'A B', node: nodeAB })).toEqual([]);
    expect(projectStoredWellPerformance({ requestedWellName: 'A_B', node: nodeAB })).toEqual([
      { d: '2026-08-01', a: 10, p: 10 },
    ]);
    const nodeSpace = { wellName: 'A B', rows: { r: { d: '2026-08-01', a: 12, p: 12 } } };
    expect(projectStoredWellPerformance({ requestedWellName: 'A_B', node: nodeSpace })).toEqual([]);
    expect(projectWellPerformance({
      requestedWellName: 'A B',
      node: nodeAB,
    })).toEqual({ wellName: 'A B', updated: '', rows: [] });
    expect(rowsFromSecureWellPayload({ wellName: 'A_B', rows: [{ d: '2026-08-01', a: 1, p: 1 }] }, 'A B')).toEqual([]);
  });

  it('Loading, success, empty, and error states render correctly', () => {
    const page = src('src/app/performance/well/page.tsx');
    expect(page).toMatch(/dataLoading\s*\n\s*\? 'Loading\.\.\.'/);
    expect(page).toMatch(/loadError\s*\n\s*\? 'Unable to load'/);
    expect(page).toMatch(/stats && stats\.pullCount > 0/);
    expect(page).toMatch(/Loading performance data\.\.\./);
    expect(page).toMatch(/No performance data for this well/);
    expect(page).toMatch(/classifiedReadFailure\('well performance'/);
    expect(page).toMatch(/>\s*Retry\s*</);
    expect(page).toMatch(/setReloadToken/);
    expect(page).not.toMatch(/subtitle=\{stats \? `\$\{stats\.route\} · \$\{stats\.pullCount\} pulls` : 'Loading\.\.\.'\}/);
  });

  it('summary cards still use the bulk read and existing calculations', () => {
    const wells = src('src/lib/wells.ts');
    expect(wells).toMatch(/export async function fetchAllPerformanceData/);
    expect(wells).toMatch(/const remote = await adminGetWellPerformance\(\)/);
    expect(wells).toMatch(/export async function buildPerformanceSummary/);
    expect(wells).toMatch(/processPerformanceRows\(rawRows\)/);
    expect(wells).toMatch(/calcWellStats\(wellName, route, processed\)/);
    expect(src('src/app/performance/page.tsx')).toMatch(/buildPerformanceSummary\(\)/);
    expect(src('src/app/performance/route/page.tsx')).toMatch(/buildPerformanceSummary\(\)/);
    expect(wells).not.toMatch(/getDriverWellPerformance/);
  });

  it('staff bounded request uses exact wellName and does not scan every company node', () => {
    expect(requestedAdminWellName({ wellName: 'Gabriel 1' })).toBe('Gabriel 1');
    expect(requestedAdminWellName({})).toBeNull();
    const catalog = src('functions/src/security/adminDashboardCatalog.ts');
    expect(catalog).toMatch(/requestedAdminWellName\(request\.data\)/);
    expect(catalog).toMatch(/performance\/\$\{wellKey\}/);
    expect(catalog).toMatch(/projectWellPerformance/);
    expect(catalog).toMatch(/requireRegisteredDashboardUser/);
    expect(catalog).not.toMatch(/requireSecureDriver/);
    expect(catalog).not.toMatch(/getDriverWellPerformance/);
  });
});
