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

export async function listFullReports(companyId: string): Promise<FullReportSummary[]> {
  const call = httpsCallable(getFirebaseFunctions(), 'listEquipmentInspectionReports');
  const result = await call({ schemaVersion: 1, companyId, limit: 100 });
  return (result.data as { reports: FullReportSummary[] }).reports;
}

export async function getFullReport(companyId: string, documentId: string): Promise<FullReport> {
  const call = httpsCallable(getFirebaseFunctions(), 'getEquipmentInspectionReport');
  const result = await call({ schemaVersion: 1, companyId, documentId });
  return (result.data as { report: FullReport }).report;
}
