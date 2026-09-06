import { readFileSync } from 'fs';
import { join } from 'path';

const dashboardRoot = join(__dirname, '../../../..');

function read(rel: string) {
  return readFileSync(join(dashboardRoot, rel), 'utf8');
}

describe('Dashboard WB-M well-pool source', () => {
  it('seeds subscribeToWellStatusesUnified from adminGetWellPool / wellPoolResponses', () => {
    const wells = read('src/lib/wells.ts');
    expect(wells).toContain('adminGetWellPool');
    expect(wells).toContain('function wellPoolResponses');
    expect(wells).toContain('mergeWellPool');
    const unified = wells.slice(wells.indexOf('export function subscribeToWellStatusesUnified'));
    const beforeLive = unified.slice(0, unified.indexOf('const unsubConfigs'));
    expect(beforeLive).toContain('wellPoolResponses()');
  });

  it('mobile page uses the unified well-pool subscription (catalog-seeded)', () => {
    const mobile = read('src/app/mobile/page.tsx');
    expect(mobile).toContain('subscribeToWellStatusesUnified');
    expect(mobile).not.toMatch(/well_config\.json/);
  });

  it('catalog merge includes outgoing last-pull status fields (not raw packet ids)', () => {
    const wells = read('src/lib/wells.ts');
    expect(wells).toContain('lastPullDateTimeUTC');
    expect(wells).toContain('lastPullBbls');
    const proj = read('functions/src/security/dashboardCatalogProjection.ts');
    expect(proj).toContain('projectWellStatus');
    expect(proj).toContain('lastPullDateTimeUTC');
    expect(proj).toContain('lastPullBbls');
  });
});
