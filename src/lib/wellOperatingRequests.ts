import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export type WellOperatingRequest = {
  id: string; companyId: string; wellConfigKey: string; driverName: string;
  down: boolean; requestedAt: string;
};
// Share an in-flight read between the bell and review page. No interval polling.
const pending = new Map<string, Promise<WellOperatingRequest[]>>();
export function listWellOperatingRequests(uid: string, companyId: string): Promise<WellOperatingRequest[]> {
  const scope = JSON.stringify([uid, companyId]);
  if (!pending.has(scope)) pending.set(scope, httpsCallable<{ action: string }, { items: WellOperatingRequest[] }>(
    getFirebaseFunctions(), 'reviewWellOperatingStatus')({ action: 'list' })
    .then(result => result.data.items.filter(row => row.companyId === companyId))
    .finally(() => { pending.delete(scope); }));
  return pending.get(scope)!;
}
