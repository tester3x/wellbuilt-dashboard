import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import type { IndependentSector } from './independentDispatchSectors';
import type { IndependentRouteGuide } from './independentRouteGuides';
import type { NdicOperator, NdicWell } from './firestoreWells';

export type IndependentCustomer = {
  id: string; name: string; phoneE164?: string; sectors: IndependentSector[]; jobNames: string[];
  alternateNames?: string[]; contacts?: IndependentCustomerContact[];
  wellCatalogOperators?: string[];
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
  catalogOperators?: string[];
  routeGuides?: IndependentRouteGuide[];
  customers: IndependentCustomer[];
};
export async function independentDispatchDirectory(payload: Record<string, unknown>): Promise<IndependentDirectory> {
  const response = await httpsCallable<Record<string, unknown>, IndependentDirectory>(
    getFirebaseFunctions(), 'staffIndependentDispatchDirectory')(payload);
  return response.data;
}

export async function independentDispatchCatalog(): Promise<{ operators: NdicOperator[]; disposals: NdicWell[] }> {
  const response = await httpsCallable<{ op: string }, { operators: NdicOperator[]; disposals: NdicWell[] }>(
    getFirebaseFunctions(), 'staffIndependentDispatchDirectory')({ op: 'catalog' });
  return response.data;
}

export async function independentOperatorWells(operator: string): Promise<NdicWell[]> {
  const response = await httpsCallable<{ op: string; operator: string }, { wells: NdicWell[] }>(
    getFirebaseFunctions(), 'staffIndependentDispatchDirectory')({ op: 'operatorWells', operator });
  return response.data.wells;
}
