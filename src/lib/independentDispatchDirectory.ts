import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import type { IndependentSector } from './independentDispatchSectors';

export type IndependentCustomer = {
  id: string; name: string; phoneE164?: string; sectors: IndependentSector[]; jobNames: string[];
  pickupLocations: string[]; deliveryLocations: string[]; active: true;
};
export type IndependentDirectory = {
  ok: true; companyId: string; sectors: IndependentSector[]; customers: IndependentCustomer[];
};
export async function independentDispatchDirectory(payload: Record<string, unknown>): Promise<IndependentDirectory> {
  const response = await httpsCallable<Record<string, unknown>, IndependentDirectory>(
    getFirebaseFunctions(), 'staffIndependentDispatchDirectory')(payload);
  return response.data;
}
