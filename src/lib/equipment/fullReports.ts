import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '../firebase';

export type FullReportSummary = {
  documentId: string; inspectionId: string; reportId: string;
  inspectionType: 'pre_trip' | 'post_trip' | 'periodic'; version: number;
  reportDigest: string; storagePath: string; driverId: string;
  noDefects: boolean; completedAt: string; assetLabels: string[];
};

export type FullReport = {
  inspectionId: string; reportId: string; inspectionType: string;
  version: number; completedAt: string; noDefects: boolean;
  driver: { driverHash: string; displayName?: string };
  assets: Array<{ assetId: string; role: string; label?: string; unitNumber?: string }>;
  assetSections: Array<{ assetId: string; areaIds: string[]; issueIds: string[] }>;
  areas: Array<{ areaId: string; label: string; assetId: string; items: Array<{
    itemId: string; componentLabel: string; result: string; issueId?: string }> }>;
  issues: Array<{ issueId: string; assetId: string; componentLabel: string; severity: string; notes?: string }>;
  signature: { signerDisplayName?: string; signedAt: string; acknowledgementAccepted: boolean };
  inspectionProfile?: { profileId: string; revision: string };
};

export type VerifiedEvidence = {
  evidenceId: string;
  binding: { issueId: string; areaId: string; itemId: string; localEvidenceId: string };
};
export type FullReportDetail = FullReport & { documentId: string; verifiedEvidence: VerifiedEvidence[] };

export async function listFullReports(companyId: string): Promise<FullReportSummary[]> {
  const call = httpsCallable(getFirebaseFunctions(), 'listEquipmentInspectionReports');
  const result = await call({ schemaVersion: 1, companyId, limit: 100 });
  return (result.data as { reports: FullReportSummary[] }).reports;
}

export async function getFullReport(companyId: string, documentId: string): Promise<FullReportDetail> {
  const call = httpsCallable(getFirebaseFunctions(), 'getEquipmentInspectionReport');
  const result = await call({ schemaVersion: 1, companyId, documentId });
  const data = result.data as { report: FullReport; documentId: string; verifiedEvidence?: VerifiedEvidence[] };
  return { ...data.report, documentId: data.documentId, verifiedEvidence: data.verifiedEvidence || [] };
}

export async function getVerifiedEvidenceReadUrl(companyId: string, documentId: string,
  evidenceId: string): Promise<{ url: string; expiresAt: string }> {
  const call = httpsCallable(getFirebaseFunctions(), 'getEquipmentInspectionEvidenceReadUrl');
  const result = await call({ schemaVersion: 1, companyId, documentId, evidenceId });
  const data = result.data as { url?: string; expiresAt?: string; companyId?: string;
    documentId?: string; evidenceId?: string };
  if (data.companyId !== companyId || data.documentId !== documentId || data.evidenceId !== evidenceId
    || typeof data.url !== 'string' || !data.url.startsWith('https://')
    || typeof data.expiresAt !== 'string' || Date.parse(data.expiresAt) <= Date.now())
    throw new Error('Photo access response did not match this report');
  return { url: data.url, expiresAt: data.expiresAt };
}
