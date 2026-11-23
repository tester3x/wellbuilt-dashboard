import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export type IndependentJobDetails = {
  title: string; customer: string; reference: string; pickup: string; destination: string;
  cargo: string; scheduledAt: string; notes: string;
  jobContactName?: string; jobContactRole?: string; jobContactPhoneE164?: string;
  customerId?: string; sector?: string; sectorFields?: Record<string, string>;
  categoryId?: string; asset?: string;
};
export type IndependentJobStatus = 'unassigned' | 'assigned' | 'in_progress' | 'completed' | 'cancelled';
export type IndependentJob = IndependentJobDetails & {
  id: string; companyId: string; revision: number; status: IndependentJobStatus;
  externalDriverId?: string; wbDriverId?: string; wbDriverCompanyId?: string;
  driverSource?: 'outside' | 'wellbuilt'; driverName?: string; createdAt?: string; updatedAt: string;
};
export type LinkedWellBuiltDriver = { driverId: string; sourceCompanyId: string; displayName: string };
export async function independentDispatchJobs(payload: Record<string, unknown>) {
  const result = await httpsCallable<Record<string, unknown>, {
    ok: true; companyId?: string; jobs?: IndependentJob[]; wbDrivers?: LinkedWellBuiltDriver[]; job?: IndependentJob;
  }>(getFirebaseFunctions(), 'staffIndependentDispatchJobs')(payload);
  return result.data;
}
