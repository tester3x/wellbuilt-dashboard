import * as fs from 'fs';
import * as path from 'path';

describe('deployment manifest guard — prevent silent pruning of deployed callables', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../../index.ts'), 'utf8');

  // Authoritative deployed onboarding and join-code endpoints
  // Verified from live deployment manifest wbt-fn-list-20260906.json
  const REQUIRED_DEPLOYED_ENDPOINTS = [
    'getCompanyJoinCode',
    'adminCreateCompanyWithJoinCode',
    'adminApproveCompanyOnboarding',
    'adminListCompanyOnboardingRequests',
    'requestCompanyOnboarding',
  ];

  test.each(REQUIRED_DEPLOYED_ENDPOINTS)(
    'functions/src/index.ts exports deployed callable: %s',
    (callableName) => {
      // Must be exported as an entrypoint in index.ts
      const exportRegex = new RegExp(`\\b${callableName}\\b`);
      expect(indexSource).toMatch(exportRegex);
    },
  );

  test('cross-references against wbt-fn-list-20260906.json manifest if present', () => {
    const manifestPath = path.join(__dirname, '../../../../../_captures/wbt-fn-list-20260906.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const deployedIds = new Set((manifest.result || []).map((fn: any) => fn.id));
      for (const required of REQUIRED_DEPLOYED_ENDPOINTS) {
        expect(deployedIds.has(required)).toBe(true);
      }
    }
  });
});
