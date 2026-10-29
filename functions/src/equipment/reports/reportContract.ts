import { createHash } from 'crypto';
import * as httpsV2 from 'firebase-functions/v2/https';

type Obj = Record<string, unknown>;
const fail = (message: string): never => { throw new httpsV2.HttpsError('invalid-argument', message); };
const object = (value: unknown, name: string): Obj => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`Invalid ${name}`);
  return value as Obj;
};
const list = (value: unknown, name: string, max = 2000): unknown[] => {
  if (!Array.isArray(value) || value.length > max) return fail(`Invalid ${name}`);
  return value;
};
export const reportId = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)
    || ['__proto__', 'prototype', 'constructor'].includes(value)) return fail(`Invalid ${name}`);
  return value;
};
const nonempty = (value: unknown, name: string, max = 500): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail(`Invalid ${name}`);
  return value;
};

/** Match phone JSON semantics before recursively sorting object keys. */
export function canonicalReportJson(value: unknown): string {
  const seen = new Set<object>();
  function normalize(input: unknown, inArray = false): unknown {
    if (input === undefined) return inArray ? null : undefined;
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) fail('Nonfinite report number');
      return input;
    }
    if (typeof input !== 'object') fail('Unsupported report value');
    if (seen.has(input as object)) fail('Circular report value');
    seen.add(input as object);
    let result: unknown;
    if (Array.isArray(input)) result = input.map(item => normalize(item, true));
    else {
      const row = input as Obj;
      const sorted: Obj = {};
      for (const key of Object.keys(row).sort()) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Reserved report key');
        const item = normalize(row[key]);
        if (item !== undefined) sorted[key] = item;
      }
      result = sorted;
    }
    seen.delete(input as object);
    return result;
  }
  const normalized = normalize(value);
  const json = JSON.stringify(normalized);
  if (!json) fail('Invalid report JSON');
  if (Buffer.byteLength(json, 'utf8') > 800_000) fail('Report exceeds 800000 bytes');
  return json;
}

export const digestReport = (value: unknown): string => createHash('sha256').update(canonicalReportJson(value), 'utf8').digest('hex');

/** Phase, amendment, and driver are part of the immutable write identity. */
export function reportDocumentId(companyId: string, driverId: string, report: ValidReport): string {
  const identity = [companyId, driverId, report.inspectionId,
    report.inspectionType, report.reportId, String(report.version)].join('\u001f');
  return `r_${createHash('sha256').update(identity).digest('hex')}`;
}

export type ValidReport = {
  inspectionId: string; reportId: string; inspectionType: 'pre_trip' | 'post_trip' | 'periodic';
  version: number; companyId: string; driverHash: string; raw: Obj;
};

