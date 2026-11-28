import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
export interface OfficeSyncAlert {
  id: string; companyId: string; driverId: string; driverName: string; kind: string;
  resourceId: string; reason: string; attempts: number; firstReportedAtMs: number; status: string;
}
export async function listOfficeSyncAlerts(companyId: string | null): Promise<OfficeSyncAlert[]> {
  const result = await httpsCallable<{ companyId?: string; allCompanies?: true }, { alerts: OfficeSyncAlert[] }>(getFirebaseFunctions(), 'adminListSyncAlerts')(companyId ? { companyId } : { allCompanies: true });
  return result.data.alerts;
}
