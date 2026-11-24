import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import type { IndependentSector } from './independentDispatchSectors';
import type { IndependentRouteGuide } from './independentRouteGuides';

export type IndependentCustomer = {
  id: string; name: string; phoneE164?: string; sectors: IndependentSector[]; jobNames: string[];
  alternateNames?: string[]; contacts?: IndependentCustomerContact[];
  workCategories?: IndependentCustomerCategory[];
  pickupLocations: string[]; deliveryLocations: string[]; active: true;
};
export type IndependentCustomerContact = { id: string; name: string; role: string; phoneE164: string };
export type IndependentCustomerCategory = {
  id: string; name: string; sector: IndependentSector; sourceChannels: string[]; assets: string[];
};
export type IndependentDirectory = {
  ok: true; companyId: string; sectors: IndependentSector[]; communicationChannels: ('sms' | 'whatsapp')[];
  dispatchPhoneE164: string;
  routeGuides?: IndependentRouteGuide[];
  customers: IndependentCustomer[];
};
export async function independentDispatchDirectory(payload: Record<string, unknown>): Promise<IndependentDirectory> {
  const response = await httpsCallable<Record<string, unknown>, IndependentDirectory>(
    getFirebaseFunctions(), 'staffIndependentDispatchDirectory')(payload);
  return response.data;
}
