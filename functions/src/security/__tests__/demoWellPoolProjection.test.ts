import { projectDemoCompanyWellPool } from '../adminDashboardCatalog';

describe('demo company well pool containment', () => {
  test('returns only demo-owned wells and matching outgoing status', () => {
    const result = projectDemoCompanyWellPool({
      'Demo Well 1': { companyId: 'wellbuilt-demo', isDemo: true, route: 'Demo Route',
        demoClockMultiplier: 12, demoRealMinutesPerFoot: 60 },
      'Gabriel 1': { companyId: 'liquid-gold', route: 'Gabriels' },
      'Demo Impostor': { companyId: 'liquid-gold', isDemo: true },
    }, {
      response_demo: { wellName: 'Demo Well 1', companyId: 'wellbuilt-demo',
        timestampUTC: '2026-10-14T12:00:00Z', demoTargetInches: 126 },
      response_liquid: { wellName: 'Gabriel 1', companyId: 'liquid-gold',
        timestampUTC: '2026-10-14T12:00:00Z' },
      response_impostor: { wellName: 'Demo Well 1', companyId: 'liquid-gold',
        timestampUTC: '2026-10-15T12:00:00Z' },
    });
    expect(Object.keys(result.wellConfig)).toEqual(['Demo Well 1']);
    // A newer cross-tenant row with the same wellName must not replace demo status.
    expect(result.wellStatus['Demo Well 1'].demoTargetInches).toBe(126);
    expect(result.wellStatus['Demo Well 1'].companyId).toBe('wellbuilt-demo');
  });

  test('keeps the demo clock fields without exposing unrelated config fields', () => {
    const result = projectDemoCompanyWellPool({
      'Demo Well 2': { companyId: 'wellbuilt-demo', isDemo: true,
        demoClockMultiplier: 12, demoRealMinutesPerFoot: 60,
        demoInitialLevelInches: 126, demoInitialAsOfUTC: '2026-10-14T12:00:00Z',
        demoInitialTriggerInches: 128, secret: 'never-return' },
    }, {});
    expect(result.wellConfig['Demo Well 2'].demoInitialTriggerInches).toBe(128);
    expect(result.wellConfig['Demo Well 2'].secret).toBeUndefined();
  });
});
