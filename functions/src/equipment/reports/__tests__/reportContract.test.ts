import { canonicalReportJson, digestReport, reportDocumentId, validateFullReport } from '../reportContract';

function fixture() {
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

describe('complete DVIR report contract', () => {
  it('preserves both assets and their frozen area and issue graph', () => {
    const row = fixture();
    expect(validateFullReport(row, 'acme')).toMatchObject({ inspectionId: 'inspection1', reportId: 'inspection1' });
    expect(digestReport(row)).toMatch(/^[a-f0-9]{64}$/);
  });
  it('uses sorted keys and JSON undefined omission while preserving arrays', () => {
    expect(canonicalReportJson({ b: [2, 1], a: undefined, c: { z: 2, a: 1 } }))
      .toBe('{"b":[2,1],"c":{"a":1,"z":2}}');
    expect(() => canonicalReportJson({ n: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalReportJson({ '__proto__': 'x', n: BigInt(2) })).toThrow();
  });
  it('rejects foreign company, missing signature, incomplete or misattributed areas', () => {
    const row = fixture();
    expect(() => validateFullReport(row, 'other')).toThrow();
    const unsigned = fixture(); unsigned.signature.acknowledgementAccepted = false;
    expect(() => validateFullReport(unsigned, 'acme')).toThrow();
    const wrong = fixture(); wrong.areas[1].assetId = 'truck1';
    expect(() => validateFullReport(wrong, 'acme')).toThrow();
  });
  it('rejects unsigned local evidence and reports larger than phone bound', () => {
    const row = fixture();
    (row.issues[0].evidence as object[]).push({ localDraftRef: 'draft1' });
    expect(() => validateFullReport(row, 'acme')).toThrow();
    expect(() => canonicalReportJson({ huge: 'x'.repeat(800_000) })).toThrow();
  });
  it('does not let a driver self-certify repair or next-driver review', () => {
    const repaired = fixture(); repaired.repairCertification.status = 'repaired' as never;
    expect(() => validateFullReport(repaired, 'acme')).toThrow();
    const reviewed = fixture();
    (reviewed.nextDriverReview as {reviewedAt?: string}).reviewedAt = '2026-10-29T10:11:00Z';
    expect(() => validateFullReport(reviewed, 'acme')).toThrow();
  });
  it('requires distinct report IDs for amendments while permitting phases to share an inspection ID', () => {
    const post = fixture(); post.inspectionType = 'post_trip';
    expect(validateFullReport(post, 'acme').inspectionId).toBe('inspection1');
    expect(reportDocumentId('acme', 'driver1', validateFullReport(post, 'acme')))
      .not.toBe(reportDocumentId('acme', 'driver1', validateFullReport(fixture(), 'acme')));
    const amendment = fixture(); amendment.version = 2; amendment.reportId = 'amendment2';
    expect(() => validateFullReport(amendment, 'acme')).toThrow();
    (amendment as typeof amendment & {amendmentOf?: string}).amendmentOf = 'inspection1';
    expect(validateFullReport(amendment, 'acme').version).toBe(2);
  });
});
