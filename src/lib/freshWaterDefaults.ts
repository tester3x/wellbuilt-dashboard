import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import { freshWaterAccount, type FreshWaterAccount } from './freshWater';

export async function loadFreshWaterDefaults(companyId: string) {
  const load = httpsCallable<
    { op: 'listDefaults'; companyId: string },
    { defaults: { operator: string; account: unknown }[] }
  >(getFirebaseFunctions(), 'staffFreshWaterPurchases');
  const { data } = await load({ op: 'listDefaults', companyId });
  const defaults = new Map<string, FreshWaterAccount>();
  for (const { operator, account } of data.defaults) {
    const value = freshWaterAccount(account);
    if (value) defaults.set(operator, value);
  }
  return defaults;
}

export async function saveFreshWaterDefault(companyId: string, operator: string, account: FreshWaterAccount | null) {
  const save = httpsCallable(getFirebaseFunctions(), 'staffFreshWaterPurchases');
  await save({ op: 'saveDefault', companyId, operator, account });
}
