import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
export interface OfficeSyncAlert {
  id: string; companyId: string; driverId: string; driverName: string; kind: string;
  resourceId: string; reason: string; attempts: number; firstReportedAtMs: number; status: string;
}
export async function listOfficeSyncAlerts(companyId: string): Promise<OfficeSyncAlert[]> {
  const result = await httpsCallable<{ companyId: string }, { alerts: OfficeSyncAlert[] }>(getFirebaseFunctions(), 'adminListSyncAlerts')({ companyId });
  return result.data.alerts;
}
