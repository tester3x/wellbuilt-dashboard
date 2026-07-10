/**
 * WB eQuipment — DVIR client (eQuipmentDVIR callable).
 */

import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '../firebase';
import type { PreTripInspectionRecord } from './dvirContracts';

type DvirAction = 'dvir.listForCompany' | 'dvir.getInspection';

async function callDvir<T = Record<string, unknown>>(
  action: DvirAction,
  payload: Record<string, unknown>,
): Promise<T> {
  const fn = httpsCallable(getFirebaseFunctions(), 'eQuipmentDVIR');
  const result = await fn({ action, payload });
  return result.data as T;
}

export async function listDvirInspectionsForCompany(
  companyId: string,
  limit = 100,
): Promise<{ inspections: PreTripInspectionRecord[]; needsAttentionCount: number }> {
  const res = await callDvir<{
    inspections?: PreTripInspectionRecord[];
    needsAttentionCount?: number;
  }>('dvir.listForCompany', { companyId, limit });
  return {
    inspections: res.inspections || [],
    needsAttentionCount: res.needsAttentionCount || 0,
  };
}

export async function getDvirInspection(
  companyId: string,
  inspectionId: string,
): Promise<PreTripInspectionRecord | null> {
  const res = await callDvir<{ inspection?: PreTripInspectionRecord }>(
    'dvir.getInspection',
    { companyId, inspectionId },
  );
  return res.inspection || null;
}