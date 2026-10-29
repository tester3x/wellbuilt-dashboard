/** Complete signed report fixture shared by validator and callable tests. */
export function fixture() {
  const truck = 'truck1'; const trailer = 'trailer1';
  return {
    schemaVersion: 'dvir-report/2', inspectionId: 'inspection1', reportId: 'inspection1',
    companyId: 'acme', inspectionType: 'pre_trip', driver: { driverHash: 'driver1' },
    assets: [{ assetId: truck, role: 'truck' }, { assetId: trailer, role: 'trailer' }],
    assetSections: [
      { assetId: truck, role: 'truck', areaIds: ['cab'], issueIds: [] },
      { assetId: trailer, role: 'trailer', areaIds: ['tank'], issueIds: ['issue1'] },
    ],
    catalogId: 'tractor-tanker-v1', catalogVersion: '1',
    startedAt: '2026-10-29T10:00:00Z', completedAt: '2026-10-29T10:10:00Z',
    generatedAt: '2026-10-29T10:10:00Z', createdAt: '2026-10-29T10:10:00Z',
    timezone: 'America/Chicago', signedAt: '2026-10-29T10:10:00Z',
    signature: { signerId: 'driver1', signedAt: '2026-10-29T10:10:00Z',
      reference: 'typed', kind: 'typed_name', acknowledgementAccepted: true },
    reportGenerationPolicy: 'always', noDefects: false, version: 1,
    repairCertification: { status: null }, nextDriverReview: {},
    summary: { inspectionId: 'inspection1', issuesFound: 1, overallResult: 'needs_attention' }, timeline: [],
    areas: [
      { areaId: 'cab', assetId: truck, assetRole: 'truck', items: [
        { itemId: 'lights', assetId: truck, result: 'pass' }] },
      { areaId: 'tank', assetId: trailer, assetRole: 'trailer', items: [
        { itemId: 'valves', assetId: trailer, result: 'needs_attention', issueId: 'issue1' }] },
    ],
    issues: [{ issueId: 'issue1', assetId: trailer, areaId: 'tank', itemId: 'valves', severity: 'minor', evidence: [] }],
  };
}