/** Validate the immutable graph before accepting the signed full report. */
export function validateFullReport(value: unknown, companyId: string): ValidReport {
  const row = object(value, 'report');
  if (row.schemaVersion !== 'dvir-report/2' || row.companyId !== companyId) fail('Report identity mismatch');
  const inspectionId = reportId(row.inspectionId, 'inspectionId');
  const id = reportId(row.reportId, 'reportId');
  const version = row.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1 || (version as number) > 1000) fail('Invalid report version');
  if (version === 1 && id !== inspectionId) fail('Original report ID mismatch');
  if (version !== 1 && !row.amendmentOf) fail('Amendment parent required');
  if (row.amendmentOf) reportId(row.amendmentOf, 'amendmentOf');
  const inspectionType = row.inspectionType;
  if (!['pre_trip', 'post_trip', 'periodic'].includes(inspectionType as string)) fail('Invalid inspectionType');
  const driver = object(row.driver, 'driver');
  const driverHash = reportId(driver.driverHash, 'driverHash');
  const signature = object(row.signature, 'signature');
  nonempty(signature.signerId, 'signerId', 128);
  const signatureReference = nonempty(signature.reference, 'signature reference', 500);
  if (/^(?:data:|file:|content:|https?:\/\/)/i.test(signatureReference)) fail('Signature reference must be opaque');
  nonempty(signature.signedAt, 'signedAt', 80);
  if (signature.acknowledgementAccepted !== true || row.signedAt !== signature.signedAt) fail('Unsigned report');
  if (!['typed_name', 'stroke_ref', 'image_ref', 'external_ref'].includes(signature.kind as string))
    fail('Invalid signature kind');
  if (signature.imageDataUrl !== undefined && (typeof signature.imageDataUrl !== 'string'
    || signature.imageDataUrl.length > 200_022
    || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]+={0,2}$/.test(signature.imageDataUrl))) fail('Invalid adopted signature PNG');
  for (const date of ['startedAt', 'completedAt', 'generatedAt', 'createdAt']) {
    const value = nonempty(row[date], date, 80);
    if (!Number.isFinite(Date.parse(value))) fail(`Invalid ${date}`);
  }
  nonempty(row.catalogId, 'catalogId', 128); nonempty(row.catalogVersion, 'catalogVersion', 128);
  nonempty(row.timezone, 'timezone', 100);
  if (!['always', 'defects_only'].includes(row.reportGenerationPolicy as string)) fail('Invalid report policy');
  if (row.repairCertification === undefined || row.nextDriverReview === undefined
    || row.summary === undefined || row.timeline === undefined) fail('Incomplete report');
  list(row.timeline, 'timeline');
  const repair = object(row.repairCertification, 'repairCertification');
  const nextDriver = object(row.nextDriverReview, 'nextDriverReview');
  if (repair.status !== null || Object.entries(repair).some(([key, value]) => key !== 'status' && value != null)
    || Object.values(nextDriver).some(value => value != null)) fail('Driver report cannot self-certify repair or next-driver review');
  object(row.summary, 'summary');

  const assets = list(row.assets, 'assets', 50).map(asset => object(asset, 'asset'));
  if (!assets.length) fail('Report requires an asset');
  const assetIds = new Set<string>();
  for (const asset of assets) {
    const assetId = reportId(asset.assetId, 'assetId');
    if (assetIds.has(assetId) || !['truck', 'trailer'].includes(asset.role as string)) fail('Invalid asset');
    assetIds.add(assetId);
  }
  const sections = list(row.assetSections, 'assetSections', 50).map(section => object(section, 'assetSection'));
  if (sections.length !== assets.length) fail('Asset section mismatch');
  const sectionIds = new Set<string>();
  for (const section of sections) {
    const assetId = reportId(section.assetId, 'section assetId');
    const asset = assets.find(item => item.assetId === assetId);
    if (!asset || sectionIds.has(assetId) || section.role !== asset.role) fail('Asset section mismatch');
    sectionIds.add(assetId);
    list(section.areaIds, 'section areaIds'); list(section.issueIds, 'section issueIds');
  }
  const areas = list(row.areas, 'areas').map(area => object(area, 'area'));
  if (!areas.length) fail('Report requires areas');
  const areaIds = new Set<string>();
  const items = new Map<string, Obj>();
  for (const area of areas) {
    const areaId = reportId(area.areaId, 'areaId');
    const asset = assets.find(item => item.assetId === area.assetId);
    if (areaIds.has(areaId) || !asset || area.assetRole !== asset.role) fail('Area asset mismatch');
    areaIds.add(areaId);
    const section = sections.find(item => item.assetId === area.assetId);
    if (!section || !(section.areaIds as unknown[]).includes(areaId)) fail('Area section mismatch');
    const areaItems = list(area.items, 'items');
    if (!areaItems.length) fail('Area requires items');
    for (const rawItem of areaItems) {
      const item = object(rawItem, 'item');
      const itemId = reportId(item.itemId, 'itemId');
      if (item.assetId !== area.assetId || !['pass', 'needs_attention'].includes(item.result as string)
        || items.has(itemId)) fail('Invalid item attribution');
      if (item.result === 'pass' && item.issueId !== undefined) fail('Passing item cannot reference issue');
      items.set(itemId, { ...item, areaId });
    }
  }
  for (const section of sections) {
    const expected = areas.filter(area => area.assetId === section.assetId).map(area => area.areaId);
    const actual = section.areaIds as unknown[];
    if (actual.length !== expected.length || new Set(actual).size !== actual.length
      || expected.some(id => !actual.includes(id))) fail('Asset section areas mismatch');
  }
  const issues = list(row.issues, 'issues').map(issue => object(issue, 'issue'));
  const issueIds = new Set<string>();
  for (const issue of issues) {
    const issueId = reportId(issue.issueId, 'issueId');
    const item = items.get(reportId(issue.itemId, 'issue itemId'));
    if (issueIds.has(issueId) || !item || item.areaId !== issue.areaId || item.assetId !== issue.assetId
      || item.result !== 'needs_attention' || item.issueId !== issueId
      || !['minor', 'major', 'critical'].includes(issue.severity as string)) fail('Issue attribution mismatch');
    issueIds.add(issueId);
    const section = sections.find(entry => entry.assetId === issue.assetId);
    if (!section || !(section.issueIds as unknown[]).includes(issueId)) fail('Issue section mismatch');
    for (const evidenceRaw of list(issue.evidence, 'evidence', 50)) {
      const evidence = object(evidenceRaw, 'evidence');
      if (evidence.localDraftRef !== undefined || evidence.remoteEvidenceId !== undefined)
        fail('Defect media transport is not available');
    }
  }
  for (const section of sections) {
    const expected = issues.filter(issue => issue.assetId === section.assetId).map(issue => issue.issueId);
    const actual = section.issueIds as unknown[];
    if (actual.length !== expected.length || new Set(actual).size !== actual.length
      || expected.some(id => !actual.includes(id))) fail('Asset section issues mismatch');
  }
  if (items.size === 0 || [...items.values()].some(item => item.result === 'needs_attention' && !issueIds.has(item.issueId as string)))
    fail('Unreported inspection issue');
  if (row.noDefects !== (issues.length === 0)) fail('No-defects mismatch');
  const summary = row.summary as Obj;
  if (summary.inspectionId !== inspectionId) fail('Summary inspection mismatch');
  if (summary.issuesFound !== issues.length) fail('Summary issue count mismatch');
  if (summary.overallResult !== (issues.length ? 'needs_attention' : 'pass')) fail('Summary result mismatch');
  return { inspectionId, reportId: id, inspectionType: inspectionType as ValidReport['inspectionType'],
    version: version as number, companyId, driverHash, raw: row };
}
